#!/usr/bin/env node
/**
 * shared/tencent-docs.mjs 链接解析的离线单元测试。
 *
 * 覆盖 Worker 提交入口的两个解析函数：
 *  - parseModrinthSlug：原行为（只认 https、只认 modrinth.com）
 *  - parseCurseforgeSlug：CF 链接（容忍 http / 有无 www / 尾部子路径 / 尾斜杠），
 *    非 shaders 分类与非法输入一律 null（绝不抛）
 *
 * 不发任何网络请求。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseModrinthSlug, parseCurseforgeSlug } from '../shared/tencent-docs.mjs'

describe('parseCurseforgeSlug：合法 CF 光影链接', () => {
  it('标准链接', () => {
    assert.equal(
      parseCurseforgeSlug('https://www.curseforge.com/minecraft/shaders/bsl-shaders'),
      'bsl-shaders',
    )
  })

  it('带尾部子路径 /files', () => {
    assert.equal(
      parseCurseforgeSlug('https://www.curseforge.com/minecraft/shaders/bsl-shaders/files'),
      'bsl-shaders',
    )
  })

  it('末尾斜杠', () => {
    assert.equal(
      parseCurseforgeSlug('https://www.curseforge.com/minecraft/shaders/bsl-shaders/'),
      'bsl-shaders',
    )
  })

  it('http 与无 www 都接受', () => {
    assert.equal(parseCurseforgeSlug('http://curseforge.com/minecraft/shaders/bsl-shaders'), 'bsl-shaders')
    assert.equal(parseCurseforgeSlug('http://www.curseforge.com/minecraft/shaders/bsl-shaders'), 'bsl-shaders')
  })

  it('带查询串', () => {
    assert.equal(
      parseCurseforgeSlug('https://www.curseforge.com/minecraft/shaders/bsl-shaders?foo=1'),
      'bsl-shaders',
    )
  })

  it('slug 含数字/点/下划线/连字符', () => {
    assert.equal(
      parseCurseforgeSlug('https://www.curseforge.com/minecraft/shaders/sildurs-enhanced-default'),
      'sildurs-enhanced-default',
    )
    assert.equal(parseCurseforgeSlug('https://www.curseforge.com/minecraft/shaders/a_b.c-1'), 'a_b.c-1')
  })
})

describe('parseCurseforgeSlug：非 CF 光影链接一律 null', () => {
  it('Modrinth 链接', () => {
    assert.equal(parseCurseforgeSlug('https://modrinth.com/shader/bsl-shaders'), null)
  })

  it('CF 的非 shader 分类（mc-mods）', () => {
    assert.equal(parseCurseforgeSlug('https://www.curseforge.com/minecraft/mc-mods/jei'), null)
    assert.equal(parseCurseforgeSlug('https://www.curseforge.com/minecraft/texture-packs/foo'), null)
  })

  it('随机字符串与空值', () => {
    assert.equal(parseCurseforgeSlug('bsl-shaders'), null)
    assert.equal(parseCurseforgeSlug('https://example.com/minecraft/shaders/bsl-shaders'), null)
    assert.equal(parseCurseforgeSlug('https://www.curseforge.com/minecraft/shaders/'), null)
    assert.equal(parseCurseforgeSlug(''), null)
    assert.equal(parseCurseforgeSlug(undefined), null)
    assert.equal(parseCurseforgeSlug(null), null)
    assert.equal(parseCurseforgeSlug(42), null)
  })

  it('非法百分号转义：返回 null 而不是抛', () => {
    assert.equal(parseCurseforgeSlug('https://www.curseforge.com/minecraft/shaders/%E0%A4%A'), null)
  })

  it('非 http(s) 协议', () => {
    assert.equal(parseCurseforgeSlug('ftp://www.curseforge.com/minecraft/shaders/bsl-shaders'), null)
  })
})

describe('parseModrinthSlug：原行为不变', () => {
  it('shader / shaderpack 路径都解析', () => {
    assert.equal(parseModrinthSlug('https://modrinth.com/shader/bsl-shaders'), 'bsl-shaders')
    assert.equal(parseModrinthSlug('https://modrinth.com/shaderpack/bsl-shaders?x=1'), 'bsl-shaders')
  })

  it('仍只接受 https', () => {
    assert.equal(parseModrinthSlug('http://modrinth.com/shader/bsl-shaders'), null)
  })

  it('CF 链接不被 Modrinth 解析器接受', () => {
    assert.equal(parseModrinthSlug('https://www.curseforge.com/minecraft/shaders/bsl-shaders'), null)
  })
})
