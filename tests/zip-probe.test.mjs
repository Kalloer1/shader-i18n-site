#!/usr/bin/env node
/**
 * scripts/lib/zip-probe.mjs 的离线单元测试（不发任何网络请求）。
 *
 * 探测阶段是「下载整包之前」的一道判定，它的判据必须与整包路径**完全一致**，
 * 否则会把「需要翻译」的包误判成终态、少下载一个包就少出一份汉化。
 * 这里锁三件事：
 * 1. classifyLangNames 的判定与 translateFromZip 的判定顺序一致（zh 优先，其次 en_US）；
 * 2. 判据直接来自 lib/lang-source.mjs，不另写一套正则（用真实路径语料对拍）；
 * 3. probeZipTerminalState 在任何异常下都返回 UNKNOWN，绝不把错误当成终态。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isEnUsLangPath, isLangFilePath, isZhCNLangPath } from '../scripts/lib/lang-source.mjs'
import { PROBE_VERDICT, classifyLangNames, probeZipTerminalState } from '../scripts/lib/zip-probe.mjs'

describe('classifyLangNames：只用条目名判定终态', () => {
  it('含 zh_CN.lang → 自带中文（即使同时有 en_US.lang）', () => {
    const r = classifyLangNames(['shaders/lang/en_US.lang', 'shaders/lang/zh_CN.lang'])
    assert.equal(r.verdict, PROBE_VERDICT.NATIVE_ZH)
    assert.deepEqual(r.langNames, ['shaders/lang/en_US.lang', 'shaders/lang/zh_CN.lang'])
  })

  it('CF 外层目录 + 小写 zh_cn 也算自带中文', () => {
    const r = classifyLangNames(['SolisLite/shaders/lang/zh_cn.lang'])
    assert.equal(r.verdict, PROBE_VERDICT.NATIVE_ZH)
  })

  it('只有 en_US.lang → 需要翻译，并给出 enName', () => {
    const r = classifyLangNames(['shaders/shaders.json', 'shaders/lang/en_US.lang'])
    assert.equal(r.verdict, PROBE_VERDICT.NEEDS_TRANSLATION)
    assert.equal(r.enName, 'shaders/lang/en_US.lang')
  })

  it('en_us 小写同样认作英文源（与 isEnUsLangPath 一致）', () => {
    const r = classifyLangNames(['X/shaders/lang/en_us.lang'])
    assert.equal(r.verdict, PROBE_VERDICT.NEEDS_TRANSLATION)
    assert.equal(r.enName, 'X/shaders/lang/en_us.lang')
  })

  it('没有任何语言文件 → 无 en_US.lang（终态），langNames 为空', () => {
    const r = classifyLangNames(['shaders/shaders.json', 'shaders/program/gbuffers.vsh'])
    assert.equal(r.verdict, PROBE_VERDICT.NO_EN_US)
    assert.deepEqual(r.langNames, [])
    assert.equal(r.enName, null)
  })

  it('只有其他语种 → 无 en_US.lang，langNames 如实列出', () => {
    const r = classifyLangNames(['shaders/lang/ru_RU.lang', 'shaders/lang/ja_JP.lang'])
    assert.equal(r.verdict, PROBE_VERDICT.NO_EN_US)
    assert.deepEqual(r.langNames, ['shaders/lang/ru_RU.lang', 'shaders/lang/ja_JP.lang'])
  })

  it('更深一层 / shaders 与 lang 不相邻 → 不算语言文件（不会误判成自带中文）', () => {
    const r = classifyLangNames(['shaders/lang/sub/zh_CN.lang', 'foo/shaders/x/lang/en_US.lang'])
    assert.equal(r.verdict, PROBE_VERDICT.NO_EN_US)
    assert.deepEqual(r.langNames, [])
  })

  it('对拍：判据与 translateFromZip 的 filter/some/find 完全同源', () => {
    const corpus = [
      'shaders/lang/zh_CN.lang',
      'shaders/lang/zh_cn.lang',
      'SolisLite/shaders/lang/zh_CN.lang',
      'shaders/lang/en_US.lang',
      'shaders/lang/en_us.lang',
      'SolisLite/shaders/lang/en_us.lang',
      'shaders/LANG/en_US.lang',
      'shaders/lang/ru_RU.lang',
      'shaders/lang/sub/en_US.lang',
      'shaders/lang/en_US.lang.bak',
      'lang/en_US.lang',
      'shaders/lang',
    ]
    // 参照实现：与 scripts/pipeline.mjs 的 translateFromZip 前 8 行逐字同构。
    const reference = (names) => {
      const langNames = names.filter(isLangFilePath)
      if (langNames.some(isZhCNLangPath)) return 'native-zh'
      return langNames.find(isEnUsLangPath) ? 'needs-translation' : 'no-en-us'
    }
    for (const name of corpus) {
      const single = classifyLangNames([name]).verdict
      assert.equal(single, reference([name]), `单条路径判定不一致：${name}`)
    }
    // 组合语料：逐个子集与参照实现对拍，确保顺序语义（zh 优先）一致。
    for (let mask = 0; mask < 1 << corpus.length; mask++) {
      const names = corpus.filter((_, i) => mask & (1 << i))
      if (names.length > 6) continue // 限制组合规模，覆盖 0/1/2/3+ 条即可
      assert.equal(classifyLangNames(names).verdict, reference(names), `组合判定不一致：${names.join(' | ')}`)
    }
  })
})

describe('probeZipTerminalState：异常一律回退，绝不误判终态', () => {
  const names = ['shaders/lang/zh_CN.lang']
  const headers = { 'User-Agent': 'test-agent' }
  const signal = new AbortController().signal

  it('openZip 返回 range 模式：把 names 分类并把 zip 透传回去', async () => {
    const zip = { names, fetchMode: 'range', bytesDownloaded: 65536 }
    const calls = []
    const openZip = async (url, opts) => {
      calls.push({ url, opts })
      return zip
    }
    const r = await probeZipTerminalState({ openZip, url: 'https://x.test/a.zip', totalSize: 1234, headers, signal })
    assert.equal(r.verdict, PROBE_VERDICT.NATIVE_ZH)
    assert.equal(r.zip, zip)
    assert.deepEqual(calls, [{ url: 'https://x.test/a.zip', opts: { totalSize: 1234, headers, signal } }])
  })

  it('openZip 内部已回退整包：如实反映 fetchMode（调用方据此避免重复下载）', async () => {
    const zip = { names: ['shaders/lang/en_US.lang'], fetchMode: 'full', bytesDownloaded: 999 }
    const r = await probeZipTerminalState({
      openZip: async () => zip,
      url: 'https://x.test/a.zip',
      totalSize: 999,
      headers,
      signal,
    })
    assert.equal(r.verdict, PROBE_VERDICT.NEEDS_TRANSLATION)
    assert.equal(r.zip.fetchMode, 'full')
  })

  it('openZip 抛错 → UNKNOWN，不抛、不判终态，并把原因带出去', async () => {
    const err = new Error('网络炸了')
    const logs = []
    const r = await probeZipTerminalState({
      openZip: async () => {
        throw err
      },
      url: 'https://x.test/a.zip',
      totalSize: 1234,
      headers,
      signal,
      log: (m) => logs.push(m),
    })
    assert.equal(r.verdict, PROBE_VERDICT.UNKNOWN)
    assert.equal(r.error, err)
    assert.equal(r.zip, undefined)
    assert.match(logs.join('\n'), /探测失败.*网络炸了/)
  })

  it('openZip 返回异常形状（names 缺失）→ UNKNOWN，不当成「无 en_US.lang」', async () => {
    const r = await probeZipTerminalState({
      openZip: async () => ({ fetchMode: 'range' }),
      url: 'https://x.test/a.zip',
      totalSize: 1234,
      headers,
      signal,
    })
    assert.equal(r.verdict, PROBE_VERDICT.UNKNOWN)
  })
})
