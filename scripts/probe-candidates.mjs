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
 * 只读：不写 site/data/*.json、不写 site/public/lang/、不碰 Cloudflare。
 *
 * 用法：
 *   node scripts/probe-candidates.mjs                       # 下载量前 50 个
 *   node scripts/probe-candidates.mjs --limit 5             # 只探前 5 个
 *   node scripts/probe-candidates.mjs --ids a,b,c           # 只探指定 id
 *   node scripts/probe-candidates.mjs --out artifacts/candidates.json
 *   node scripts/probe-candidates.mjs --concurrency 3 --min-entries 20
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { openZip } from '../shared/zip-range.mjs'
import {
  DEFAULT_MIN_EN_ENTRIES,
  PROBE_STATUS,
  fullModeReason,
  runProbeCandidates,
  selectCandidates,
  summarize,
} from './lib/probe-candidates.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG_FILE = join(ROOT, 'site/data/modrinth-catalog.json')
const SHADERS_FILE = join(ROOT, 'site/data/shaders.json')
const MODRINTH_API = 'https://api.modrinth.com/v2'
const UA = 'shader-i18n-site/0.1.0 (probe-candidates)'

const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
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

const catalog = JSON.parse(readFileSync(CATALOG_FILE, 'utf8'))
const db = JSON.parse(readFileSync(SHADERS_FILE, 'utf8'))

const items = selectCandidates({ catalog, db, ids: IDS, limit: IDS.length ? IDS.length : LIMIT })
if (!items.length) {
  console.error('没有可探测的候选（目录为空 / 已全部汉化 / --ids 未命中）')
  process.exit(1)
}
console.error(
  `探测 ${items.length} 个候选（并发 ${CONCURRENCY}，可翻条目下限 ${MIN_ENTRIES}，只读 Range，不下载整包）`,
)

/** 取 Modrinth 最新版本的主文件。失败抛错，由 runProbeCandidates 收敛成 probe-failed。 */
async function getLatestFile(projectId) {
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

let doneCount = 0
const rows = await runProbeCandidates({
  items,
  getLatestFile,
  openZip,
  concurrency: CONCURRENCY,
  headers: { 'User-Agent': UA },
  minEntries: MIN_ENTRIES,
  onRow: (row) => {
    doneCount++
    const extra = row.status === PROBE_STATUS.TRANSLATABLE ? `${row.enEntries} 条` : (row.error ?? '')
    // 进度走 stderr，stdout 只留最终 JSON（便于 `> file.json` 直接消费）。
    const reason = fullModeReason(row)
    const modeNote = reason === 'fallback' ? '  ⚠ 回退整包' : reason === 'below-threshold' ? '  （包小于 64KB，直接整包）' : ''
    console.error(`[${doneCount}/${items.length}] ${row.id} → ${row.status}${extra ? `（${extra}）` : ''}${modeNote}`)
  },
})

const summary = summarize(rows)
const output = {
  generatedAt: new Date().toISOString(),
  options: { limit: LIMIT, ids: IDS, concurrency: CONCURRENCY, minEntries: MIN_ENTRIES },
  summary,
  candidates: rows,
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
