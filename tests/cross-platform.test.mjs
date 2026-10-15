#!/usr/bin/env node
/**
 * scripts/lib/cross-platform.mjs 的离线单元测试：跨平台「同一个光影」识别。
 *
 * 覆盖归一化、唯一性要求、三类旁证（slug / 作者 / 描述）、以及真实目录上的正例与反例：
 *  - 正例：CF `noble-shaders` 必须认出 Modrinth `noble`（同一光影，那边已有汉化）；
 *  - 反例：CF `exposa-unique-shaders` 与 Modrinth `exposa-shaders` 标题同名，但作者与描述都不同，
 *    必须**不**配对（误判 = 该翻的没翻，比漏判更糟）。
 * 不发任何网络请求。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  buildTitleIndex,
  findModrinthTwin,
  findTranslatedTwin,
  isSameShader,
  normSlug,
  normText,
} from '../scripts/lib/cross-platform.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))

describe('normText / normSlug 归一化', () => {
  it('normText 去掉空格、标点、emoji，保留字母数字并小写', () => {
    assert.equal(normText('Noble Shaders'), 'nobleshaders')
    assert.equal(normText('🌌 AuroraFX — Ultra Lite'), 'aurorafxultralite')
    assert.equal(normText("Sildur's Enhanced Default Shaders"), 'sildursenhanceddefaultshaders')
  })

  it('normSlug 与站点 normSlug 同规则（trim + 小写 + 去 - _ 空白）', () => {
    assert.equal(normSlug(' BSL-Shaders '), 'bslshaders')
    assert.equal(normSlug('black_and_white'), 'blackandwhite')
  })
})

describe('buildTitleIndex 索引', () => {
  it('按归一化标题分组，过短标题（< 4 字符）不入索引', () => {
    const index = buildTitleIndex(
      [
        { id: 'a', title: 'Noble Shaders' },
        { id: 'b', title: 'noble  shaders' },
        { id: 'c', title: 'Osh' },
      ],
      (e) => e.title,
    )
    assert.deepEqual(index.get('nobleshaders').map((e) => e.id), ['a', 'b'])
    assert.equal(index.has('osh'), false)
  })
})

describe('isSameShader 旁证判定', () => {
  const mr = { id: 'noble', author: 'BelmuTM', description: 'Using clever lighting techniques' }

  it('slug 归一化相等 → 成立（强证据）', () => {
    assert.equal(isSameShader({ slug: 'Noble_Shaders' }, { id: 'noble-shaders' }), true)
  })

  it('作者名互相包含 → 成立（跨平台账号名常带后缀）', () => {
    assert.equal(isSameShader({ slug: 'noble-shaders', author: 'Belmu' }, mr), true)
    assert.equal(isSameShader({ slug: 'x', author: 'BelmuTM-archive' }, mr), true)
  })

  it('描述归一化完全相同 → 成立', () => {
    assert.equal(isSameShader({ slug: 'x', author: 'someone', description: 'Using clever lighting techniques!' }, mr), true)
  })

  it('三项旁证都不成立 → 不成立（宁可漏判）', () => {
    assert.equal(isSameShader({ slug: 'x', author: 'other', description: '完全不同的一段话' }, mr), false)
    assert.equal(isSameShader({ slug: 'x' }, mr), false)
    assert.equal(isSameShader({ slug: 'x', author: 'a', description: 'y' }, mr), false)
  })
})

describe('findModrinthTwin 唯一性要求', () => {
  const index = buildTitleIndex(
    [
      { id: 'event-horizon-shader', title: 'Event Horizon', author: 'same' },
      { id: 'eventhorizon-salut', title: 'Event Horizon', author: 'same' },
    ],
    (e) => e.title,
  )

  it('Modrinth 侧同名多条 → 放弃（无法确定是哪一个）', () => {
    assert.equal(findModrinthTwin({ slug: 'eventhorizon', title: 'Event Horizon', author: 'same' }, index), null)
  })

  it('标题归一化后过短 → 放弃', () => {
    assert.equal(findModrinthTwin({ slug: 'osh', title: 'Osh', author: 'same' }, index), null)
  })
})

describe('findTranslatedTwin 只在 Modrinth 侧已有汉化时命中', () => {
  const titleIndex = buildTitleIndex(
    [
      { id: 'noble', title: 'Noble Shaders', author: 'BelmuTM', description: 'desc' },
      { id: 'untranslated', title: 'Untranslated Shaders', author: 'someone', description: 'desc' },
    ],
    (e) => e.title,
  )
  const shaders = [
    { id: 'noble', modrinth: { slug: 'noble', projectId: 'sclYVqbt' }, langVersions: [{ shaderVersion: '1.9.9' }, { shaderVersion: '1.9.7' }] },
    { id: 'untranslated', modrinth: { slug: 'untranslated', projectId: 'aaaa' }, langVersions: [] },
  ]

  it('命中并返回最新已汉化版本（langVersions 按新在前）', () => {
    const twin = findTranslatedTwin({ slug: 'noble-shaders', title: 'Noble Shaders', author: 'Belmu', description: 'desc' }, titleIndex, shaders)
    assert.deepEqual(twin, { id: 'noble', title: 'Noble Shaders', shaderVersion: '1.9.9' })
  })

  it('Modrinth 侧未登记汉化 → 不命中（该翻还是要翻）', () => {
    const twin = findTranslatedTwin({ slug: 'x', title: 'Untranslated Shaders', author: 'someone', description: 'desc' }, titleIndex, shaders)
    assert.equal(twin, null)
  })

  it('shaders.json 里没有对应条目 → 不命中', () => {
    const twin = findTranslatedTwin({ slug: 'x', title: 'Noble Shaders', author: 'Belmu', description: 'desc' }, titleIndex, [])
    assert.equal(twin, null)
  })
})

describe('真实目录：正例与反例（防误判回归）', () => {
  const cfCatalog = readJson('site/data/curseforge-catalog.json')
  const mrCatalog = readJson('site/data/modrinth-catalog.json')
  const db = readJson('site/data/shaders.json')
  const titleIndex = buildTitleIndex(mrCatalog.shaders, (e) => e.title)
  const cfBySlug = new Map((cfCatalog.mods ?? []).map((m) => [m.slug, m]))
  const toCf = (slug) => {
    const m = cfBySlug.get(slug)
    assert.ok(m, `CurseForge 目录里应有 ${slug}`)
    return { slug: m.slug, title: m.name, author: m.author, description: m.description }
  }

  it('CF noble-shaders 认出 Modrinth noble（本站已有汉化）', () => {
    const twin = findTranslatedTwin(toCf('noble-shaders'), titleIndex, db.shaders)
    assert.ok(twin, 'noble-shaders 必须与 Modrinth 的 noble 配成同一光影')
    assert.equal(twin.id, 'noble')
    const shader = db.shaders.find((s) => s.id === twin.id)
    assert.ok(
      shader.langVersions.some((v) => v.shaderVersion === twin.shaderVersion),
      '返回的版本必须是 shaders.json 里真实登记的汉化版本',
    )
  })

  it('CF exposá-unique-shaders 与 Modrinth exposá-shaders 标题同名但作者/描述都不同 → 不配对', () => {
    assert.equal(findTranslatedTwin(toCf('exposa-unique-shaders'), titleIndex, db.shaders), null)
  })

  it('Modrinth 侧同名多条的标题（eventhorizon / highframes）一律放弃', () => {
    assert.equal(findTranslatedTwin(toCf('eventhorizon'), titleIndex, db.shaders), null)
    assert.equal(findTranslatedTwin(toCf('highframes'), titleIndex, db.shaders), null)
  })
})
