#!/usr/bin/env node
/**
 * 批量筛选可翻候选：**不下载整包**，用 HTTP Range 读中央目录（+ 必要时读 en_US.lang 这一个条目），
 * 判断目录里哪些光影真的可翻。
 *
 * 为什么需要它：2026-10-20 实测，按下载量选 10 个热门未翻译光影，8 个自带中文、
 * 2 个无 en_US.lang、0 个真正可翻 —— 选目标时只看下载量，不知道包里有什么。
 * 这个脚本在「决定翻谁」之前先把包结构摸清楚，单包通常只花 64KB 级流量。
 *
 * 判定链（判据与流水线共用 lib/lang-source.mjs / lib/zip-probe.mjs）：
 *   有 zh_CN.lang → native-zh（跳过）
 *   无 en_US.lang → no-en（跳过）
 *   有 en_US.lang → 读这一个条目 → 可翻条目数 < 阈值 → too-small，否则 translatable
 *   任何异常 → probe-failed（只记这一条，不中断整批）
 *
 * 数据源（`--source`）：
 *   modrinth（默认）site/data/modrinth-catalog.json，版本取 Modrinth 最新版本接口的 file.size
 *   curseforge       site/data/curseforge-catalog.json，版本取 CF 文件列表的 fileLength；
 *                    `allowModDistribution === false` 的条目**提前排除**（下载必 403，探测无意义）
 *   all              两者都扫；CF 侧跳过「Modrinth 目录已有同名项目」的条目（同一光影不重复探测）
 *
 * 排序（`--order`）：
 *   desc（默认）从下载量最高的开始；asc 从最低/末尾开始（冷门包往往没被扫过）
 *
 * 只读：不写 site/data/*.json、不写 site/public/lang/、不碰 Cloudflare。
 *
 * 用法：
 *   node scripts/probe-candidates.mjs                              # Modrinth 下载量前 50 个
 *   node scripts/probe-candidates.mjs --limit 5                    # 只探前 5 个
 *   node scripts/probe-candidates.mjs --ids a,b,c                  # 只探指定 id / slug
 *   node scripts/probe-candidates.mjs --source curseforge --limit 3
 *   node scripts/probe-candidates.mjs --source all --order asc --limit 20
 *   node scripts/probe-candidates.mjs --out artifacts/candidates.json
 *   node scripts/probe-candidates.mjs --concurrency 3 --min-entries 20 --timeout 120
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { openZip } from '../shared/zip-range.mjs'
import {
  DEFAULT_MIN_EN_ENTRIES,
  ORDERS,
  PROBE_STATUS,
  fullModeReason,
  normalizeOrder,
  normSlug,
  runProbeCandidates,
  selectCandidates,
  selectCfCandidates,
  summarize,
} from './lib/probe-candidates.mjs'
import { cfGetDownloadUrl, cfGetFiles, resolveCfDownloadUrl } from './lib/cf-api.mjs'
import { cfVersionFromFileName } from './lib/cf.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG_FILE = join(ROOT, 'site/data/modrinth-catalog.json')
const CF_CATALOG_FILE = join(ROOT, 'site/data/curseforge-catalog.json')
const SHADERS_FILE = join(ROOT, 'site/data/shaders.json')
const MODRINTH_API = 'https://api.modrinth.com/v2'
const UA = 'shader-i18n-site/0.1.0 (probe-candidates)'

const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const SOURCES = ['modrinth', 'curseforge', 'all']
const SOURCE = String(argValue('--source', 'modrinth')).toLowerCase()
if (!SOURCES.includes(SOURCE)) {
  console.error(`--source 只能是 ${SOURCES.join(' | ')}，收到「${argValue('--source')}」`)
  process.exit(2)
}
const ORDER_RAW = argValue('--order', 'desc')
const ORDER = normalizeOrder(ORDER_RAW)
if (String(ORDER_RAW).toLowerCase() !== ORDER) {
  console.error(`--order 只能是 ${ORDERS.join(' | ')}，收到「${ORDER_RAW}」，按默认 ${ORDER} 处理`)
}
const LIMIT = Math.max(0, Number(argValue('--limit', 50)) || 0)
const IDS = String(argValue('--ids', ''))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const OUT = argValue('--out', null)
// 并发别开太高：Modrinth CDN 有限流，Range 请求本身很轻但请求数不少（每包 1~3 次）。
const CONCURRENCY = Math.max(1, Math.min(16, Number(argValue('--concurrency', 5)) || 5))
const MIN_ENTRIES = Math.max(0, Number(argValue('--min-entries', DEFAULT_MIN_EN_ENTRIES)) || 0)
// 单条超时：Range 请求通常秒级返回；卡住的多半是 CF 签名下载地址或 CDN 抖动。
const TIMEOUT_MS = Math.max(0, Number(argValue('--timeout', 120)) || 0) * 1000

const wantModrinth = SOURCE === 'modrinth' || SOURCE === 'all'
const wantCf = SOURCE === 'curseforge' || SOURCE === 'all'

const catalog = wantModrinth ? JSON.parse(readFileSync(CATALOG_FILE, 'utf8')) : { shaders: [] }
const db = JSON.parse(readFileSync(SHADERS_FILE, 'utf8'))
// CF 目录只在需要时读：`--source modrinth`（默认）保持与改造前完全一致，
// 不因为缺少 CF 目录文件而失败（测试里的最小仓库、只关心 Modrinth 的本地场景都是这种）。
const cfCatalog = (() => {
  if (!wantCf) return { mods: [] }
  try {
    return JSON.parse(readFileSync(CF_CATALOG_FILE, 'utf8'))
  } catch (err) {
    console.error(`读不到 CurseForge 目录 ${CF_CATALOG_FILE}：${err?.message ?? err}`)
    if (SOURCE === 'curseforge') process.exit(1)
    return { mods: [] }
  }
})()
const perSourceLimit = IDS.length ? IDS.length : LIMIT

// CF 侧要跳过「Modrinth 目录里已有同名项目」的条目：同一个光影在两边都扫一遍没有意义，
// 而且 Modrinth 侧的判定更权威（pipeline 的默认来源）。`--source curseforge` 单独扫描时
// 不排除 —— 用户明确只想看 CF。
const modrinthSlugSet = new Set(catalog.shaders.map((e) => normSlug(e.id)))
const cfExclude = SOURCE === 'all' ? modrinthSlugSet : new Set()

const modrinthItems = wantModrinth
  ? selectCandidates({ catalog, db, ids: IDS, limit: perSourceLimit, order: ORDER })
  : []
const cfItems = wantCf
  ? selectCfCandidates({ cfCatalog, db, ids: IDS, limit: perSourceLimit, order: ORDER, excludeIds: cfExclude })
  : []

// all 模式：两边各自按 order 排序后按下载量归并（保证整体仍是 asc/desc），再截断。
const items = (() => {
  if (SOURCE !== 'all') return [...modrinthItems, ...cfItems]
  const merged = [...modrinthItems, ...cfItems].sort((a, b) => {
    const diff = (a.downloads ?? 0) - (b.downloads ?? 0)
    const byDownloads = ORDER === 'asc' ? diff : -diff
    if (byDownloads !== 0) return byDownloads
    return String(a.id).localeCompare(String(b.id))
  })
  return merged.slice(0, IDS.length ? merged.length : LIMIT)
})()

if (!items.length) {
  console.error('没有可探测的候选（目录为空 / 已全部汉化 / 已排除禁止分发 / --ids 未命中）')
  process.exit(1)
}
const cfBlockedCount = (cfCatalog.mods ?? []).filter((m) => m?.allowModDistribution === false).length
const cfItemCount = items.filter((i) => i.source === 'curseforge').length
console.error(
  `探测 ${items.length} 个候选（source=${SOURCE}，order=${ORDER}，并发 ${CONCURRENCY}，可翻条目下限 ${MIN_ENTRIES}，` +
    `单条超时 ${TIMEOUT_MS ? `${TIMEOUT_MS / 1000}s` : '不限'}，只读 Range，不下载整包）` +
    (wantCf ? `；CF 已排除禁止分发 ${cfBlockedCount} 个，本次 CF 候选 ${cfItemCount} 个` : ''),
)

/** 取 Modrinth 最新版本的主文件。失败抛错，由 runProbeCandidates 收敛成 probe-failed。 */
async function getModrinthLatestFile(projectId) {
  const res = await fetch(`${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version`, {
    headers: { 'User-Agent': UA },
  })
  if (!res.ok) throw new Error(`Modrinth 版本接口 HTTP ${res.status}`)
  const versions = await res.json()
  const latest = Array.isArray(versions) ? versions[0] : null
  const file = latest?.files?.find((f) => f.primary) ?? latest?.files?.[0]
  if (!file) throw new Error('Modrinth 最新版本无可下载文件')
  return { url: file.url, size: file.size, version: latest.version_number, filename: file.filename }
}

/**
 * 取 CurseForge 最新候选文件（与 pipeline 的 processShaderCf 同一套排序：
 * release 优先，同类型内按 fileDate 倒序）。失败抛错，收敛成 probe-failed。
 * size 用文件列表里的 fileLength —— 没有它 openZip 只能整包下载，探测就没有收益。
 */
async function getCfLatestFile(cfId) {
  if (cfId == null) throw new Error('CurseForge 条目缺少 cfId')
  const files = await cfGetFiles(cfId, 50)
  if (!files.length) throw new Error('CurseForge 无任何可下载文件')
  const sorted = files.slice().sort((a, b) => {
    const aRelease = a.releaseType === 1 ? 0 : 1
    const bRelease = b.releaseType === 1 ? 0 : 1
    if (aRelease !== bRelease) return aRelease - bRelease
    return String(b.fileDate).localeCompare(String(a.fileDate))
  })
  const f = sorted[0]
  const raw = await cfGetDownloadUrl(cfId, f.id)
  if (!raw) throw new Error('CurseForge 未返回下载地址')
  // edge.forgecdn.net 带 Range 头会直接 404，必须解析成 mediafilez.forgecdn.net（见 cf-api.mjs）。
  const url = await resolveCfDownloadUrl(raw)
  return {
    url,
    size: Number.isFinite(f.fileLength) ? f.fileLength : undefined,
    version: cfVersionFromFileName(f.fileName, f.id),
    filename: f.fileName,
  }
}

let doneCount = 0
const rows = await runProbeCandidates({
  items,
  // runProbeCandidates 传 (projectId, item)：CF 条目没有 projectId，按 item.source 分派。
  getLatestFile: (projectId, item) =>
    item.source === 'curseforge' ? getCfLatestFile(item.cfId) : getModrinthLatestFile(projectId),
  openZip,
  concurrency: CONCURRENCY,
  headers: { 'User-Agent': UA },
  minEntries: MIN_ENTRIES,
  timeoutMs: TIMEOUT_MS,
  onRow: (row) => {
    doneCount++
    const extra = row.status === PROBE_STATUS.TRANSLATABLE ? `${row.enEntries} 条` : (row.error ?? '')
    // 进度走 stderr，stdout 只留最终 JSON（便于 `> file.json` 直接消费）。
    const reason = fullModeReason(row)
    const modeNote = reason === 'fallback' ? '  ⚠ 回退整包' : reason === 'below-threshold' ? '  （包小于 64KB，直接整包）' : ''
    console.error(`[${doneCount}/${items.length}] ${row.id}（${row.source}）→ ${row.status}${extra ? `（${extra}）` : ''}${modeNote}`)
  },
})

// 结果里带上 source：混扫时同一 id 可能两边都有，靠 source 区分。
const withSource = rows.map((row, i) => ({ ...row, source: items[i]?.source ?? 'modrinth' }))

const summary = summarize(withSource)
const output = {
  generatedAt: new Date().toISOString(),
  options: {
    source: SOURCE,
    order: ORDER,
    limit: LIMIT,
    ids: IDS,
    concurrency: CONCURRENCY,
    minEntries: MIN_ENTRIES,
    timeoutMs: TIMEOUT_MS,
  },
  summary,
  candidates: withSource,
}
const text = JSON.stringify(output, null, 2) + '\n'
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, text)
  console.error(`\n输出：${OUT}`)
} else {
  process.stdout.write(text)
}
console.error(
  `\n可翻 ${summary.byStatus.translatable}，自带中文 ${summary.byStatus['native-zh']}，` +
    `无 en_US ${summary.byStatus['no-en']}，条目过少 ${summary.byStatus['too-small']}，` +
    `探测失败 ${summary.byStatus['probe-failed']}；` +
    `下载 ${(summary.downloadedBytes / 1048576).toFixed(2)} MB / 整包需 ${(summary.packBytes / 1048576).toFixed(2)} MB` +
    `（节省 ${summary.savedPct}%），回退整包 ${summary.fallbackFull} 个，` +
    `包小于 64KB 直接整包 ${summary.belowThresholdFull} 个`,
)
