#!/usr/bin/env node
/**
 * 网盘镜像：把已发布的 zh_CN.lang 上传到夸克网盘，并把分享链接写回 shaders.json。
 *
 * 设计原则：
 * 1. **wrapper，不改 CLI 本体** —— quark-drive.cjs 只做子进程调用，绝不修改其源码。
 * 2. **绝不伪造链接** —— 拿不到真实 share_url 就写空字符串，详情页因此不渲染该按钮。
 * 3. **逐条串行 + 限流** —— 避免触发网盘风控。
 *
 * 用法：
 *   node scripts/mirror.mjs --ids a,b,c   只处理指定 shaderId
 *   node scripts/mirror.mjs               处理全部「最新版本尚无镜像链接」的光影
 *   node scripts/mirror.mjs --ids a,b --dry-run
 *
 * 环境变量：
 *   QUARK_CLI          quark-drive.cjs 路径（缺失则跳过夸克）
 *   QUARK_PARENT_FID   上传目标目录的父目录 FID（可选；缺失时由 CLI 内部决定）
 *   QUARK_DIR_NAME     目标目录名，默认「光影汉化」（同名幂等，自动复用已有目录）
 *   WORKER_URL + INTERNAL_STATUS_TOKEN  回写 KV 状态（可选）
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { STATUS } from '../shared/tencent-docs.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHADERS_FILE = join(ROOT, 'site/data/shaders.json')
const LANG_DIR = join(ROOT, 'site/public/lang')

const WORKER_URL = process.env.WORKER_URL
const INTERNAL_STATUS_TOKEN = process.env.INTERNAL_STATUS_TOKEN
const QUARK_CLI = process.env.QUARK_CLI
const QUARK_PARENT_FID = process.env.QUARK_PARENT_FID
const QUARK_DIR_NAME = process.env.QUARK_DIR_NAME || '光影汉化'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const idsArg = args.indexOf('--ids')
const IDS = idsArg >= 0 ? (args[idsArg + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : []

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 本次会话的追踪参数（CLI 要求；不参与业务逻辑）。 */
const SESSION_ID = `${Math.floor(Date.now() / 1000)}-${Math.random().toString(16).slice(2, 8)}`
const SESSION_INPUT = '批量镜像光影汉化语言文件到网盘并生成分享链接'

// ---------- CLI 调用 ----------

/**
 * 执行一个 CLI 并解析其 JSONL 输出，返回 result 与所有 list/progress 行。
 */
function runCliJsonlAll(bin, cliArgs) {
  const stdout = execFileSync(bin, cliArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let result = null
  const lines = []
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const obj = JSON.parse(t)
      if (obj && obj.type === 'result') result = obj
      else if (obj && (obj.type === 'list' || obj.type === 'progress')) lines.push(obj)
    } catch {
      /* 非 JSON 行忽略 */
    }
  }
  if (!result) throw new Error(`CLI 未输出 result 行：${stdout.slice(-300)}`)
  if (result.code !== 0) throw new Error(`CLI 返回 code ${result.code}: ${result.msg ?? ''}`)
  return { result: result.data ?? {}, lines }
}

function quarkAll(args) {
  if (!QUARK_CLI) throw new Error('未配置 QUARK_CLI')
  return runCliJsonlAll(process.execPath, [QUARK_CLI, ...args, '--session-input', SESSION_INPUT, '--session-id', SESSION_ID])
}

function quark(args) {
  return quarkAll(args).result
}

// ---------- 夸克 ----------

/** 幂等地取得「光影汉化」目录 FID。 */
let quarkDirFid = null
async function ensureQuarkDir() {
  if (quarkDirFid) return quarkDirFid
  const a = ['create-folder', '--dir-path', QUARK_DIR_NAME]
  if (QUARK_PARENT_FID) a.push('--parent-fid', QUARK_PARENT_FID)
  const data = quark(a)
  if (!data.fid) throw new Error(`create-folder 未返回 fid：${JSON.stringify(data).slice(0, 200)}`)
  quarkDirFid = data.fid
  console.log(`  [夸克] 目录「${QUARK_DIR_NAME}」fid=${quarkDirFid}`)
  return quarkDirFid
}

/**
 * 为已上传的文件创建永久公开分享链接。
 * @returns {Promise<string>} 分享链接；失败抛错
 */
async function shareQuark(fileFid, title) {
  // url-type 1 = 公开链接，expired-type 1 = 永久有效
  const sh = quark(['share', fileFid, '--title', title, '--url-type', '1', '--expired-type', '1'])
  if (!sh.share_url) throw new Error(`share 未返回 share_url：${JSON.stringify(sh).slice(0, 200)}`)
  return sh.share_url
}

/**
 * 上传 lang 文件并创建永久公开分享链接。
 * @returns {Promise<string>} 分享链接；失败抛错
 */
async function mirrorToQuark(localPath, title) {
  const fid = await ensureQuarkDir()
  const up = quark(['upload', localPath, '--parent-fid', fid])
  const fileFid = (up.fids ?? [])[0]
  if (!fileFid) throw new Error(`upload 未返回 fids：${JSON.stringify(up).slice(0, 200)}`)
  return shareQuark(fileFid, title)
}

/**
 * 把一批 lang 文件放进同一个暂存目录，一次上传整个目录。
 * 返回 Map<shaderId, fileFid>。失败时抛错，由调用方回退逐条上传。
 */
async function batchUploadToQuark(targets) {
  const parentFid = await ensureQuarkDir()
  const staging = mkdtempSync(join(tmpdir(), 'quark-lang-batch-'))
  const ordered = []
  try {
    for (const target of targets) {
      const { shader, lv, localPath } = target
      const rel = join(shader.id, lv.shaderVersion, 'zh_CN.lang')
      const dest = join(staging, rel)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(localPath, dest)
      ordered.push({ shaderId: shader.id, rel })
    }
    const { result } = quarkAll(['upload', staging, '--parent-fid', parentFid])
    const fids = result.fids ?? []
    if (fids.length !== ordered.length) {
      throw new Error(`批量上传 FID 数量不一致：期望 ${ordered.length}，实际 ${fids.length}`)
    }
    return new Map(ordered.map((item, index) => [item.shaderId, fids[index]]))
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

// ---------- 状态回写 ----------

async function reportStatus(id, payload) {
  if (!WORKER_URL || !INTERNAL_STATUS_TOKEN) return
  try {
    await fetch(`${WORKER_URL.replace(/\/+$/, '')}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_STATUS_TOKEN },
      body: JSON.stringify({ id, ...payload }),
    })
  } catch (err) {
    console.log(`  [status] 回写异常: ${String(err.message).slice(0, 120)}`)
  }
}

// ---------- 主流程 ----------

const db = JSON.parse(readFileSync(SHADERS_FILE, 'utf8'))

/** 待镜像条目：取每条光影的最新 langVersion（数组首位）。 */
const targets = []
for (const s of db.shaders) {
  const lv = (s.langVersions ?? [])[0]
  if (!lv) continue
  if (IDS.length && !IDS.includes(s.id)) continue
  // 全量模式下只跳过「本版本已有分享链接」的条目。
  // 不能判 s.quark：顶层链接指向的是「最新版本」的分享，发布新翻译版本后它仍留在旧版本上，
  // 于是「新版本缺链接」这一最常见形态会被静默跳过。
  if (!IDS.length && lv.quark) continue
  targets.push({ shader: s, lv })
}

if (!targets.length) {
  console.log('没有需要镜像的条目')
  process.exit(0)
}

console.log(`镜像 ${targets.length} 个光影（夸克: ${QUARK_CLI ? '启用' : '跳过'}）\n`)

let okQuark = 0, okNone = 0
// 夸克「尝试」与「成功」计数。
// CI 里登录态过期会表现为每条上传/分享都抛错，而下面的逐条 catch 只打印并把 quark 置空，
// 整进程仍然 exit 0 —— 那就是「绿色通过但零链接」的静默失败。故必须单独计数并在收尾时暴露。
let attemptedQuark = 0, succeededQuark = 0

const batchTargets = targets
  .map(({ shader, lv }) => ({ shader, lv, localPath: join(LANG_DIR, shader.id, lv.shaderVersion, 'zh_CN.lang') }))
  .filter((target) => !(target.lv.quark || target.shader.quark) && existsSync(target.localPath))

let uploadedFids = new Map()
if (QUARK_CLI && batchTargets.length > 1) {
  try {
    console.log(`  [夸克] 批量上传 ${batchTargets.length} 个文件…`)
    uploadedFids = await batchUploadToQuark(batchTargets)
    console.log(`  [夸克] 批量上传完成，开始生成分享链接`)
  } catch (err) {
    console.log(`  [夸克] 批量上传失败，回退逐条上传：${String(err.message).slice(0, 160)}`)
    uploadedFids = new Map()
  }
}

for (const { shader, lv } of targets) {
  const label = `${shader.id} v${lv.shaderVersion}`
  const localPath = join(LANG_DIR, shader.id, lv.shaderVersion, 'zh_CN.lang')
  const title = `${shader.id} ${lv.shaderVersion} 汉化`

  if (!existsSync(localPath)) {
    console.log(`[${label}] 找不到 ${localPath}，跳过`)
    continue
  }

  let quarkUrl = lv.quark || ''

  if (QUARK_CLI && !quarkUrl) {
    attemptedQuark++
    try {
      const uploadedFid = uploadedFids.get(shader.id)
      quarkUrl = uploadedFid
        ? await shareQuark(uploadedFid, title)
        : await mirrorToQuark(localPath, title)
      succeededQuark++
      console.log(`[${label}] 夸克 ✓ ${quarkUrl}`)
    } catch (err) {
      console.log(`[${label}] 夸克 ✗ ${String(err.message).slice(0, 160)}`)
      quarkUrl = ''
    }
    await sleep(300)
  }

  if (!quarkUrl) {
    okNone++
    console.log(`[${label}] 夸克镜像未成功，字段留空，状态标为「${STATUS.DONE_UNMIRRORED}」`)
    if (!dryRun) await reportStatus(shader.id, { status: STATUS.DONE_UNMIRRORED, quark: '' })
    continue
  }

  // 写回 shaders.json：顶层与 langVersions[0] 双写（详情页读顶层，langVersions 保持数据完整）
  if (!dryRun) {
    shader.quark = quarkUrl
    lv.quark = quarkUrl
    writeFileSync(SHADERS_FILE, JSON.stringify(db, null, 2) + '\n')
    await reportStatus(shader.id, { status: STATUS.DONE, quark: quarkUrl })
  }

  okQuark++
}

if (dryRun) console.log('\n（--dry-run：未写入 shaders.json，未回写状态）')
console.log(`\n镜像结束：夸克成功 ${okQuark}，未镜像 ${okNone}`)

// 零产出不能静默：尝试过上传/分享却一条都没成功，几乎总是登录态失效（QUARK_CONFIG_JSON 过期）
// 或 CLI 环境异常。CI 必须变红，否则会「绿色通过但零链接」。
if (attemptedQuark > 0 && succeededQuark === 0) {
  console.log(`::error::夸克镜像全部失败：尝试 ${attemptedQuark} 条，成功 0 条。常见原因：登录态过期/失效（QUARK_CONFIG_JSON）或 CLI 环境异常。置退出码 1，让 CI 变红。`)
  process.exitCode = 1
} else if (succeededQuark > 0 && attemptedQuark > succeededQuark) {
  // 部分成功仍有价值（已拿到的链接已写回 shaders.json），不置红，但必须让人看见。
  console.log(`::warning::夸克镜像部分失败：成功 ${succeededQuark} 条，失败 ${attemptedQuark - succeededQuark} 条（共尝试 ${attemptedQuark} 条）。已成功的链接已写入，本轮不置红。`)
}
