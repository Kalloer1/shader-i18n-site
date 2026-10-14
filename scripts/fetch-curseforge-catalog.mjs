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

const rows = mods.map((m) => ({
  cfId: m.id,
  slug: m.slug,
  name: m.name,
  downloads: m.downloadCount,
  author: m.authors?.[0]?.name ?? '',
  pageUrl: m.links?.websiteUrl ?? `https://www.curseforge.com/minecraft/shaders/${m.slug}`,
  updated: m.dateModified ?? '',
  latestFileId: m.latestFiles?.[0]?.id ?? null,
  // 项目级分发许可：false = 作者禁止 API 分发（pipeline 直接跳过，不浪费下载预算）。
  // 原样存回；字段缺失时为 undefined，JSON 序列化会省略该键（消费侧按“未采集”处理，不排除）。
  allowModDistribution: m.allowModDistribution,
}))

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
console.log(`目录写入 ${CATALOG_FILE}：CF 全量 ${rows.length} 个。`)