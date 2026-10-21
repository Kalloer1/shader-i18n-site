#!/usr/bin/env node
/**
 * 「无英文源」黑名单的离线单测（scripts/lib/blacklist.mjs）。
 *
 * 背景：旧实现只写 `noEnUsLang: true`，不记版本 —— 上游后来补了 en_US.lang、发了新版本，
 * 流水线也永远跳过（439 个条目）。新约定：黑名单只存「id + 判定版本」，版本变了就重探。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_EN_US_FIELD,
  NO_EN_US_VERSION_FIELD,
  carryOverBlacklist,
  clearNoEnUsLang,
  isBlacklistedForVersion,
  markNoEnUsLang,
} from '../scripts/lib/blacklist.mjs'

describe('markNoEnUsLang：只写标记与版本号两个字段', () => {
  it('写入标记与版本', () => {
    const entry = { id: 'a' }
    markNoEnUsLang(entry, '1.2.3')
    assert.deepEqual(entry, { id: 'a', noEnUsLang: true, noEnUsLangVersion: '1.2.3' })
  })

  it('不加任何别的字段（checkedAt / fileName / 时间戳都不允许）', () => {
    const entry = { id: 'a' }
    markNoEnUsLang(entry, '1.2.3')
    assert.deepEqual(Object.keys(entry).sort(), ['id', 'noEnUsLang', 'noEnUsLangVersion'])
  })

  it('版本缺失时只写标记（与历史数据同形，下次会重探）', () => {
    const entry = { id: 'a' }
    markNoEnUsLang(entry, undefined)
    assert.deepEqual(entry, { id: 'a', noEnUsLang: true })
  })

  it('空字符串版本不写（避免留下既非有也非无的脏值）', () => {
    const entry = {}
    markNoEnUsLang(entry, '')
    assert.equal(NO_EN_US_VERSION_FIELD in entry, false)
  })

  it('版本号统一转成字符串（CF 派生版本 / Modrinth version_number 都是字符串）', () => {
    const entry = {}
    markNoEnUsLang(entry, 42)
    assert.equal(entry.noEnUsLangVersion, '42')
  })
})

describe('isBlacklistedForVersion：版本相同才跳过', () => {
  it('没标记 → 不跳过', () => {
    assert.equal(isBlacklistedForVersion({ id: 'a' }, '1.0'), false)
    assert.equal(isBlacklistedForVersion(undefined, '1.0'), false)
    assert.equal(isBlacklistedForVersion(null, '1.0'), false)
  })

  it('标记 + 版本相同 → 跳过（旧结论仍成立）', () => {
    assert.equal(isBlacklistedForVersion({ noEnUsLang: true, noEnUsLangVersion: '1.0' }, '1.0'), true)
  })

  it('标记 + 版本不同 → 重新探测（上游可能补了 en_US.lang）', () => {
    assert.equal(isBlacklistedForVersion({ noEnUsLang: true, noEnUsLangVersion: '1.0' }, '1.1'), false)
  })

  it('标记但没有版本号（历史数据）→ 重新探测', () => {
    // 不猜：lastSync 是同步日期，不是光影版本，拿它比对必然误判。
    assert.equal(isBlacklistedForVersion({ noEnUsLang: true }, '1.0'), false)
    assert.equal(isBlacklistedForVersion({ noEnUsLang: true, noEnUsLangVersion: '' }, '1.0'), false)
  })

  it('拿不到当前版本 → 重新探测（宁可多探一次，不能少判）', () => {
    assert.equal(isBlacklistedForVersion({ noEnUsLang: true, noEnUsLangVersion: '1.0' }, undefined), false)
    assert.equal(isBlacklistedForVersion({ noEnUsLang: true, noEnUsLangVersion: '1.0' }, ''), false)
  })

  it('标记为 false / 非 true 值不算黑名单', () => {
    assert.equal(isBlacklistedForVersion({ noEnUsLang: false, noEnUsLangVersion: '1.0' }, '1.0'), false)
    assert.equal(isBlacklistedForVersion({ noEnUsLang: 'true', noEnUsLangVersion: '1.0' }, '1.0'), false)
  })

  it('数字与字符串版本按值比较', () => {
    assert.equal(isBlacklistedForVersion({ noEnUsLang: true, noEnUsLangVersion: 7 }, '7'), true)
  })
})

describe('clearNoEnUsLang：重探发现英文源时清掉过期结论', () => {
  it('两个字段一起删', () => {
    const entry = { id: 'a', noEnUsLang: true, noEnUsLangVersion: '1.0' }
    clearNoEnUsLang(entry)
    assert.deepEqual(entry, { id: 'a' })
  })

  it('幂等：没标记时调用不抛错', () => {
    const entry = { id: 'a' }
    clearNoEnUsLang(entry)
    assert.deepEqual(entry, { id: 'a' })
    assert.equal(clearNoEnUsLang(undefined), undefined)
  })
})

describe('carryOverBlacklist：每日同步时两个字段一起保留', () => {
  it('标记 + 版本 → 两个字段都带过去', () => {
    assert.deepEqual(
      carryOverBlacklist({ id: 'a', noEnUsLang: true, noEnUsLangVersion: '1.0', lastSync: '2026-10-18' }),
      { noEnUsLang: true, noEnUsLangVersion: '1.0' },
    )
  })

  it('只带标记不带版本 = 把版本判据退化成永久跳过（必须保留版本）', () => {
    const carried = carryOverBlacklist({ noEnUsLang: true, noEnUsLangVersion: '1.0' })
    assert.equal(carried.noEnUsLangVersion, '1.0', '丢了版本号，下次会按「未知版本」重探，等于白探')
  })

  it('历史条目（无版本号）原样保留标记，不带空版本键', () => {
    const carried = carryOverBlacklist({ noEnUsLang: true })
    assert.deepEqual(carried, { noEnUsLang: true })
  })

  it('未标记 → 空对象（展开进新条目时不多出键）', () => {
    assert.deepEqual(carryOverBlacklist({ id: 'a' }), {})
    assert.deepEqual(carryOverBlacklist(undefined), {})
    assert.deepEqual(carryOverBlacklist({ noEnUsLang: false }), {})
  })

  it('字段名常量与站点/脚本使用的字符串一致', () => {
    assert.equal(NO_EN_US_FIELD, 'noEnUsLang')
    assert.equal(NO_EN_US_VERSION_FIELD, 'noEnUsLangVersion')
  })
})
