#!/usr/bin/env node
/**
 * 拉取 Modrinth 全量光影目录（ADR-0004）。
 *
 * - 分页拉取 Modrinth 全部 project_type:shader 的已审核项目
 * - 收录范围：全量已发布的 shader 项目（不设下载量门槛）
 * - 生成轻量目录 site/data/modrinth-catalog.json（不含简介正文，供列表按需加载）
 * - `hasNativeZhCN` 由 pipeline.mjs 检测 zip 后回写，本脚本不覆盖已有值
 *
 * 用法：npm run catalog
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { diffVanished } from './lib/catalog-diff.mjs'

const CATALOG_FILE = join(dirname(fileURLToPath(import.meta.url)), '../site/data/modrinth-catalog.json')
const MODRINTH_API = 'https://api.modrinth.com/v2'
const UA = 'shader-i18n-site/0.1.0 (catalog sync)'
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
// `noEnUsLang` 同样由 pipeline.mjs 回写（缺英文源标记），同步时保留旧值，避免每天被抹掉。
// 黑名单是「id + 判定版本」两个字段（scripts/lib/blacklist.mjs）：**版本号必须一起保留**，
// 只留 `noEnUsLang: true` 会把版本判据退化成永久跳过 —— 上游补了 en_US.lang 也再也不会重探。
const knownNoEn = new Map(
  (oldCatalog.shaders ?? [])
    .filter((s) => s.noEnUsLang === true)
    .map((s) => [s.id, s.noEnUsLangVersion]),
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
    // 旧值优先：该条目曾被标 noEnUsLang 即保留标记**与判定版本**（新抓取本身不带这两个字段）。
    // 旧数据可能只有标记、没有版本号（历史遗留）：保持原样，pipeline 会按「版本未知」重探一次。
    ...(knownNoEn.has(h.slug)
      ? {
          noEnUsLang: true,
          ...(knownNoEn.get(h.slug) != null && knownNoEn.get(h.slug) !== ''
            ? { noEnUsLangVersion: knownNoEn.get(h.slug) }
            : {}),
        }
      : {}),
    lastSync: new Date().toISOString().slice(0, 10),
  }))
  .sort((a, b) => b.downloads - a.downloads)

// —— 上游消失检测（只报告，绝不自动删）——
// 旧快照在脚本顶部已读入 oldCatalog，覆盖写入前先对比并报告差异。
const shadersJsonPath = join(dirname(CATALOG_FILE), 'shaders.json')
const manualEntries = existsSync(shadersJsonPath)
  ? (JSON.parse(readFileSync(shadersJsonPath, 'utf8')).shaders ?? [])
  : []
const { vanished, vanishedWithTranslations } = diffVanished(
  oldCatalog.shaders ?? [],
  shaders,
  manualEntries,
)
if (vanished.length > 0) {
  console.log(`⚠ 从 Modrinth 目录消失（被隐藏/下架/改名）：${vanished.join(', ')}`)
  console.log(`  其中有汉化、需要人工跟进：${vanishedWithTranslations.join(', ') || '无'}`)
  console.log(`::warning::从 Modrinth 目录消失了 ${vanished.length} 个光影（其中 ${vanishedWithTranslations.length} 个有汉化）`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = vanished.map((id) => {
      const manual = manualEntries.find((m) => m.id === id || m.modrinth?.projectId === id)
      const hasZh = !!manual && (manual.langVersions ?? []).length > 0
      const projectId = manual?.modrinth?.projectId ?? ''
      return `| ${id} | ${hasZh ? '是' : '否'} | ${projectId} |`
    })
    const table = [
      '',
      '## 从 Modrinth 目录消失的光影（同步时检测）',
      '',
      '| id | 有汉化 | projectId |',
      '| --- | --- | --- |',
      ...rows,
      '',
    ].join('\n')
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, table)
  }
} else {
  console.log('✓ 目录对比：没有条目从 Modrinth 消失')
}

mkdirSync(dirname(CATALOG_FILE), { recursive: true })
writeFileSync(CATALOG_FILE, JSON.stringify({ shaders }, null, 2) + '\n')
console.log(`目录写入 ${CATALOG_FILE}：全量 ${shaders.length} 个（其中自带中文 ${shaders.filter((s) => s.hasNativeZhCN).length} 个，打标不排除）`)
