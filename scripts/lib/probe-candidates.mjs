#!/usr/bin/env node
/**
 * 批量筛选的**纯逻辑层**（无 IO、无网络）：从 Modrinth 目录里挑出「值得翻」的包。
 *
 * 背景：2026-10-20 实测，按下载量取 10 个热门未翻译光影，8 个自带中文、2 个无 en_US.lang，
 * 0 个真正可翻 —— 因为选目标时只看下载量，不知道包里有什么。
 * 本模块把「怎么筛」变成可离线单测的纯函数，CLI 胶水在 scripts/probe-candidates.mjs。
 *
 * 判定链（与流水线共用同一份判据，见 lib/zip-probe.mjs 与 lib/lang-source.mjs）：
 *   中央目录 → 有 zh_CN.lang = native-zh / 无 en_US.lang = no-en
 *             → 有 en_US.lang 才读这一个条目 → 可翻条目数低于阈值 = too-small / 否则 translatable
 * 任何异常 → probe-failed（只记这一条，不中断整批）。
 */

import { PROBE_VERDICT, classifyLangNames } from './zip-probe.mjs'
import { isApiDownloadBlocked } from './cf.mjs'

/**
 * openZip 的 Range 阈值：小于它直接整包（见 shared/zip-range.mjs 的 minRangeBytes 默认值）。
 * 这里复制常量而不是从 zip-range 导入，是为了让「为什么这个包是 full」的判定留在本模块；
 * 若将来 openZip 改默认值，tests/probe-candidates.test.mjs 会对着实际行为报警。
 */
export const RANGE_MIN_BYTES = 65536

/** 单条探测结论。 */
export const PROBE_STATUS = Object.freeze({
  /** 有 en_US.lang 且条目数达标 → 可翻 */
  TRANSLATABLE: 'translatable',
  /** 包内自带 zh_CN.lang */
  NATIVE_ZH: 'native-zh',
  /** 包内没有 en_US.lang（也没有 zh_CN.lang） */
  NO_EN: 'no-en',
  /** 有 en_US.lang 但可翻条目太少，不值得开一条翻译 */
  TOO_SMALL: 'too-small',
  /** 探测失败（网络 / 超时 / zip 结构异常 / 元数据缺失） */
  PROBE_FAILED: 'probe-failed',
})

/**
 * 可翻条目的下限（含）。低于这个数视为「没什么可翻」。
 * 口径是**可翻译条目数**（非空、非注释、`键=值`），与流水线 translateFromZip 的 pairs 同口径；
 * 不是文件原始行数 —— 一个 200 行的文件可能只有 3 条真实条目。
 */
export const DEFAULT_MIN_EN_ENTRIES = 10

/**
 * 统计 en_US.lang 的内容量。`lines` 是原始行数（含注释与空行），`entries` 是
 * 与流水线完全同口径的可翻译条目数。
 *
 * @param {string} text
 * @returns {{ lines: number, entries: number }}
 */
export function countLangEntries(text) {
  const str = typeof text === 'string' ? text : ''
  let entries = 0
  for (const line of str.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    if (t.indexOf('=') <= 0) continue
    entries++
  }
  // 文件以换行结尾时 split 会多出一个空串，不算一行。
  const rawLines = str === '' ? 0 : str.split('\n').length - (str.endsWith('\n') ? 1 : 0)
  return { lines: rawLines, entries }
}

/** 归一化 slug：与站点/详情页判定 CF 独占条目时同一口径（小写、去分隔符）。 */
export const normSlug = (s) => String(s ?? '').trim().toLowerCase().replace(/[-_\s]+/g, '')

/** 扫描顺序：默认从高到低（与历史行为一致）；`asc` 从末尾/最低下载量开始。 */
export const ORDERS = Object.freeze(['desc', 'asc'])

/** 归一化排序参数：非法值回落到默认 `desc`，避免拼错参数导致行为静默改变。 */
export function normalizeOrder(order) {
  const v = String(order ?? '').toLowerCase()
  return ORDERS.includes(v) ? v : 'desc'
}

/** 按下载量排序 + 截断。同下载量按 id 升序，保证输出稳定（便于 diff 两次探测结果）。 */
function sortAndLimit(list, limit, order) {
  const sorted = list.slice().sort((a, b) => {
    const diff = (a.downloads ?? 0) - (b.downloads ?? 0)
    const byDownloads = order === 'asc' ? diff : -diff
    if (byDownloads !== 0) return byDownloads
    return String(a.id).localeCompare(String(b.id))
  })
  return sorted.slice(0, Math.max(0, limit))
}

/** shaders.json 里已有汉化的 id 集合（Modrinth id 与 CF slug 都存在这个集合里）。 */
function translatedIds(db) {
  const set = new Set()
  for (const s of db?.shaders ?? []) {
    if ((s.langVersions?.length ?? 0) > 0) {
      if (s.id) set.add(s.id)
      if (s.curseforge?.slug) set.add(s.curseforge.slug)
    }
  }
  return set
}

/**
 * 从 Modrinth 目录 + 已汉化库里挑出待探测条目。
 *
 * 排除规则（只排两类，理由都写在这里）：
 * 1. 已有本站汉化（shaders.json 里 langVersions 非空）—— 不需要再翻；
 * 2. 目录里已知自带中文（hasNativeZhCN === true）—— 翻不了。
 *
 * **不排除** noEnUsLang：那是上一版包的结论，新版本很可能补了 en_US.lang，
 * 而探测本身很便宜 —— 这正是本脚本要重新验证的东西。
 *
 * @param {object} opts
 * @param {{shaders: Array<object>}} opts.catalog site/data/modrinth-catalog.json
 * @param {{shaders: Array<object>}} opts.db site/data/shaders.json
 * @param {string[]} [opts.ids] 只探测这些 id（为空则全目录）
 * @param {number} [opts.limit=50] 最多返回多少条
 * @param {'desc'|'asc'} [opts.order='desc'] 下载量排序方向
 * @returns {Array<{id:string, title:string, downloads:number, projectId:string, source:'modrinth'}>}
 */
export function selectCandidates({ catalog, db, ids = [], limit = 50, order = 'desc' }) {
  const translated = translatedIds(db)
  const wanted = ids.length ? new Set(ids) : null
  const list = (catalog?.shaders ?? []).filter((e) => {
    if (e.hasNativeZhCN === true) return false
    if (translated.has(e.id)) return false
    if (wanted && !wanted.has(e.id)) return false
    return true
  })
  return sortAndLimit(list, limit, normalizeOrder(order)).map((e) => ({
    id: e.id,
    title: e.title ?? e.id,
    downloads: e.downloads ?? 0,
    projectId: e.projectId ?? e.id,
    source: 'modrinth',
  }))
}

/**
 * 从 CurseForge 目录挑出待探测条目。
 *
 * 排除规则：
 * 1. `allowModDistribution === false` —— 作者禁止 API 分发，下载接口一律 403，
 *    探测必然失败且毫无信息量（当前目录里 275 条）。**必须提前排掉**，否则会把
 *    探测额度全花在这些条目上。
 * 2. 已有本站汉化（按 shaders.json 的 id / curseforge.slug 匹配）—— 不需要再翻。
 * 3. `excludeIds`：调用方给的归一化 slug 集合。`--source all` 时用它去掉「Modrinth 目录里
 *    已有同名项目」的 CF 条目，避免同一个光影被探两遍。
 *
 * 与 Modrinth 侧一致：**不排除**已带 noEnUsLang 的条目（旧结论可能过期）。
 *
 * @param {object} opts
 * @param {{mods: Array<object>}} opts.cfCatalog site/data/curseforge-catalog.json
 * @param {{shaders: Array<object>}} opts.db site/data/shaders.json
 * @param {string[]} [opts.ids] 只探测这些 slug
 * @param {number} [opts.limit=50]
 * @param {'desc'|'asc'} [opts.order='desc']
 * @param {Set<string>} [opts.excludeIds] 归一化 slug 集合（跳过）
 * @returns {Array<{id:string, title:string, downloads:number, cfId:number, slug:string, source:'curseforge'}>}
 */
export function selectCfCandidates({ cfCatalog, db, ids = [], limit = 50, order = 'desc', excludeIds = new Set() }) {
  const translated = translatedIds(db)
  const translatedCfIds = new Set()
  for (const s of db?.shaders ?? []) {
    if ((s.langVersions?.length ?? 0) > 0 && s.curseforge?.cfId != null) translatedCfIds.add(String(s.curseforge.cfId))
  }
  const wanted = ids.length ? new Set(ids) : null
  const list = (cfCatalog?.mods ?? []).filter((m) => {
    if (!m?.slug) return false
    if (isApiDownloadBlocked(m)) return false
    if (translated.has(m.slug)) return false
    if (m.cfId != null && translatedCfIds.has(String(m.cfId))) return false
    if (excludeIds.has(normSlug(m.slug))) return false
    if (wanted && !wanted.has(m.slug)) return false
    return true
  })
  return sortAndLimit(list, limit, normalizeOrder(order)).map((m) => ({
    id: m.slug,
    title: m.name ?? m.slug,
    downloads: m.downloads ?? 0,
    cfId: m.cfId,
    slug: m.slug,
    source: 'curseforge',
  }))
}

/**
 * 探测单个包：只读中央目录，必要时再读 en_US.lang 这一个条目。
 *
 * @param {object} opts
 * @param {(url: string, opts: object) => Promise<object>} opts.openZip shared/zip-range.mjs 的实现
 * @param {string} opts.url
 * @param {number} [opts.totalSize]
 * @param {object} [opts.headers]
 * @param {number} [opts.minEntries=DEFAULT_MIN_EN_ENTRIES]
 * @param {AbortSignal} [opts.signal] 中断信号（与流水线 CF 分支同一条链路）
 * @returns {Promise<{status:string, fetchMode?:string, downloadedBytes?:number, packBytes?:number,
 *   enLines?:number, enEntries?:number, enName?:string|null, langNames?:string[], error?:string}>}
 */
export async function probeOne({ openZip, url, totalSize, headers, minEntries = DEFAULT_MIN_EN_ENTRIES, signal }) {
  try {
    const zip = await openZip(url, { totalSize, headers, signal })
    const { verdict, langNames, enName } = classifyLangNames(zip.names)
    const base = {
      langNames,
      // fetchMode 在 read() 里也可能从 range 升级成 full，所以两个时机都读，最后取一次。
      fetchMode: zip.fetchMode,
      downloadedBytes: zip.bytesDownloaded,
      packBytes: Number.isFinite(totalSize) ? totalSize : undefined,
      enName: enName ?? null,
    }
    if (verdict === PROBE_VERDICT.NATIVE_ZH) return { ...base, status: PROBE_STATUS.NATIVE_ZH }
    if (verdict === PROBE_VERDICT.NO_EN_US) return { ...base, status: PROBE_STATUS.NO_EN }

    // 走到这里只可能是 NEEDS_TRANSLATION（有 en_US.lang）
    const buf = await zip.read(enName)
    const after = {
      fetchMode: zip.fetchMode,
      downloadedBytes: zip.bytesDownloaded,
    }
    if (!buf) {
      // 中央目录说有、实际读不到：这是探测失败，不是「没英文源」。
      return { ...base, ...after, status: PROBE_STATUS.PROBE_FAILED, error: `读不到条目 ${enName}` }
    }
    const { lines, entries } = countLangEntries(buf.toString('utf8'))
    return {
      ...base,
      ...after,
      enLines: lines,
      enEntries: entries,
      status: entries < minEntries ? PROBE_STATUS.TOO_SMALL : PROBE_STATUS.TRANSLATABLE,
    }
  } catch (err) {
    return { status: PROBE_STATUS.PROBE_FAILED, error: String(err?.message ?? err).slice(0, 300) }
  }
}

/**
 * 并发跑一批候选。单条失败只影响这一条（probeOne 内部已收敛为 probe-failed）。
 *
 * @param {object} opts
 * @param {Array<{id:string,title:string,downloads:number,projectId:string}>} opts.items
 * @param {(projectId: string, item: object) => Promise<{url:string, size?:number, version?:string, filename?:string}>} opts.getLatestFile
 *   第一个参数是 `item.projectId`（CF 条目没有 projectId，此时是 `undefined`）；
 *   第二个参数是完整条目，需要按来源分派时用它（见 scripts/probe-candidates.mjs）。
 * @param {(url: string, opts: object) => Promise<object>} opts.openZip
 * @param {number} [opts.concurrency=5]
 * @param {object} [opts.headers]
 * @param {number} [opts.minEntries]
 * @param {number} [opts.timeoutMs=0] 单条总超时（0 = 不限）。CF 下载地址是时效性签名链接，
 *   卡住的那一条不该拖住整批。
 * @param {(row: object) => void} [opts.onRow] 每完成一条回调（CLI 用来打印进度）
 * @returns {Promise<Array<object>>} 与 items 同序的结果行
 */
export async function runProbeCandidates({
  items,
  getLatestFile,
  openZip,
  concurrency = 5,
  headers,
  minEntries = DEFAULT_MIN_EN_ENTRIES,
  timeoutMs = 0,
  onRow,
}) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      const item = items[i]
      const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
      let row
      try {
        const file = await getLatestFile(item.projectId, item)
        if (!file?.url) throw new Error('最新版本无可下载文件')
        const probed = await probeOne({ openZip, url: file.url, totalSize: file.size, headers, minEntries, signal })
        row = {
          id: item.id,
          title: item.title,
          downloads: item.downloads,
          // Modrinth 条目带 projectId，CF 条目带 cfId/slug（source 用来区分两边）。
          projectId: item.projectId,
          ...(item.source === 'curseforge' ? { cfId: item.cfId, source: 'curseforge' } : { source: 'modrinth' }),
          shaderVersion: file.version,
          sourceFile: file.filename,
          ...probed,
          // 输出里直接写清「为什么是 full」：below-threshold 是设计行为，fallback 才需要排查。
          fullReason: fullModeReason(probed),
        }
      } catch (err) {
        row = {
          id: item.id,
          title: item.title,
          downloads: item.downloads,
          projectId: item.projectId,
          ...(item.source === 'curseforge' ? { cfId: item.cfId, source: 'curseforge' } : { source: 'modrinth' }),
          status: PROBE_STATUS.PROBE_FAILED,
          error: String(err?.message ?? err).slice(0, 300),
        }
      }
      results[i] = row
      if (typeof onRow === 'function') onRow(row)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 这个包为什么是 full 模式？两种完全不同的原因必须分开统计，否则会误报回退率：
 * - `below-threshold`：包本身就小于 Range 阈值（<64KB），openZip **按设计**直接整包。
 *   这不是失败，字节数也几乎没有浪费 —— 整包本来就这么大。
 * - `fallback`：本可走 Range，却因服务器不支持 / CRC 不符 / zip64 等**回退**整包。
 *   这才是「本来说好只读 64KB 结果下了整包」的观测对象。
 *
 * @param {{fetchMode?: string, packBytes?: number}} row
 * @returns {'range'|'below-threshold'|'fallback'|'unknown'}
 */
export function fullModeReason(row) {
  if (row?.fetchMode !== 'full') return row?.fetchMode === 'range' ? 'range' : 'unknown'
  if (Number.isFinite(row.packBytes) && row.packBytes < RANGE_MIN_BYTES) return 'below-threshold'
  return 'fallback'
}

/**
 * 汇总。`fallbackFull` 只统计**真正的回退**（见 fullModeReason），
 * 「包太小直接整包」单独记在 `belowThresholdFull`。
 *
 * @param {Array<object>} rows
 * @returns {object}
 */
export function summarize(rows) {
  const byStatus = {}
  for (const status of Object.values(PROBE_STATUS)) byStatus[status] = 0
  let downloadedBytes = 0
  let packBytes = 0
  let fallbackFull = 0
  let belowThresholdFull = 0
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
    if (Number.isFinite(r.downloadedBytes)) downloadedBytes += r.downloadedBytes
    if (Number.isFinite(r.packBytes)) packBytes += r.packBytes
    const reason = fullModeReason(r)
    if (reason === 'fallback') fallbackFull++
    if (reason === 'below-threshold') belowThresholdFull++
  }
  const savedPct = packBytes > 0 ? Number(((1 - downloadedBytes / packBytes) * 100).toFixed(1)) : 0
  return {
    total: rows.length,
    byStatus,
    translatable: rows.filter((r) => r.status === PROBE_STATUS.TRANSLATABLE).map((r) => ({
      id: r.id,
      title: r.title,
      downloads: r.downloads,
      shaderVersion: r.shaderVersion,
      enEntries: r.enEntries,
    })),
    downloadedBytes,
    packBytes,
    savedPct,
    fallbackFull,
    belowThresholdFull,
  }
}
