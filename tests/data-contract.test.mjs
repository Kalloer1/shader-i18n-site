#!/usr/bin/env node
/**
 * 数据与渲染契约测试。
 *
 * 覆盖：
 *  - shaders.json 结构合法（id 唯一、langVersions 字段完整、file 路径形态正确）
 *  - 每个已登记的 lang 文件在磁盘上真实存在
 *  - 每个 lang 文件能通过 validate-lang 自检
 *  - gen-shader-pages.mjs 能渲染出详情页（冒烟）
 *
 * 运行：npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { validatePair, parse, extractPlaceholders, resolveEnText } from '../scripts/validate-lang.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHADERS_FILE = join(ROOT, 'site/data/shaders.json')
const LANG_DIR = join(ROOT, 'site/public/lang')

const db = JSON.parse(readFileSync(SHADERS_FILE, 'utf8'))

test('shaders.json：顶层结构合法', () => {
  assert.ok(Array.isArray(db.shaders), 'shaders 必须是数组')
  assert.ok(db.shaders.length > 0, 'shaders 不能为空')
})

test('shaders.json：id 唯一', () => {
  const ids = db.shaders.map((s) => s.id)
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
  assert.deepEqual(dupes, [], `存在重复 id: ${dupes.join(', ')}`)
})

test('shaders.json：每个条目有合法 modrinth 映射', () => {
  for (const s of db.shaders) {
    assert.ok(typeof s.id === 'string' && s.id.length > 0, `id 非法: ${JSON.stringify(s.id)}`)
    // CurseForge 独占条目没有 modrinth 映射，改为校验 curseforge 映射（形态见 cf-conventions.test.mjs）
    if (s.source === 'curseforge') {
      assert.ok(s.curseforge && typeof s.curseforge === 'object', `${s.id} 缺 curseforge`)
      assert.ok(typeof s.curseforge.slug === 'string' && s.curseforge.slug, `${s.id} 缺 curseforge.slug`)
      assert.ok(Number.isInteger(s.curseforge.cfId), `${s.id} 缺 curseforge.cfId`)
      continue
    }
    assert.ok(s.modrinth && typeof s.modrinth === 'object', `${s.id} 缺 modrinth`)
    assert.ok(typeof s.modrinth.projectId === 'string', `${s.id} 缺 modrinth.projectId`)
  }
})

test('shaders.json：langVersions 字段完整、路径形态正确、版本不重复', () => {
  for (const s of db.shaders) {
    const versions = s.langVersions ?? []
    const seen = new Set()
    for (const v of versions) {
      assert.ok(typeof v.shaderVersion === 'string' && v.shaderVersion, `${s.id} 的 langVersion 缺 shaderVersion`)
      assert.ok(
        v.file === `/lang/${s.id}/${v.shaderVersion}/zh_CN.lang`,
        `${s.id} 的 file 路径与 id/版本不符: ${v.file}`,
      )
      assert.ok(!seen.has(v.shaderVersion), `${s.id} 的版本 ${v.shaderVersion} 重复登记`)
      seen.add(v.shaderVersion)
      assert.ok(Array.isArray(v.contributors), `${s.id} v${v.shaderVersion} 缺 contributors`)
    }
  }
})

test('已登记的 lang 文件在磁盘上真实存在', () => {
  const missing = []
  for (const s of db.shaders) {
    for (const v of s.langVersions ?? []) {
      const p = join(ROOT, 'site/public', v.file)
      if (!existsSync(p)) missing.push(`${s.id}/${v.shaderVersion}`)
    }
  }
  assert.deepEqual(missing, [], `以下登记的 lang 文件不存在: ${missing.join(', ')}`)
})

test('已登记的 lang 文件通过自检（无 BOM、无重复键）', () => {
  for (const s of db.shaders) {
    for (const v of s.langVersions ?? []) {
      const p = join(ROOT, 'site/public', v.file)
      if (!existsSync(p)) continue
      const text = readFileSync(p, 'utf8')
      const label = `${s.id}/${v.shaderVersion}`
      assert.notEqual(text.charCodeAt(0), 0xfeff, `${label} 含 BOM`)

      const entries = parse(text)
      assert.ok(entries.size > 0, `${label} 解析出 0 个键`)

      // 占位符自身可解析（不抛错）
      for (const [, value] of entries) extractPlaceholders(value)
    }
  }
})

test('存在同目录 en_US.lang 时，完整比对必须通过', () => {
  for (const s of db.shaders) {
    for (const v of s.langVersions ?? []) {
      const zhPath = join(ROOT, 'site/public', v.file)
      const enPath = join(dirname(zhPath), 'en_US.lang')
      if (!existsSync(enPath) || !existsSync(zhPath)) continue
      const r = validatePair(readFileSync(enPath, 'utf8'), readFileSync(zhPath, 'utf8'))
      assert.deepEqual(r.problems, [], `${s.id}/${v.shaderVersion} 校验未通过`)
    }
  }
})

test('每个已登记的 lang 文件都能解析出英文源（本地 sources/ 或 data/lang-sources.json.gz）', () => {
  const unresolved = []
  for (const s of db.shaders) {
    for (const v of s.langVersions ?? []) {
      const zhPath = join(ROOT, 'site/public', v.file)
      if (!existsSync(zhPath)) continue
      if (resolveEnText(zhPath) === null) unresolved.push(`${s.id}/${v.shaderVersion}`)
    }
  }
  assert.deepEqual(
    unresolved,
    [],
    `以下文件找不到英文源，CI 闸门会假通过: ${unresolved.join(', ')}`,
  )
})

test('gen-shader-pages.mjs 存在且导出可渲染的页面内容', async () => {
  const scriptPath = join(ROOT, 'scripts/gen-shader-pages.mjs')
  assert.ok(existsSync(scriptPath), 'gen-shader-pages.mjs 不存在')

  const src = readFileSync(scriptPath, 'utf8')
  // 冒烟：脚本必须引用详情页输出目录与 shaders.json
  assert.match(src, /shaders\.json/, '脚本未读取 shaders.json')
  assert.match(src, /site[\/\\]shaders|shaders['"]/, '脚本未写入 site/shaders')
})

// 孤儿条目白名单：`shaders.json` 里有 `langVersions`，但项目本身已从 Modrinth 目录消失
// （下架/隐藏/改名），因此列表与详情页的自动成员判据都找不到它。
//
// 为什么允许存在而不是直接删：`langVersions` 是**人工/LLM 劳动产物**，删了就要重做；
// 而 Modrinth 下架不等于永久消失（作者常先隐藏再改名，projectId 稳定）。
// 保留数据 + 登记白名单，是唯一「不销毁劳动、又不阻断部署」的选项。
//
// 登记规则（测试会强制校验，见下一个 test）：
//   - `reason`：为什么它不在 catalog 里（查到的证据，不是「不知道」）；
//   - `reviewBy`：复查日期 `YYYY-MM-DD`，过期未复查会让测试失败，避免白名单变成垃圾场。
const ORPHAN_WHITELIST = [
  {
    id: 'avalux-reimagined',
    projectId: 'piJlVDtP',
    reason: 'Modrinth 项目已消失：/v2/project/piJlVDtP 返回 404，搜索 "AVALux" 命中 0 条（2026-10-19 实测）',
    reviewBy: '2027-01-19',
  },
  {
    id: 'cinematix-shader',
    projectId: 'AAUN4OCM',
    reason: 'Modrinth 项目已消失：/v2/project/AAUN4OCM 返回 404，搜索 "Cinematix" 命中 0 条（2026-10-19 实测）',
    reviewBy: '2027-01-19',
  },
]
const ORPHAN_IDS = ORPHAN_WHITELIST.map((e) => e.id)

const normSlug = (s) => String(s ?? '').trim().toLowerCase().replace(/[-_\s]+/g, '')

test('shaders.json：有 langVersions 的条目必须在 catalog 中可找到，否则进入白名单（防死链回归）', () => {
  const catalog = JSON.parse(
    readFileSync(join(ROOT, 'site/data/modrinth-catalog.json'), 'utf8'),
  )
  const cfCatalog = JSON.parse(
    readFileSync(join(ROOT, 'site/data/curseforge-catalog.json'), 'utf8'),
  )
  const catalogIds = new Set(catalog.shaders.map((e) => e.id))
  const catalogProjectIds = new Set(catalog.shaders.map((e) => e.projectId))
  // CurseForge 独占条目（source=curseforge）：列表/详情页成员判据与 site/.vitepress/theme/data.js
  // 的 cfOnlyShaders 一致 —— 归一化 slug 命中 CF 目录，即视为可找到（不再算死链）。
  const cfSlugs = new Set((cfCatalog.mods ?? []).map((m) => normSlug(m.slug)))
  const missing = []
  for (const s of db.shaders) {
    if (!(s.langVersions ?? []).length) continue
    const foundCf =
      s.source === 'curseforge' &&
      (cfSlugs.has(normSlug(s.id)) || cfSlugs.has(normSlug(s.curseforge?.slug)))
    const found =
      foundCf ||
      catalogIds.has(s.id) ||
      catalogProjectIds.has(s.modrinth?.projectId) ||
      catalogProjectIds.has(s.id)
    if (!found && !ORPHAN_IDS.includes(s.id)) missing.push(s.id)
  }
  assert.deepEqual(
    missing,
    [],
    `以下 shaders.json 条目不在 catalog 且不在白名单，会造成列表死链: ${missing.join(', ')}`,
  )
})

test('孤儿白名单自身必须合格：字段完整、复查未过期、条目真实存在且有 langVersions', () => {
  // 白名单不是垃圾场。没有这层校验，`ORPHAN_WHITELIST` 很快会变成
  // 「只要测试红了就往里塞一行」的垃圾桶，防死链回归就失效了。
  for (const e of ORPHAN_WHITELIST) {
    assert.ok(e.id, '白名单条目必须有 id')
    assert.ok(
      typeof e.reason === 'string' && e.reason.trim().length >= 10,
      `白名单条目 ${e.id} 必须写清 reason（为什么它不在 catalog 里），不能留空或写「不知道」`,
    )
    assert.match(
      String(e.reviewBy ?? ''),
      /^\d{4}-\d{2}-\d{2}$/,
      `白名单条目 ${e.id} 的 reviewBy 必须是 YYYY-MM-DD`,
    )
    // 过期即失败：强制下一次维护时真的去复查（项目恢复了吗？还是该删汉化了？）。
    const today = new Date().toISOString().slice(0, 10)
    assert.ok(
      e.reviewBy >= today,
      `白名单条目 ${e.id} 已过期（reviewBy=${e.reviewBy} < 今天 ${today}），请复查后更新日期`,
    )
    // 条目必须真实存在于 shaders.json 且有 langVersions，否则白名单本身是死条目。
    const entry = db.shaders.find((s) => s.id === e.id)
    assert.ok(entry, `白名单条目 ${e.id} 在 shaders.json 里不存在，应删掉这条白名单`)
    assert.ok(
      (entry.langVersions ?? []).length > 0,
      `白名单条目 ${e.id} 已经没有 langVersions 了，应删掉这条白名单`,
    )
  }
  // id 不能重复，否则很难看出到底登记了几条。
  assert.equal(new Set(ORPHAN_IDS).size, ORPHAN_IDS.length, '白名单 id 不得重复')
})

test('占位符抽取对真实 lang 文件不产生误报（回归）', () => {
  // 光影包常见的百分号用法：字面 % 与转义 %%
  assert.equal(extractPlaceholders('100%%').get('%%'), 1)
  assert.equal(extractPlaceholders('%s of %s').get('%s'), 2)
  // § 格式码不应被当成占位符
  assert.equal(extractPlaceholders('§e%s').get('%s'), 1)
})
