#!/usr/bin/env node
/**
 * 拉取 Modrinth 全量光影目录（ADR-0004）。
 *
 * - 分页拉取 Modrinth 全部 project_type:shader 的已审核项目
 * - 收录门槛：下载量 >= 1000
 * - 生成轻量目录 site/data/modrinth-catalog.json（不含简介正文，供列表按需加载）
 * - `hasNativeZhCN` 由 pipeline.mjs 检测 zip 后回写，本脚本不覆盖已有值
 *
 * 用法：npm run catalog
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const CATALOG_FILE = join(dirname(fileURLToPath(import.meta.url)), '../site/data/modrinth-catalog.json')
const MODRINTH_API = 'https://api.modrinth.com/v2'
const UA = 'shader-i18n-site/0.1.0 (catalog sync)'
const MIN_DOWNLOADS = 0 // 已取消门槛：全量收录（ADR-0004 修订，自带中文打标不排除）
const PAGE_SIZE = 100

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} <- ${url}`)
  return res.json()
}

// 全量分页：Facet 过滤 shader 类型 + 已审核通过（projects 端点只返回已发布项目）
async function fetchAllShaders() {
  const facets = encodeURIComponent(JSON.stringify([['project_type:shader']]))
  const entries = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = `${MODRINTH_API}/search?limit=${PAGE_SIZE}&index=downloads&facets=${facets}&offset=${offset}`
    const page = await getJSON(url)
    entries.push(...page.hits)
    process.stdout.write(`\r已拉取 ${entries.length}/${page.total_hits}`)
    if (entries.length >= page.total_hits || page.hits.length === 0) break
    await sleep(300)
  }
  console.log()
  return entries
}

const oldCatalog = existsSync(CATALOG_FILE)
  ? JSON.parse(readFileSync(CATALOG_FILE, 'utf8'))
  : { shaders: [] }
const knownNative = new Map(
  (oldCatalog.shaders ?? []).filter((s) => s.hasNativeZhCN !== undefined).map((s) => [s.id, s.hasNativeZhCN]),
)

const hits = await fetchAllShaders()
const shaders = hits
  .map((h) => ({
    id: h.slug,
    projectId: h.project_id,
    title: h.title,
    author: h.author,
    downloads: h.downloads,
    iconUrl: h.icon_url ?? '',
    description: h.description ?? '',
    pageUrl: `https://modrinth.com/shader/${h.slug}`,
    gameVersions: h.versions ?? [],
    gallery: (h.gallery ?? []).slice(0, 3),
    color: h.color ?? '',
    categories: h.categories ?? [],
    // 已检测过的保留检测结果，未检测的为 null（pipeline 检测 zip 后回写）
    hasNativeZhCN: knownNative.get(h.slug) ?? null,
    lastSync: new Date().toISOString().slice(0, 10),
  }))
  .sort((a, b) => b.downloads - a.downloads)

mkdirSync(dirname(CATALOG_FILE), { recursive: true })
writeFileSync(CATALOG_FILE, JSON.stringify({ shaders }, null, 2) + '\n')
console.log(`目录写入 ${CATALOG_FILE}：全量 ${shaders.length} 个（其中自带中文 ${shaders.filter((s) => s.hasNativeZhCN).length} 个，打标不排除）`)
