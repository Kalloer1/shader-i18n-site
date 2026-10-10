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

test('占位符抽取对真实 lang 文件不产生误报（回归）', () => {
  // 光影包常见的百分号用法：字面 % 与转义 %%
  assert.equal(extractPlaceholders('100%%').get('%%'), 1)
  assert.equal(extractPlaceholders('%s of %s').get('%s'), 2)
  // § 格式码不应被当成占位符
  assert.equal(extractPlaceholders('§e%s').get('%s'), 1)
})
