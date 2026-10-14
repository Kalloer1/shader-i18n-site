#!/usr/bin/env node
/**
 * scripts/lib/cf.mjs CurseForge 约定的离线单元测试。
 *
 * 覆盖版本号清洗、id 派生、候选池筛选、条目骨架与 source 判定。
 * 不发任何网络请求。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  cfVersionFromFileName,
  cfShaderId,
  pickCfCandidates,
  buildShaderEntry,
  isCurseforgeEntry,
  isApiDownloadBlocked,
} from '../scripts/lib/cf.mjs'

describe('cfVersionFromFileName 版本号清洗', () => {
  it('普通名：去 .zip 扩展名', () => {
    assert.equal(cfVersionFromFileName('SolisLite_0.1.0_BETA_26.x.zip'), 'cf-SolisLite_0.1.0_BETA_26.x')
  })

  it('.ZIP 大写后缀同样去掉', () => {
    assert.equal(cfVersionFromFileName('shader v1.ZIP'), 'cf-shader-v1')
  })

  it('含空格：替换为 -', () => {
    assert.equal(cfVersionFromFileName('My Shader v1.2.zip'), 'cf-My-Shader-v1.2')
  })

  it('含中文：保留中文，仍是安全目录名', () => {
    assert.equal(cfVersionFromFileName('我的 光影 v1.2.zip'), 'cf-我的-光影-v1.2')
  })

  it('含 ..：结果不得出现 ..', () => {
    const v = cfVersionFromFileName('foo..bar_v1.zip', 1)
    assert.equal(v.includes('..'), false)
  })

  it('含 / 与 \\：替换为 -，结果不得出现', () => {
    for (const name of ['a/b_1.0.zip', 'a\\b_1.0.zip']) {
      const v = cfVersionFromFileName(name, 1)
      assert.equal(v.includes('/'), false)
      assert.equal(v.includes('\\'), false)
    }
  })

  it('空文件名回退为 cf-file-<fileId>', () => {
    assert.equal(cfVersionFromFileName('', 42), 'cf-file-42')
    assert.equal(cfVersionFromFileName('.zip', 7), 'cf-file-7')
  })

  it('超长名截断到 80 且末尾不是 . / -', () => {
    const v = cfVersionFromFileName(`${'a'.repeat(100)}.zip`, 1)
    assert.ok(v.length <= 80, `实际长度 ${v.length}`)
    assert.ok(!v.endsWith('.') && !v.endsWith('-'))
  })

  it('foo.zip.zip 只去一层', () => {
    assert.equal(cfVersionFromFileName('foo.zip.zip'), 'cf-foo.zip')
  })

  it('清洗结果始终是安全目录名', () => {
    for (const name of ['a..b.zip', 'a/b.zip', 'a\\b.zip', '...', 'a-.zip', '.hidden.zip']) {
      const v = cfVersionFromFileName(name, 9)
      assert.ok(v.length > 0, `${name} -> 空`)
      assert.ok(!v.includes('/') && !v.includes('\\'), `${name} -> ${v}`)
      assert.ok(!v.includes('..'), `${name} -> ${v}`)
      assert.ok(!v.endsWith('.'), `${name} -> ${v}`)
    }
  })
})

describe('cfShaderId id 派生', () => {
  it('正常 slug 原样返回', () => {
    assert.equal(cfShaderId({ slug: 'solis-lite' }), 'solis-lite')
  })

  it('缺 slug 抛错', () => {
    assert.throws(() => cfShaderId({}), /slug/)
    assert.throws(() => cfShaderId({ slug: '' }), /slug/)
    assert.throws(() => cfShaderId(undefined), /slug/)
  })
})

describe('pickCfCandidates 候选池', () => {
  const catalog = [
    { cfId: 1, slug: 'a', downloads: 100 },
    { cfId: 2, slug: 'b', downloads: 300 },
    { cfId: 3, slug: 'c', downloads: 200 },
    { cfId: 4, slug: 'zero', downloads: 0 },
    { cfId: 5, slug: 'nodl' },
  ]

  it('按 downloads 降序且 limit 生效', () => {
    const picked = pickCfCandidates(catalog, [], 2)
    assert.deepEqual(picked.map((e) => e.slug), ['b', 'c'])
  })

  it('已翻译的按 id === slug 被排除', () => {
    const picked = pickCfCandidates(catalog, [{ id: 'b', modrinth: {} }], 10)
    assert.equal(picked.some((e) => e.slug === 'b'), false)
  })

  it('已翻译的按 curseforge.slug === slug 被排除', () => {
    const picked = pickCfCandidates(catalog, [{ curseforge: { slug: 'a', cfId: 1 } }], 10)
    assert.equal(picked.some((e) => e.slug === 'a'), false)
  })

  it('已翻译的按 curseforge.cfId === cfId 被排除', () => {
    const picked = pickCfCandidates(catalog, [{ curseforge: { slug: 'x', cfId: 2 } }], 10)
    assert.equal(picked.some((e) => e.slug === 'b'), false)
  })

  it('downloads 为 0 或缺失的被排除', () => {
    const picked = pickCfCandidates(catalog, [], 10)
    assert.ok(picked.every((e) => e.downloads > 0))
  })

  it('返回值只含 CF 条目', () => {
    const picked = pickCfCandidates(catalog, [], 10)
    assert.ok(picked.every((e) => typeof e.slug === 'string' && typeof e.cfId === 'number'))
  })

  it('allowModDistribution === false 的被排除（作者禁止 API 分发）', () => {
    const blocked = [{ cfId: 9, slug: 'blocked', downloads: 999, allowModDistribution: false }]
    assert.deepEqual(pickCfCandidates(blocked, [], 10), [])
    // 与正常条目混排时只排除被禁的，排序不受影响
    const picked = pickCfCandidates(
      [...blocked, { cfId: 10, slug: 'ok', downloads: 1, allowModDistribution: true }],
      [],
      10,
    )
    assert.deepEqual(picked.map((e) => e.slug), ['ok'])
  })

  it('allowModDistribution === true 的被保留', () => {
    const picked = pickCfCandidates([{ cfId: 11, slug: 'yes', downloads: 5, allowModDistribution: true }], [], 10)
    assert.deepEqual(picked.map((e) => e.slug), ['yes'])
  })

  it('allowModDistribution 缺失（undefined）的被保留（未采集不误伤）', () => {
    const picked = pickCfCandidates([{ cfId: 12, slug: 'unknown', downloads: 5 }], [], 10)
    assert.deepEqual(picked.map((e) => e.slug), ['unknown'])
  })
})

describe('isApiDownloadBlocked 分发许可判定', () => {
  it('只有明确为 false 才算禁止', () => {
    assert.equal(isApiDownloadBlocked({ allowModDistribution: false }), true)
    assert.equal(isApiDownloadBlocked({ allowModDistribution: true }), false)
    assert.equal(isApiDownloadBlocked({}), false)
    assert.equal(isApiDownloadBlocked({ allowModDistribution: undefined }), false)
    assert.equal(isApiDownloadBlocked(undefined), false)
  })
})

describe('buildShaderEntry 条目骨架', () => {
  it('CF：id=slug + source + curseforge，不含 modrinth', () => {
    const entry = buildShaderEntry({ source: 'curseforge', slug: 'solis-lite', cfId: 123 })
    assert.deepEqual(entry, {
      id: 'solis-lite',
      source: 'curseforge',
      curseforge: { slug: 'solis-lite', cfId: 123 },
      langVersions: [],
    })
    assert.equal('modrinth' in entry, false)
  })

  it('Modrinth：id + modrinth，不带 source: curseforge', () => {
    const entry = buildShaderEntry({ modrinth: { slug: 'solis-lite', projectId: 'abc' } })
    assert.deepEqual(entry, {
      id: 'solis-lite',
      modrinth: { slug: 'solis-lite', projectId: 'abc' },
      langVersions: [],
    })
    assert.equal(entry.source, undefined)
    assert.equal('curseforge' in entry, false)
  })
})

describe('isCurseforgeEntry', () => {
  it('按 entry.source === curseforge 判定', () => {
    assert.equal(isCurseforgeEntry({ source: 'curseforge' }), true)
    assert.equal(isCurseforgeEntry({ source: 'modrinth' }), false)
    assert.equal(isCurseforgeEntry({}), false)
    assert.equal(isCurseforgeEntry(undefined), false)
  })
})