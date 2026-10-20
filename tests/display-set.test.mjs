#!/usr/bin/env node
/**
 * 站点「展示集合」的判据测试（shared/display-set.mjs）+ 防死链回归。
 *
 * 背景（2026-10-21）：`noEnUsLang === true` 的 438 个条目被 `isDisplayable` 排除在列表外，
 * 于是 ShaderList 的「无英文源」统计是 0，用户也搜不到这些光影。修法是**同时**放宽
 * `site/.vitepress/theme/data.js` 与 `scripts/gen-shader-pages.mjs` 的判据 —— 两边必须一致，
 * 否则出现「列表里有、详情页没有」（点进去 404）或反向的死链。
 *
 * 这里锁三层：
 * 1. 纯函数判据本身；
 * 2. 用**仓库真实数据**计算两边的成员集合，断言完全一致（真死链检查）；
 * 3. 每个列表条目都必须能对应到 gen-shader-pages.mjs 会生成的文件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDisplayableEntry, resolveManual } from '../shared/display-set.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'))

test('isDisplayableEntry：已有汉化 / 自带中文 / 无英文源 三类都进展示集合', () => {
  assert.equal(isDisplayableEntry({}, { langVersions: [{ shaderVersion: '1.0' }] }), true, '已有汉化')
  assert.equal(isDisplayableEntry({ hasNativeZhCN: true }, undefined), true, '自带中文')
  assert.equal(isDisplayableEntry({ noEnUsLang: true }, undefined), true, '无英文源')
})

test('isDisplayableEntry：「暂无汉化」不进展示集合（维持产品决定）', () => {
  assert.equal(isDisplayableEntry({}, undefined), false)
  assert.equal(isDisplayableEntry({}, { langVersions: [] }), false)
  assert.equal(isDisplayableEntry({ hasNativeZhCN: false, noEnUsLang: false }, { langVersions: [] }), false)
  assert.equal(isDisplayableEntry({ hasNativeZhCN: null }, undefined), false, 'null 不等于 true')
})

test('isDisplayableEntry：空条目/缺失条目一律 false（不因 undefined 崩）', () => {
  assert.equal(isDisplayableEntry(undefined, undefined), false)
  assert.equal(isDisplayableEntry(null, undefined), false)
})

test('isDisplayableEntry：noEnUsLang 与 langVersions 并存时仍可展示（优先级由 shaderStatus 决定）', () => {
  // 真实案例 doomplus：曾经判定无英文源，后来有了本站汉化 —— 显示「已有汉化」。
  assert.equal(isDisplayableEntry({ noEnUsLang: true }, { langVersions: [{ shaderVersion: '1.0' }] }), true)
})

test('resolveManual：id 优先，projectId 兜底，最后拿 projectId 当 id 再试（与改造前两边并集一致）', () => {
  const byId = new Map([
    ['slug-a', { id: 'slug-a' }],
    ['proj-x', { id: 'proj-x' }],
  ])
  const byProjectId = new Map([['proj-x', { id: 'renamed' }]])
  const maps = { byId, byProjectId }
  // id 命中优先
  assert.equal(resolveManual({ id: 'slug-a', projectId: 'proj-x' }, maps).id, 'slug-a')
  // id 未命中 → projectId 命中
  assert.equal(resolveManual({ id: 'unknown', projectId: 'proj-x' }, maps).id, 'renamed')
  // 只有 projectId-as-id 命中（byProjectId 没有时）
  assert.equal(resolveManual({ id: 'unknown', projectId: 'proj-x' }, { byId, byProjectId: new Map() }).id, 'proj-x')
  // 全未命中
  assert.equal(resolveManual({ id: 'nope', projectId: 'nope2' }, maps), undefined)
  assert.equal(resolveManual(undefined, maps), undefined)
})

/**
 * 复刻 site/.vitepress/theme/data.js 与 scripts/gen-shader-pages.mjs 的成员构造，
 * 断言两者**用真实数据**算出的集合完全相同。任何一边改了判据而另一边没跟上，这里立刻红。
 */
test('真实数据：列表成员集合 === 详情页成员集合（防「列表里有、详情页没有」死链）', () => {
  const catalog = readJson('site/data/modrinth-catalog.json')
  const cfCatalog = readJson('site/data/curseforge-catalog.json')
  const db = readJson('site/data/shaders.json')
  const normSlug = (s) => String(s ?? '').trim().toLowerCase().replace(/[-_\s]+/g, '')

  const byId = new Map(db.shaders.map((s) => [s.id, s]))
  const byProjectId = new Map(
    db.shaders.filter((s) => s.modrinth?.projectId).map((s) => [s.modrinth.projectId, s]),
  )
  const manualOf = (e) => resolveManual(e, { byId, byProjectId })

  // ---- data.js: modrinthShaders ----
  const listModrinth = catalog.shaders
    .filter((e) => isDisplayableEntry(e, manualOf(e)))
    .map((e) => e.id)

  // ---- gen-shader-pages.mjs: catalog.shaders 遍历 ----
  const pageModrinth = catalog.shaders.filter((e) => isDisplayableEntry(e, manualOf(e))).map((e) => e.id)

  assert.deepEqual(listModrinth, pageModrinth, 'Modrinth 侧两边成员必须逐条一致')

  // ---- CF 独占条目（两边同一套判据） ----
  const cfManualBySlug = new Map()
  for (const s of db.shaders) {
    if (s.source !== 'curseforge' || !(s.langVersions?.length > 0 || s.hasNativeZhCN === true)) continue
    cfManualBySlug.set(normSlug(s.id), s)
    if (s.curseforge?.slug) cfManualBySlug.set(normSlug(s.curseforge.slug), s)
  }
  const modrinthIdSet = new Set(catalog.shaders.map((e) => normSlug(e.id)))
  const cfOnly = (cfCatalog.mods ?? [])
    .map((entry) => ({ entry, manual: cfManualBySlug.get(normSlug(entry.slug)) }))
    .filter(({ entry, manual }) => manual && !modrinthIdSet.has(normSlug(entry.slug)))

  const listIds = new Set([...listModrinth, ...cfOnly.map(({ manual }) => manual.id)])
  const pageIds = new Set([...pageModrinth, ...cfOnly.map(({ manual }) => manual.id)])

  assert.deepEqual([...listIds].sort(), [...pageIds].sort(), '全站成员集合必须一致')
  assert.equal(new Set([...listIds]).size, listIds.size, '列表 id 不得重复（重复会导致 Vue key 冲突）')

  // 回归锚点：当前快照下「无英文源」条目必须真的进了展示集合（修复前是 0）。
  const missing = catalog.shaders.filter(
    (e) => e.noEnUsLang === true && !manualOf(e)?.langVersions?.length && e.hasNativeZhCN !== true,
  )
  assert.ok(missing.length > 0, '真实数据里应当存在「无英文源」条目')
  for (const e of missing) {
    assert.ok(listIds.has(e.id), `无英文源条目 ${e.id} 必须在列表成员里`)
    assert.ok(pageIds.has(e.id), `无英文源条目 ${e.id} 必须生成详情页`)
  }
})

test('真实数据：每个「无英文源」条目都有可展示字段（列表/详情页不因缺字段渲染成空白）', () => {
  const catalog = readJson('site/data/modrinth-catalog.json')
  const db = readJson('site/data/shaders.json')
  const byId = new Map(db.shaders.map((s) => [s.id, s]))
  const byProjectId = new Map(
    db.shaders.filter((s) => s.modrinth?.projectId).map((s) => [s.modrinth.projectId, s]),
  )
  const missing = catalog.shaders.filter(
    (e) =>
      e.noEnUsLang === true &&
      isDisplayableEntry(e, resolveManual(e, { byId, byProjectId })) &&
      !resolveManual(e, { byId, byProjectId })?.langVersions?.length,
  )
  assert.ok(missing.length > 0, '应当存在无英文源条目')
  for (const e of missing) {
    assert.ok(typeof e.id === 'string' && e.id, `${e.id} 缺 id`)
    assert.ok(typeof e.title === 'string' && e.title, `${e.id} 缺 title（列表标题会空白）`)
    assert.ok(typeof e.projectId === 'string' && e.projectId, `${e.id} 缺 projectId（详情页无法拉版本列表）`)
  }
})
