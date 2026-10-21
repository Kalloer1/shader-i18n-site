#!/usr/bin/env node
/**
 * 拉取 CurseForge 全量光影目录（第 1 批：目录采集）。
 *
 * - 分页拉取 CF 全部 shader 项目（gameId=432, classId=6552）
 * - 生成轻量目录 site/data/curseforge-catalog.json（仅采集，不下载、不翻译）
 * - 失败保护：中途任何一页失败或数量明显偏少（<700）时拒绝覆盖已有目录
 *
 * 用法：npm run cf-catalog（CI 中由 sync.yml 的 Fetch CurseForge catalog 步骤调用）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const KEY = process.env.CURSEFORGE_API_KEY
if (!KEY) {
  console.error('缺少 CURSEFORGE_API_KEY：请在环境变量中提供 CurseForge API Key（CI 通过 secrets.CURSEFORGE_API_KEY 注入）。')
  process.exit(1)
}

const CATALOG_FILE = join(dirname(fileURLToPath(import.meta.url)), '../site/data/curseforge-catalog.json')
const MODRINTH_CATALOG = join(dirname(fileURLToPath(import.meta.url)), '../site/data/modrinth-catalog.json')
const UA = 'shader-i18n-site/0.1.0 (catalog sync)'
const GAME_ID = 432
const CLASS_ID = 6552
const PAGE_SIZE = 50
const MIN_EXPECTED = 700

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const api = (p) => `https://api.curseforge.com/v1${p}`

async function cfGet(url) {
  const res = await fetch(url, { headers: { 'x-api-key': KEY, 'User-Agent': UA } })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}

// 分页拉取一页；429/5xx 退避重试 2 次（1s/2s），仍失败则抛错终止采集
async function getPage(index) {
  const url = api(`/mods/search?gameId=${GAME_ID}&classId=${CLASS_ID}&pageSize=${PAGE_SIZE}&index=${index}`)
  let attempt = 0
  for (;;) {
    const r = await cfGet(url)
    if (r.status === 200 && r.json) return r.json
    if ((r.status === 429 || r.status >= 500) && attempt < 2) {
      attempt += 1
      const delay = attempt === 1 ? 1000 : 2000
      console.error(`HTTP ${r.status}（index=${index}），${delay / 1000}s 后重试第 ${attempt} 次...`)
      await sleep(delay)
      continue
    }
    throw new Error(`CurseForge 分页请求失败 HTTP ${r.status}（index=${index}）：${String(r.text).slice(0, 200)}`)
  }
}

async function fetchAllMods() {
  const mods = []
  let index = 0
  for (;;) {
    const page = await getPage(index)
    const data = page.data || []
    mods.push(...data)
    const total = page.pagination?.totalCount ?? mods.length
    process.stdout.write(`\r已拉取 ${mods.length}/${total}`)
    if (data.length < PAGE_SIZE || mods.length >= total) break
    index += PAGE_SIZE
    await sleep(500)
  }
  console.log()
  return mods
}

function normalizeSlug(s) {
  return String(s ?? '').trim().toLowerCase().replace(/[-_\s]+/g, '')
}

function printExclusiveStats(mods) {
  try {
    const mr = JSON.parse(readFileSync(MODRINTH_CATALOG, 'utf8'))
    const mrSlugs = new Set((mr.shaders ?? []).map((s) => normalizeSlug(s.id)))
    const cfSlugs = new Set(mods.map((m) => normalizeSlug(m.slug)))
    let matched = 0
    for (const s of cfSlugs) if (mrSlugs.has(s)) matched += 1
    console.log(`CF 总数 ${cfSlugs.size} | 归一化匹配 Modrinth ${matched} | CF 独占 ${cfSlugs.size - matched}`)
  } catch (e) {
    console.error(`CF 独占统计失败（不影响目录写入）：${e && e.message ? e.message : String(e)}`)
  }
}

let mods
try {
  mods = await fetchAllMods()
} catch (e) {
  console.error(`采集失败：${e && e.message ? e.message : String(e)}`)
  process.exit(1)
}

if (mods.length < MIN_EXPECTED) {
  console.error(`采集失败：CF 光影数量 ${mods.length} 明显少于预期（< ${MIN_EXPECTED}），拒绝覆盖已有目录。`)
  process.exit(1)
}

// CF search 响应里的字段名未在本机实访验证（本机直连 CF 被 WAF 403 拦截），
// 因此渲染相关字段一律防御式取值：多候选键，取不到就省略/留空。
// 取不到时前端有兜底：无封面走首字母占位、无 gameVersions 不渲染 MC 版本行。
const pick = (obj, ...keys) => {
  for (const k of keys) {
    const v = k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), obj)
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}
const pickArray = (obj, ...keys) => {
  const v = pick(obj, ...keys)
  return Array.isArray(v) ? v : undefined
}

// ---------- 文件大小（fileLength） ----------
// 为什么必须采：探测阶段（scripts/lib/zip-probe.mjs → shared/zip-range.mjs）用 totalSize 决定
// 走 Range 还是整包。没有大小 → 每个包都只能整包下载，探测收益为 0。
// 来源：CF 文件列表接口（GET /v1/mods/{id}/files）的 `fileLength`。search 响应的 latestFiles
// 通常也带，但字段可能被裁剪 —— 以文件列表接口为准。
const FILE_CONCURRENCY = 4
const FILE_PAGE_SIZE = 50
// 每次文件列表请求后的间隔：CF 有速率限制。测试里置 0（端到端测试要跑 700 个假项目）。
const FILE_REQUEST_DELAY_MS = Math.max(0, Number(process.env.CF_FILE_REQUEST_DELAY_MS ?? 120) || 0)

/** 与 pipeline.mjs 的 processShaderCf 同一套候选顺序：release 优先，同类型内 fileDate 倒序。 */
function pickLatestFile(files) {
  if (!Array.isArray(files) || !files.length) return null
  return files
    .slice()
    .sort((a, b) => {
      const aRelease = a.releaseType === 1 ? 0 : 1
      const bRelease = b.releaseType === 1 ? 0 : 1
      if (aRelease !== bRelease) return aRelease - bRelease
      return String(b.fileDate).localeCompare(String(a.fileDate))
    })[0]
}

/**
 * 给每个项目补 fileLength（失败不阻断：单条拿不到就留空，探测侧按「无大小」走整包）。
 * 返回 Map<cfId, {fileId, fileLength, fileName}>。
 */
async function fetchFileSizes(mods) {
  const out = new Map()
  let done = 0
  let failed = 0
  let next = 0
  const workers = Array.from({ length: Math.min(FILE_CONCURRENCY, mods.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= mods.length) return
      const m = mods[i]
      const url = api(`/mods/${m.id}/files?pageSize=${FILE_PAGE_SIZE}`)
      let attempt = 0
      for (;;) {
        const r = await cfGet(url)
        if (r.status === 200 && r.json) {
          const f = pickLatestFile(r.json.data)
          if (f) out.set(m.id, { fileId: f.id, fileLength: f.fileLength, fileName: f.fileName })
          break
        }
        if ((r.status === 429 || r.status >= 500) && attempt < 2) {
          attempt += 1
          await sleep(attempt === 1 ? 1000 : 2000)
          continue
        }
        failed += 1
        break
      }
      done += 1
      if (done % 25 === 0) process.stdout.write(`\r已取文件大小 ${done}/${mods.length}`)
      if (FILE_REQUEST_DELAY_MS) await sleep(FILE_REQUEST_DELAY_MS)
    }
  })
  await Promise.all(workers)
  console.log()
  if (failed) console.log(`⚠ 有 ${failed} 个项目取文件大小失败，对应条目 fileLength 留空（探测时走整包）`)
  return out
}

// 已有的旧目录：取大小失败的条目沿用上次采到的值，避免一次网络抖动把整列清空。
const oldCatalogFile = existsSync(CATALOG_FILE) ? JSON.parse(readFileSync(CATALOG_FILE, 'utf8')) : { mods: [] }
const oldSizes = new Map(
  (oldCatalogFile.mods ?? [])
    .filter((m) => Number.isFinite(m?.fileLength))
    .map((m) => [m.cfId, { fileId: m.latestFileId, fileLength: m.fileLength }]),
)

// 作者禁止 API 分发的项目（allowModDistribution === false）下载接口一律 403，
// 连探测都做不了 —— 不为它们花文件列表请求（当前 275 个，约占三分之一）。
const probeable = mods.filter((m) => m.allowModDistribution !== false)
console.log(`取文件大小：${probeable.length} 个可探测项目（已跳过禁止分发的 ${mods.length - probeable.length} 个）`)
const sizes = await fetchFileSizes(probeable)

const rows = mods.map((m) => {
  const size = sizes.get(m.id) ?? oldSizes.get(m.id)
  return {
    cfId: m.id,
    slug: m.slug,
    name: m.name,
    downloads: m.downloadCount,
    author: m.authors?.[0]?.name ?? '',
    pageUrl: m.links?.websiteUrl ?? `https://www.curseforge.com/minecraft/shaders/${m.slug}`,
    updated: m.dateModified ?? '',
    latestFileId: size?.fileId ?? m.latestFiles?.[0]?.id ?? null,
    // 最新候选文件的字节数：探测阶段用它判断能否走 HTTP Range（缺失时只能整包下载）。
    // 禁止分发的条目没有意义，留空即可（探测侧会提前排除它们）。
    ...(Number.isFinite(size?.fileLength) ? { fileLength: size.fileLength } : {}),
    // 以下为详情页/列表渲染所需字段（CF v1 search：logo.thumbnailUrl / screenshots[].thumbnailUrl /
    // gameVersions / categories[].name / summary）
    iconUrl: pick(m, 'logo.thumbnailUrl', 'logo.url', 'thumbnailUrl') ?? '',
    gallery: (pickArray(m, 'screenshots') ?? [])
      .map((s) => pick(s, 'thumbnailUrl', 'url'))
      .filter(Boolean),
    gameVersions: pickArray(m, 'gameVersions') ?? [],
    categories: (pickArray(m, 'categories') ?? []).map((c) => pick(c, 'name')).filter(Boolean),
    description: pick(m, 'summary', 'description') ?? '',
    // 项目级分发许可：false = 作者禁止 API 分发（pipeline 直接跳过，不浪费下载预算）。
    // 原样存回；字段缺失时为 undefined，JSON 序列化会省略该键（消费侧按“未采集”处理，不排除）。
    allowModDistribution: m.allowModDistribution,
  }
})

const catalog = {
  $comment: '本文件由 scripts/fetch-curseforge-catalog.mjs 自动生成，请勿手改；每日由 sync.yml 刷新。',
  generatedAt: new Date().toISOString(),
  source: 'curseforge',
  count: rows.length,
  mods: rows,
}

mkdirSync(dirname(CATALOG_FILE), { recursive: true })
writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2) + '\n')

printExclusiveStats(mods)
const withSize = rows.filter((r) => Number.isFinite(r.fileLength)).length
console.log(`目录写入 ${CATALOG_FILE}：CF 全量 ${rows.length} 个，其中带文件大小 ${withSize} 个。`)