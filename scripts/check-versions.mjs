#!/usr/bin/env node
/**
 * 光影版本更新检测：找出「已有汉化但上游已发布新版本」的光影，输出待重翻清单。
 *
 * 原理：
 * - site/data/shaders.json 的 langVersions[0].shaderVersion 记录当前汉化对应的上游版本号
 * - Modrinth search 接口的 latest_version 是 8 字符版本 ID，且精确等于
 *   /project/{id}/version 返回的 versions[0].id —— 可当变更指纹：
 *   缓存中 latestVersionId 与本次相同 → 上游没有发新版，无需再拉版本列表
 * - 版本号一律取 versions[0].version_number（name 不可靠，作者会乱写）
 *
 * 用法：
 *   node scripts/check-versions.mjs                    # 全量检测
 *   node scripts/check-versions.mjs --limit 5          # 只处理前 5 个已翻译光影（调试；结果写入独立的 debug 文件，不覆盖正式全量结果）
 *   node scripts/check-versions.mjs --no-cache         # 忽略缓存，强制全量拉版本
 *   node scripts/check-versions.mjs --release-only     # 只比对最新 release（默认追最新，含 beta）
 *   node scripts/check-versions.mjs --json out.json    # 自定义结果 JSON 路径
 *
 * 结果分类（互斥）：
 *   unchanged   上游没有新版本
 *   needsUpdate 上游已发布新版本，需要重翻
 *   delisted    Modrinth 返回 404，项目已从上游删除（不是检测失败，但需要人工清理 shaders.json）
 *   failed      其余检测失败（网络错误、5xx、响应格式异常、版本列表为空等）——语义不变
 *
 * 退出码：failed 或 delisted 不为 0 时返回 1；仅存在待重翻是正常结果，仍返回 0。
 * 说明：delisted 单独归类、单独输出，不混进 failed；但它同样让退出码非 0，
 *       因为「已下架」意味着本地条目需要清理，绝不能当作绿灯放过。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHADERS_FILE = join(ROOT, 'site/data/shaders.json')
const CACHE_FILE = join(ROOT, 'site/data/version-cache.json')
const DEFAULT_RESULT_FILE = join(ROOT, 'site/data/version-check-result.json')
const MODRINTH_API = 'https://api.modrinth.com/v2'
const UA = 'shader-i18n-site/0.1.0 (version check)'
const PAGE_SIZE = 100
const SEARCH_CONCURRENCY = 3
const VERSION_CONCURRENCY = 10
// Modrinth 的速率限制约 300 req/min。节流必须是**全局**的：
// 早期版本把 sleep 放在每个 worker 内部，10 个 worker 各自睡 50ms，
// 实际速率是 10 × (1000/50) = 200 req/s ≈ 12000 req/min，远超限额，
// 全量跑必然在尾部撞 429。现在用一个全局令牌间隔把总速率钉在 ~4 req/s（240 req/min）。
const REQUEST_INTERVAL_MS = 250
const REQUEST_TIMEOUT_MS = 20000
const CACHE_COMMENT = '版本更新检测缓存：latestVersionId 为 Modrinth search 接口的 latest_version 字段'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const today = () => new Date().toISOString().slice(0, 10)

/**
 * 全局请求节流器：所有并发 worker 共享一个「下次允许发请求的时刻」，
 * 从而把**总体**速率限制在 1000/intervalMs 次/秒，而不是每个 worker 各限一次。
 * 同时最多只允许 maxConcurrent 个请求在飞行中。
 */
function createThrottle(intervalMs, maxConcurrent) {
  let nextSlot = 0
  let inFlight = 0
  const waiters = []

  const release = () => {
    inFlight--
    const next = waiters.shift()
    if (next) next()
  }

  return async function acquire() {
    if (inFlight >= maxConcurrent) {
      await new Promise((resolve) => waiters.push(resolve))
    }
    inFlight++
    const now = Date.now()
    const at = Math.max(now, nextSlot)
    nextSlot = at + intervalMs
    if (at > now) await sleep(at - now)
    return release
  }
}

/**
 * 带 HTTP 状态码的请求错误。
 * 只有 404 会被上层识别为「已下架 delisted」；其余状态码/网络错误仍是 failed。
 */
class HttpError extends Error {
  constructor(status, statusText, url) {
    super(`HTTP ${status} ${statusText}`)
    this.name = 'HttpError'
    this.status = status
    this.url = url
  }
}

// 全局节流：所有请求（search 分页 + 版本列表）都从这一个闸口走
const throttle = createThrottle(REQUEST_INTERVAL_MS, VERSION_CONCURRENCY)

// 拉 JSON：429/5xx 带退避重试；超时/网络错误同样重试，避免单个悬挂请求拖死整个并发池
async function getJSON(url, retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    // 先占一个全局配额；release() 只调用一次，且**不**在退避等待期间持有配额，
    // 否则限流时会把并发槽白白卡住。
    const release = await throttle()
    let retryDelayMs = 0
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (res.ok) return res.json()
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        // Retry-After 优先；没有就指数退避（429 往往是共享限额，退避要够长）
        retryDelayMs = (Number(res.headers.get('retry-after')) || 2 ** (attempt + 1)) * 1000
      } else {
        // 404 不重试：项目不存在，重试没有意义；由调用方归类为 delisted
        throw new HttpError(res.status, res.statusText, url)
      }
    } catch (err) {
      const retryable =
        err?.name === 'TimeoutError' ||
        err?.name === 'AbortError' ||
        err instanceof TypeError // fetch 网络层失败
      if (retryable && attempt < retries) {
        retryDelayMs = 2 * (attempt + 1) * 1000
      } else {
        throw err
      }
    } finally {
      release()
    }
    if (retryDelayMs) await sleep(retryDelayMs)
  }
  throw new Error('HTTP 请求失败')
}

// 小并发池：同时最多跑 limit 个任务，逐条取出队首执行；单条失败由调用方 try/catch 兜底
async function runPool(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

// 分页拉取 search 全量结果，返回 project_id -> hit 的 Map
async function fetchSearchIndex() {
  const facets = encodeURIComponent(JSON.stringify([['project_type:shader']]))
  const url = (offset) => `${MODRINTH_API}/search?facets=${facets}&limit=${PAGE_SIZE}&offset=${offset}`
  const first = await getJSON(url(0))
  if (!Array.isArray(first.hits)) throw new Error('search 返回格式异常')
  const pageCount = Math.ceil(first.total_hits / PAGE_SIZE)
  const hits = [...first.hits]
  if (pageCount > 1) {
    const offsets = Array.from({ length: pageCount - 1 }, (_, i) => (i + 1) * PAGE_SIZE)
    await runPool(offsets, SEARCH_CONCURRENCY, async (offset) => {
      const page = await getJSON(url(offset))
      hits.push(...page.hits)
    })
  }
  const byProjectId = new Map()
  for (const hit of hits) byProjectId.set(hit.project_id, hit)
  return { total: first.total_hits, pageCount, byProjectId }
}

// 检测单个已翻译光影；网络/解析失败时抛错，由调用方记入 failed
// hit 为 null 表示该 projectId 不在 search 索引中（已下架或未被索引），此时退化为
// 直接拉 /project/{id}/version，并用 versions[0].id 作为变更指纹。
async function checkShader(shader, hit, cacheEntry, noCache, releaseOnly, versionRequests) {
  const projectId = shader.modrinth.projectId
  const localVersion = shader.langVersions[0].shaderVersion
  const fingerprint = hit?.latest_version

  // 缓存命中：latestVersionId 未变 → 上游没有新版本，直接判无变化，不发 version 请求
  // releaseOnly 模式只信任由 --release-only 写入的缓存，避免复用默认模式（含 beta）的指纹
  const cacheModeOk = releaseOnly ? cacheEntry?.mode === 'release' : true
  if (!noCache && fingerprint && cacheEntry && cacheEntry.latestVersionId === fingerprint && cacheModeOk) {
    return {
      id: shader.id,
      projectId,
      status: 'unchanged',
      localVersion,
      upstreamVersion: cacheEntry.versionNumber ?? '',
      versionType: '',
      latestVersionId: fingerprint,
      cached: true,
    }
  }

  versionRequests.count++
  const versions = await getJSON(`${MODRINTH_API}/project/${projectId}/version`)
  if (!Array.isArray(versions) || versions.length === 0) throw new Error('version 列表为空')
  const chosen = releaseOnly
    ? versions.find((v) => v.version_type === 'release') ?? versions[0]
    : versions[0]
  const upstreamVersion = chosen?.version_number
  if (!upstreamVersion) throw new Error('最新版本缺少 version_number')
  const latestVersionId = fingerprint ?? versions[0]?.id ?? ''
  return {
    id: shader.id,
    projectId,
    status: upstreamVersion === localVersion ? 'unchanged' : 'needsUpdate',
    localVersion,
    upstreamVersion,
    versionType: chosen.version_type ?? '',
    latestVersionId,
    cached: !noCache && !!cacheEntry && cacheEntry.latestVersionId === latestVersionId && cacheModeOk,
  }
}

// 控制台对齐表格：rows[0] 为表头
function printTable(rows) {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)))
  for (const row of rows) {
    console.log('  ' + row.map((cell, c) => cell.padEnd(widths[c])).join('  ').trimEnd())
  }
}

async function main() {
  const args = process.argv.slice(2)
  const jsonArg = args.indexOf('--json')
  const limitArg = args.indexOf('--limit')
  const parsedLimit = limitArg >= 0 ? Number(args[limitArg + 1]) : NaN
  const LIMIT = Number.isFinite(parsedLimit) ? parsedLimit : Infinity
  const RESULT_FILE =
    LIMIT !== Infinity && jsonArg < 0
      ? join(ROOT, 'site/data/version-check-result.limit.json') // 调试用的 --limit 不覆盖正式结果
      : jsonArg >= 0 && args[jsonArg + 1]
        ? resolve(args[jsonArg + 1])
        : DEFAULT_RESULT_FILE
  const NO_CACHE = args.includes('--no-cache')
  const RELEASE_ONLY = args.includes('--release-only')

  // 1. 读取本地数据：已翻译光影 + 缓存（首次运行允许空对象 {}）
  if (!existsSync(SHADERS_FILE)) {
    console.error(`❌ 缺少 ${SHADERS_FILE}`)
    process.exit(1)
  }
  const db = JSON.parse(readFileSync(SHADERS_FILE, 'utf8'))
  const translated = db.shaders
    .filter((s) => s.langVersions?.length > 0 && s.modrinth?.projectId)
    .sort((a, b) => (b._meta?.modrinth?.downloads ?? 0) - (a._meta?.modrinth?.downloads ?? 0))
  const worklist = translated.slice(0, LIMIT)

  let cache = { $comment: CACHE_COMMENT, entries: {} }
  if (existsSync(CACHE_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
      cache = { $comment: CACHE_COMMENT, entries: raw.entries ?? {} }
    } catch {
      // 缓存损坏视为空，本次重新生成
    }
  }

  // 2. 拉取 search 全量索引（小并发池，不一次性 10 个 Promise.all）
  const startedAt = Date.now()
  console.log('🔎 拉取 Modrinth search 索引…')
  const { total, pageCount, byProjectId } = await fetchSearchIndex()
  console.log(`   共 ${total} 个光影，${pageCount} 页`)

  // 3. 逐个检测（版本请求并发 10，每条之间 sleep(50)）
  const summary = { total: worklist.length, unchanged: 0, needsUpdate: 0, delisted: 0, failed: 0 }
  const needsUpdate = []
  const delisted = []
  const failed = []
  const cacheUpdates = []
  const versionRequests = { count: 0 }

  await runPool(worklist, VERSION_CONCURRENCY, async (shader) => {
    const id = shader.id
    const projectId = shader.modrinth.projectId
    const hit = byProjectId.get(projectId)
    try {
      if (hit && !hit.latest_version) {
        throw new Error('search 结果缺少 latest_version')
      }
      // hit 为 null（不在 search 索引）时走 checkShader 退化分支：直接拉版本列表
      const result = await checkShader(shader, hit ?? null, cache.entries[id], NO_CACHE, RELEASE_ONLY, versionRequests)
      if (result.status === 'needsUpdate') {
        summary.needsUpdate++
        needsUpdate.push({
          id: result.id,
          projectId: result.projectId,
          currentVersion: result.localVersion,
          latestVersion: result.upstreamVersion,
          versionType: result.versionType,
        })
      } else {
        summary.unchanged++
      }
      cacheUpdates.push({
        id,
        projectId,
        latestVersionId: result.latestVersionId,
        upstreamVersion: result.upstreamVersion,
      })
    } catch (err) {
      // 404 = 上游项目已删除。单独归类，不混进 failed；其余错误语义不变。
      if (err instanceof HttpError && err.status === 404) {
        summary.delisted++
        delisted.push({ id, projectId, reason: err.message })
      } else {
        summary.failed++
        failed.push({ id, projectId, reason: err.message })
      }
    }
  })
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)

  // 4. 写回缓存（失败与已下架条目不写，下次运行会重试/重新确认）
  for (const u of cacheUpdates) {
    cache.entries[u.id] = {
      projectId: u.projectId,
      latestVersionId: u.latestVersionId,
      versionNumber: u.upstreamVersion,
      mode: RELEASE_ONLY ? 'release' : 'latest',
      checkedAt: today(),
    }
  }
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n')

  // 5. 写出结果 JSON
  const result = {
    $comment: '光影版本更新检测结果：needsUpdate 为本次新发现的待重翻清单，可交由 pipeline.mjs 重新翻译',
    generatedAt: today(),
    summary: {
      total: summary.total,
      unchanged: summary.unchanged,
      needsUpdate: summary.needsUpdate,
      delisted: summary.delisted,
      failed: summary.failed,
    },
    needsUpdate,
    delisted,
    failed,
  }
  mkdirSync(dirname(RESULT_FILE), { recursive: true })
  writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2) + '\n')

  // 6. 控制台输出
  console.log('\n════════════════════════════════════════════')
  console.log('  光影版本更新检测结果')
  console.log('════════════════════════════════════════════')
  console.log(`  已处理      ${summary.total} 个已翻译光影`)
  console.log(`  无变化      ${summary.unchanged}`)
  console.log(`  待重翻      ${summary.needsUpdate}`)
  console.log(`  已下架      ${summary.delisted}（Modrinth 404，需人工从 shaders.json 清理）`)
  console.log(`  检测失败    ${summary.failed}`)
  console.log(`  耗时        ${elapsedSec}s（版本请求 ${versionRequests.count} 次）`)
  console.log('  ※ 待重翻仅统计「自上次检测以来新出现的版本变化」')

  if (needsUpdate.length > 0) {
    console.log('\n  待重翻清单:')
    printTable([
      ['id', '当前版本', '上游最新', '类型'],
      ...needsUpdate.map((n) => [n.id, n.currentVersion, n.latestVersion, n.versionType]),
    ])
  } else {
    console.log('\n  待重翻清单:（无）')
  }

  if (delisted.length > 0) {
    console.log('\n  已下架 delisted（Modrinth 项目已删除，请从 site/data/shaders.json 移除对应条目）:')
    printTable([
      ['id', 'projectId', '原因'],
      ...delisted.map((d) => [d.id, d.projectId, d.reason]),
    ])
  }

  if (failed.length > 0) {
    console.log('\n  检测失败:')
    printTable([
      ['id', 'projectId', '原因'],
      ...failed.map((f) => [f.id, f.projectId, f.reason]),
    ])
  }

  console.log(`\n  📄 结果已写入 ${RESULT_FILE}`)
  console.log(`  💾 缓存已写入 ${CACHE_FILE}`)
  console.log('════════════════════════════════════════════\n')

  // 有待重翻是正常结果（返回 0）；检测失败或存在已下架条目才返回非 0。
  // delisted 单独归类但不降级为绿灯：它意味着本地数据需要人工清理。
  process.exitCode = summary.failed > 0 || summary.delisted > 0 ? 1 : 0
}

main().catch((err) => {
  console.error('❌ 检测脚本出错:', err)
  process.exit(1)
})