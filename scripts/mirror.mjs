#!/usr/bin/env node
/**
 * 网盘镜像：把已发布的 zh_CN.lang 上传到夸克 / 百度网盘，并把分享链接写回 shaders.json。
 *
 * 设计原则：
 * 1. **wrapper，不改 CLI 本体** —— quark-drive.cjs 只做子进程调用，绝不修改其源码。
 * 2. **两个网盘互相独立** —— 任一失败只让该字段留空，不影响另一个，也不影响发布。
 * 3. **绝不伪造链接** —— 拿不到真实 share_url / link 就写空字符串，详情页因此不渲染该按钮。
 * 4. **逐条串行 + 限流** —— 避免触发网盘风控。
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
 *   BDPAN_REMOTE_DIR   百度网盘目标目录（相对 /apps/bdpan/），默认 shader-lang
 *   WORKER_URL + INTERNAL_STATUS_TOKEN  回写 KV 状态（可选）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
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
const BDPAN_REMOTE_DIR = process.env.BDPAN_REMOTE_DIR || 'shader-lang'

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
 * 执行一个 CLI 并解析其 JSONL 输出，返回最后一行的 JSON 对象。
 * CLI 输出多行（progress / list / result），只有 result 行带 code 与 data。
 */
function runCliJsonl(bin, cliArgs) {
  const stdout = execFileSync(bin, cliArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let result = null
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const obj = JSON.parse(t)
      if (obj && obj.type === 'result') result = obj
    } catch {
      /* 非 JSON 行忽略 */
    }
  }
  if (!result) throw new Error(`CLI 未输出 result 行：${stdout.slice(-300)}`)
  if (result.code !== 0) throw new Error(`CLI 返回 code ${result.code}: ${result.msg ?? ''}`)
  return result.data ?? {}
}

function quark(args) {
  if (!QUARK_CLI) throw new Error('未配置 QUARK_CLI')
  return runCliJsonl(process.execPath, [QUARK_CLI, ...args, '--session-input', SESSION_INPUT, '--session-id', SESSION_ID])
}

function bdpan(args) {
  return runCliJsonl('bdpan', [...args, '--json'])
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
 * 上传 lang 文件并创建永久公开分享链接。
 * @returns {Promise<string>} 分享链接；失败抛错
 */
async function mirrorToQuark(localPath, title) {
  const fid = await ensureQuarkDir()
  const up = quark(['upload', localPath, '--parent-fid', fid])
  const fileFid = (up.fids ?? [])[0]
  if (!fileFid) throw new Error(`upload 未返回 fids：${JSON.stringify(up).slice(0, 200)}`)

  // url-type 1 = 公开链接，expired-type 1 = 永久有效
  const sh = quark(['share', fileFid, '--title', title, '--url-type', '1', '--expired-type', '1'])
  if (!sh.share_url) throw new Error(`share 未返回 share_url：${JSON.stringify(sh).slice(0, 200)}`)
  return sh.share_url
}

// ---------- 百度 ----------

/**
 * 上传 lang 文件并创建永久分享链接。
 * 注意：bdpan 单文件上传的远端路径必须是文件名，禁止以 / 结尾。
 * @returns {Promise<string>} 分享链接；失败抛错
 */
async function mirrorToBaidu(localPath, remoteName) {
  const remotePath = `${BDPAN_REMOTE_DIR}/${remoteName}`
  bdpan(['upload', localPath, remotePath])

  // period 0 = 永久有效
  const sh = bdpan(['share', remotePath, '--period', '0'])
  const link = sh.link || sh.short_url
  if (!link) throw new Error(`share 未返回 link：${JSON.stringify(sh).slice(0, 200)}`)
  return link
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
  if (!IDS.length && s.quark && s.baidu) continue // 全量模式下跳过已双镜像的
  targets.push({ shader: s, lv })
}

if (!targets.length) {
  console.log('没有需要镜像的条目')
  process.exit(0)
}

console.log(`镜像 ${targets.length} 个光影（夸克: ${QUARK_CLI ? '启用' : '跳过'}，百度: ${hasBdpan() ? '启用' : '跳过'}）\n`)

function hasBdpan() {
  try {
    execFileSync('bdpan', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

let okBoth = 0, okPartial = 0, okNone = 0

for (const { shader, lv } of targets) {
  const label = `${shader.id} v${lv.shaderVersion}`
  const localPath = join(LANG_DIR, shader.id, lv.shaderVersion, 'zh_CN.lang')
  const remoteName = `${shader.id}-${lv.shaderVersion}-zh_CN.lang`
  const title = `${shader.id} ${lv.shaderVersion} 汉化`

  if (!existsSync(localPath)) {
    console.log(`[${label}] 找不到 ${localPath}，跳过`)
    continue
  }

  let quarkUrl = lv.quark || ''
  let baiduUrl = lv.baidu || ''

  if (QUARK_CLI && !quarkUrl) {
    try {
      quarkUrl = await mirrorToQuark(localPath, title)
      console.log(`[${label}] 夸克 ✓ ${quarkUrl}`)
    } catch (err) {
      console.log(`[${label}] 夸克 ✗ ${String(err.message).slice(0, 160)}`)
      quarkUrl = ''
    }
    await sleep(500)
  }

  if (hasBdpan() && !baiduUrl) {
    try {
      baiduUrl = await mirrorToBaidu(localPath, remoteName)
      console.log(`[${label}] 百度 ✓ ${baiduUrl}`)
    } catch (err) {
      console.log(`[${label}] 百度 ✗ ${String(err.message).slice(0, 160)}`)
      baiduUrl = ''
    }
    await sleep(500)
  }

  if (!quarkUrl && !baiduUrl) {
    okNone++
    console.log(`[${label}] 两个网盘都未成功，字段留空，状态标为「${STATUS.DONE_UNMIRRORED}」`)
    if (!dryRun) await reportStatus(shader.id, { status: STATUS.DONE_UNMIRRORED, quark: '', baidu: '' })
    continue
  }

  // 写回 shaders.json：顶层与 langVersions[0] 双写（详情页读顶层，langVersions 保持数据完整）
  if (!dryRun) {
    if (quarkUrl) { shader.quark = quarkUrl; lv.quark = quarkUrl }
    if (baiduUrl) { lv.baidu = baiduUrl; shader.baidu = baiduUrl }
    writeFileSync(SHADERS_FILE, JSON.stringify(db, null, 2) + '\n')
    await reportStatus(shader.id, { status: STATUS.DONE, quark: quarkUrl, baidu: baiduUrl })
  }

  if (quarkUrl && baiduUrl) okBoth++
  else okPartial++
}

if (dryRun) console.log('\n（--dry-run：未写入 shaders.json，未回写状态）')
console.log(`\n镜像结束：双网盘成功 ${okBoth}，部分成功 ${okPartial}，全部失败 ${okNone}`)
