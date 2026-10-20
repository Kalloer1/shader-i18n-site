#!/usr/bin/env node
/**
 * scripts/lib/probe-candidates.mjs 的离线单测 + scripts/probe-candidates.mjs 的端到端测试。
 *
 * 单测部分：纯函数（选候选、条目计数、单包判定、汇总），不发网络。
 * e2e 部分：本地假 Modrinth + 会 Range 的假 zip 服务，真跑 CLI 子进程，验证：
 * - 五种判定（translatable / native-zh / no-en / too-small / probe-failed）都能落到输出；
 * - **探测命中时没有下载整包**（统计假服务器收到的字节数与整包请求数）；
 * - openZip 内部回退整包时 fetchMode=full 被如实记录；
 * - 单条失败不中断整批；
 * - 脚本只读（不碰 site/data、site/public/lang）。
 */
import { describe, it, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_MIN_EN_ENTRIES,
  PROBE_STATUS,
  RANGE_MIN_BYTES,
  countLangEntries,
  fullModeReason,
  probeOne,
  runProbeCandidates,
  selectCandidates,
  summarize,
} from '../scripts/lib/probe-candidates.mjs'
import { PROBE_VERDICT, classifyLangNames } from '../scripts/lib/zip-probe.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------- 最小 zip（Stored） ----------
function crc32(buf) {
  let c, crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

function makeZip(files, { padTo = 0 } = {}) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8')
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const localBuf = Buffer.concat(locals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(localBuf.length, 16)

  let body = Buffer.concat([localBuf, centralBuf, eocd])
  if (padTo > body.length) {
    const padLen = padTo - body.length
    const padded = Buffer.alloc(padTo)
    body.copy(padded, padLen)
    padded.writeUInt32LE(localBuf.length + padLen, padded.length - 22 + 16)
    let p = padLen + localBuf.length
    for (let i = 0; i < Object.keys(files).length; i++) {
      const nameLen = padded.readUInt16LE(p + 28)
      const extraLen = padded.readUInt16LE(p + 30)
      const commentLen = padded.readUInt16LE(p + 32)
      padded.writeUInt32LE(padded.readUInt32LE(p + 42) + padLen, p + 42)
      p += 46 + nameLen + extraLen + commentLen
    }
    body = padded
  }
  return body
}

// ---------- 纯函数 ----------

describe('countLangEntries：可翻条目与流水线同口径', () => {
  it('注释、空行、无等号的行都不算条目', () => {
    const text = [
      '# comment',
      '',
      'option.A=Alpha',
      'option.B=Beta',
      'no equals here',
      '=only value',
      'option.C=Gamma',
    ].join('\n') + '\n'
    assert.deepEqual(countLangEntries(text), { lines: 7, entries: 3 })
  })

  it('空文件是 0 行 0 条', () => {
    assert.deepEqual(countLangEntries(''), { lines: 0, entries: 0 })
  })

  it('没有结尾换行时行数不少算', () => {
    assert.deepEqual(countLangEntries('a=1\nb=2'), { lines: 2, entries: 2 })
  })
})

describe('selectCandidates：只排「已有汉化」与「已知自带中文」', () => {
  const catalog = {
    shaders: [
      { id: 'a', title: 'A', downloads: 300, projectId: 'pa' },
      { id: 'b', title: 'B', downloads: 500, projectId: 'pb', hasNativeZhCN: true },
      { id: 'c', title: 'C', downloads: 100, projectId: 'pc', noEnUsLang: true },
      { id: 'd', title: 'D', downloads: 200, projectId: 'pd' },
    ],
  }
  const db = { shaders: [{ id: 'd', langVersions: [{ shaderVersion: '1.0' }] }] }

  it('按下载量降序，排除已有汉化与已知自带中文；noEnUsLang 不排除（可能是旧结论）', () => {
    const picked = selectCandidates({ catalog, db, limit: 50 })
    assert.deepEqual(picked.map((x) => x.id), ['a', 'c'])
    assert.equal(picked[0].downloads, 300)
  })

  it('--ids 只保留指定 id，并按下载量排序', () => {
    const picked = selectCandidates({ catalog, db, ids: ['c', 'a'], limit: 50 })
    assert.deepEqual(picked.map((x) => x.id), ['a', 'c'])
  })

  it('--ids 命中已汉化条目时也会被排除', () => {
    assert.deepEqual(selectCandidates({ catalog, db, ids: ['d'] }), [])
  })

  it('limit 截断', () => {
    assert.equal(selectCandidates({ catalog, db, limit: 1 }).length, 1)
  })
})

describe('probeOne：五种判定的纯逻辑（stub openZip）', () => {
  const mkZip = (names, readImpl) => async () => ({ names, fetchMode: 'range', bytesDownloaded: 65536, read: readImpl })

  it('有 zh_CN.lang → native-zh，不读任何条目', async () => {
    let reads = 0
    const r = await probeOne({
      openZip: mkZip(['shaders/lang/en_US.lang', 'shaders/lang/zh_CN.lang'], async () => {
        reads++
        return Buffer.from('x=1\n')
      }),
      url: 'https://x.test/a.zip',
      totalSize: 100000,
    })
    assert.equal(r.status, PROBE_STATUS.NATIVE_ZH)
    assert.equal(reads, 0, '自带中文不该读条目')
    assert.equal(r.fetchMode, 'range')
  })

  it('无 en_US.lang → no-en', async () => {
    const r = await probeOne({
      openZip: mkZip(['shaders/lang/ru_RU.lang'], async () => null),
      url: 'https://x.test/a.zip',
      totalSize: 100000,
    })
    assert.equal(r.status, PROBE_STATUS.NO_EN)
    assert.deepEqual(r.langNames, ['shaders/lang/ru_RU.lang'])
  })

  it('有 en_US.lang 但条目不足 → too-small', async () => {
    const r = await probeOne({
      openZip: mkZip(['shaders/lang/en_US.lang'], async () => Buffer.from('option.A=Alpha\noption.B=Beta\n')),
      url: 'https://x.test/a.zip',
      totalSize: 100000,
      minEntries: 3,
    })
    assert.equal(r.status, PROBE_STATUS.TOO_SMALL)
    assert.equal(r.enEntries, 2)
    assert.equal(r.enLines, 2)
  })

  it('条目达标 → translatable', async () => {
    const en = Array.from({ length: 12 }, (_, i) => `option.K${i}=Value ${i}`).join('\n') + '\n'
    const r = await probeOne({
      openZip: mkZip(['shaders/lang/en_US.lang'], async () => Buffer.from(en)),
      url: 'https://x.test/a.zip',
      totalSize: 100000,
    })
    assert.equal(r.status, PROBE_STATUS.TRANSLATABLE)
    assert.equal(r.enEntries, 12)
    assert.equal(r.enName, 'shaders/lang/en_US.lang')
  })

  it('openZip 抛错 → probe-failed（不抛出去）', async () => {
    const r = await probeOne({
      openZip: async () => {
        throw new Error('boom')
      },
      url: 'https://x.test/a.zip',
      totalSize: 100000,
    })
    assert.equal(r.status, PROBE_STATUS.PROBE_FAILED)
    assert.match(r.error, /boom/)
  })

  it('中央目录说有、实际读不到 → probe-failed（不当成 no-en）', async () => {
    const r = await probeOne({
      openZip: mkZip(['shaders/lang/en_US.lang'], async () => null),
      url: 'https://x.test/a.zip',
      totalSize: 100000,
    })
    assert.equal(r.status, PROBE_STATUS.PROBE_FAILED)
  })

  it('read() 期间回退整包：fetchMode 如实变成 full', async () => {
    const zip = {
      names: ['shaders/lang/en_US.lang'],
      fetchMode: 'range',
      bytesDownloaded: 65536,
      async read() {
        zip.fetchMode = 'full'
        zip.bytesDownloaded += 900000
        return Buffer.from(Array.from({ length: 11 }, (_, i) => `k${i}=v${i}`).join('\n'))
      },
    }
    const r = await probeOne({ openZip: async () => zip, url: 'https://x.test/a.zip', totalSize: 1000000 })
    assert.equal(r.status, PROBE_STATUS.TRANSLATABLE)
    assert.equal(r.fetchMode, 'full')
    assert.equal(r.downloadedBytes, 65536 + 900000)
  })

  it('判据与 classifyLangNames 同源（含 CF 外层目录）', async () => {
    const r = await probeOne({
      openZip: mkZip(['Pack/shaders/lang/zh_cn.lang'], async () => null),
      url: 'https://x.test/a.zip',
      totalSize: 100000,
    })
    assert.equal(r.status, PROBE_STATUS.NATIVE_ZH)
    assert.equal(classifyLangNames(['Pack/shaders/lang/zh_cn.lang']).verdict, PROBE_VERDICT.NATIVE_ZH)
  })
})

describe('runProbeCandidates + summarize', () => {
  it('单条失败不中断整批；结果与 items 同序；汇总计数正确', async () => {
    const items = [
      { id: 'ok', title: 'OK', downloads: 3, projectId: 'p-ok' },
      { id: 'bad', title: 'BAD', downloads: 2, projectId: 'p-bad' },
      { id: 'native', title: 'N', downloads: 1, projectId: 'p-native' },
    ]
    const zips = {
      'https://x.test/ok.zip': { names: ['shaders/lang/en_US.lang'], fetchMode: 'range', bytesDownloaded: 1000, read: async () => Buffer.from('a=1\nb=2\nc=3\n') },
      'https://x.test/native.zip': { names: ['shaders/lang/zh_CN.lang'], fetchMode: 'range', bytesDownloaded: 800, read: async () => null },
    }
    const rows = await runProbeCandidates({
      items,
      getLatestFile: async (projectId) => {
        if (projectId === 'p-bad') throw new Error('元数据炸了')
        return { url: `https://x.test/${projectId.replace('p-', '')}.zip`, size: 5000, version: '1.0' }
      },
      openZip: async (url) => zips[url],
      concurrency: 3,
      minEntries: 1,
    })
    assert.deepEqual(rows.map((r) => r.id), ['ok', 'bad', 'native'])
    assert.equal(rows[0].status, PROBE_STATUS.TRANSLATABLE)
    assert.equal(rows[1].status, PROBE_STATUS.PROBE_FAILED)
    assert.match(rows[1].error, /元数据炸了/)
    assert.equal(rows[2].status, PROBE_STATUS.NATIVE_ZH)

    const s = summarize(rows)
    assert.equal(s.total, 3)
    assert.equal(s.byStatus.translatable, 1)
    assert.equal(s.byStatus['probe-failed'], 1)
    assert.equal(s.byStatus['native-zh'], 1)
    assert.equal(s.fallbackFull, 0)
    assert.deepEqual(s.translatable.map((x) => x.id), ['ok'])
    assert.equal(s.downloadedBytes, 1800)
    assert.equal(s.packBytes, 10000)
  })

  it('回退整包单独统计', () => {
    const s = summarize([
      { status: PROBE_STATUS.TRANSLATABLE, fetchMode: 'full', downloadedBytes: 900000, packBytes: 900000 },
      { status: PROBE_STATUS.NATIVE_ZH, fetchMode: 'range', downloadedBytes: 65536, packBytes: 900000 },
    ])
    assert.equal(s.fallbackFull, 1)
    assert.equal(s.belowThresholdFull, 0)
    assert.equal(s.savedPct, 46.4) // 1 - (965536 / 1800000)
  })

  it('full 模式的两种原因分开统计：包太小 ≠ 回退', () => {
    // 真实样本里 16 个 fetchMode=full 大多是小包（几千字节），按设计直接整包，不该算回退。
    assert.equal(fullModeReason({ fetchMode: 'full', packBytes: 20733 }), 'below-threshold')
    assert.equal(fullModeReason({ fetchMode: 'full', packBytes: 65536 }), 'fallback', '等于阈值应走 Range，故算回退')
    assert.equal(fullModeReason({ fetchMode: 'full', packBytes: 6_000_000 }), 'fallback')
    assert.equal(fullModeReason({ fetchMode: 'range', packBytes: 6_000_000 }), 'range')
    assert.equal(fullModeReason({}), 'unknown')

    const s = summarize([
      { status: PROBE_STATUS.NO_EN, fetchMode: 'full', downloadedBytes: 5000, packBytes: 5000 },
      { status: PROBE_STATUS.NO_EN, fetchMode: 'full', downloadedBytes: 900000, packBytes: 900000 },
    ])
    assert.equal(s.fallbackFull, 1, '只有 900KB 那个是真回退')
    assert.equal(s.belowThresholdFull, 1)
  })
})

// ---------- 端到端：真跑 CLI ----------

const EN_BIG = Array.from({ length: 20 }, (_, i) => `option.K${i}=Value ${i}`).join('\n') + '\n'
const PAD = 400000
const ZIPS = {
  big: makeZip({ 'shaders/lang/en_US.lang': EN_BIG }, { padTo: PAD }),
  native: makeZip({ 'shaders/lang/en_US.lang': EN_BIG, 'shaders/lang/zh_CN.lang': 'option.K0=值\n' }, { padTo: PAD }),
  noen: makeZip({ 'shaders/lang/ru_RU.lang': 'option.K0=Значение\n' }, { padTo: PAD }),
  tiny: makeZip({ 'shaders/lang/en_US.lang': '# only\noption.K0=One\noption.K1=Two\n' }, { padTo: PAD }),
  broken: Buffer.from('this is not a zip at all'),
}

async function startFakeServer(state) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, state.baseUrl)
    const json = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname.endsWith('/version') && url.pathname.startsWith('/v2/project/')) {
      const projectId = decodeURIComponent(url.pathname.split('/')[3])
      if (state.failVersions.has(projectId)) {
        res.writeHead(500)
        return res.end('boom')
      }
      const key = state.projectToZip[projectId]
      return json([{
        version_number: '1.0.0',
        files: [{ primary: true, url: `${state.baseUrl}/download/${key}.zip`, filename: `${key}.zip`, size: ZIPS[key].length }],
      }])
    }
    if (url.pathname.startsWith('/download/')) {
      const key = url.pathname.slice('/download/'.length).replace(/\.zip$/, '')
      const buf = ZIPS[key]
      const range = req.headers.range
      const record = { key, range: range ?? null, bytes: 0, status: 0 }
      state.zipRequests.push(record)
      if (range && state.rangeMode) {
        const m = /^bytes=(\d+)-(\d+)$/.exec(range)
        const start = Number(m[1])
        const end = Math.min(Number(m[2]), buf.length - 1)
        const slice = buf.subarray(start, end + 1)
        record.status = 206
        record.bytes = slice.length
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${buf.length}`,
          'Content-Length': String(slice.length),
        })
        return res.end(slice)
      }
      record.status = 200
      record.bytes = buf.length
      res.writeHead(200, { 'Content-Length': String(buf.length) })
      return res.end(buf)
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  state.baseUrl = `http://127.0.0.1:${server.address().port}`
  return server
}

function makeRepo(projects) {
  const dir = mkdtempSync(join(tmpdir(), 'probe-candidates-e2e-'))
  cpSync(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true })
  cpSync(join(ROOT, 'shared'), join(dir, 'shared'), { recursive: true })
  mkdirSync(join(dir, 'site/data'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'e2e', type: 'module', private: true }))
  writeFileSync(
    join(dir, 'site/data/modrinth-catalog.json'),
    JSON.stringify({
      shaders: projects.map((p) => ({ id: p.id, projectId: p.projectId, title: p.title, downloads: p.downloads })),
    }),
  )
  writeFileSync(join(dir, 'site/data/shaders.json'), JSON.stringify({ shaders: [] }))
  writeFileSync(join(dir, 'site/data/glossary.json'), JSON.stringify({}))
  return dir
}

function runCli(repo, state, args) {
  const env = { ...process.env }
  for (const k of ['HTTPS_PROXY', 'NODE_USE_ENV_PROXY', 'LLM_API_KEY']) delete env[k]
  // 用 shim 把 Modrinth API 改写到本地服务（下载 URL 由假服务直接给出，无需改写）。
  const shim = join(tmpdir(), `probe-cand-shim-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(shim, `
const realFetch = globalThis.fetch
globalThis.fetch = (url, opts) => {
  const s = String(url)
  if (s.startsWith('https://api.modrinth.com/v2')) {
    return realFetch(s.replace('https://api.modrinth.com/v2', '${state.baseUrl}/v2'), opts)
  }
  return realFetch(s, opts)
}
export {}
`)
  Object.assign(env, { NODE_OPTIONS: `--import ${new URL(`file://${shim.replace(/\\/g, '/')}`).href}` })
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['scripts/probe-candidates.mjs', ...args], { cwd: repo, env })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('exit', (code) => {
      rmSync(shim, { force: true })
      resolve({ code, out, err })
    })
  })
}

test('CLI：五种判定齐全，探测命中时不下载整包，回退整包如实记录', { timeout: 180000 }, async () => {
  const projects = [
    { id: 'big', projectId: 'p-big', title: 'Big', downloads: 5000 },
    { id: 'native', projectId: 'p-native', title: 'Native', downloads: 4000 },
    { id: 'noen', projectId: 'p-noen', title: 'NoEn', downloads: 3000 },
    { id: 'tiny', projectId: 'p-tiny', title: 'Tiny', downloads: 2000 },
    { id: 'broken', projectId: 'p-broken', title: 'Broken', downloads: 1000 },
    { id: 'dead', projectId: 'p-dead', title: 'Dead', downloads: 500 },
  ]
  const state = {
    baseUrl: '',
    rangeMode: true,
    zipRequests: [],
    failVersions: new Set(['p-dead']),
    projectToZip: {
      'p-big': 'big', 'p-native': 'native', 'p-noen': 'noen', 'p-tiny': 'tiny', 'p-broken': 'broken',
    },
  }
  const repo = makeRepo(projects)
  let server
  try {
    server = await startFakeServer(state)
    // 记录探测前后的 site/ 目录快照，验证脚本只读。
    const dataBefore = readdirSync(join(repo, 'site/data')).map((f) => [f, readFileSync(join(repo, 'site/data', f), 'utf8')])

    const r = await runCli(repo, state, ['--limit', '10', '--concurrency', '2', '--min-entries', '10'])
    assert.equal(r.code, 0, r.err)

    const out = JSON.parse(r.out)
    const byId = Object.fromEntries(out.candidates.map((c) => [c.id, c]))
    assert.equal(byId.big.status, 'translatable')
    assert.equal(byId.big.enEntries, 20)
    assert.equal(byId.native.status, 'native-zh')
    assert.equal(byId.noen.status, 'no-en')
    assert.equal(byId.tiny.status, 'too-small')
    assert.equal(byId.tiny.enEntries, 2)
    assert.equal(byId.broken.status, 'probe-failed')
    assert.equal(byId.dead.status, 'probe-failed', '元数据 500 只让这一条失败')

    // 排序：按下载量降序
    assert.deepEqual(out.candidates.map((c) => c.id), ['big', 'native', 'noen', 'tiny', 'broken', 'dead'])

    // 证据：终态包（native/noen/tiny）没有整包请求，只有 Range
    for (const key of ['native', 'noen', 'tiny']) {
      const reqs = state.zipRequests.filter((x) => x.key === key)
      assert.ok(reqs.length >= 1, `${key} 应被探测`)
      assert.equal(reqs.filter((x) => x.range === null).length, 0, `${key} 不该下载整包`)
      const bytes = reqs.reduce((s, x) => s + x.bytes, 0)
      assert.ok(bytes < ZIPS[key].length / 2, `${key} 下载 ${bytes} 应远小于整包 ${ZIPS[key].length}`)
    }
    // 可翻包：读了 en_US.lang 这一个条目，但仍不是整包
    const bigReqs = state.zipRequests.filter((x) => x.key === 'big')
    assert.equal(bigReqs.filter((x) => x.range === null).length, 0, '可翻包也不该下载整包')
    assert.ok(bigReqs.reduce((s, x) => s + x.bytes, 0) < ZIPS.big.length, '读取量应小于整包')

    // 汇总
    assert.equal(out.summary.byStatus.translatable, 1)
    assert.equal(out.summary.byStatus['native-zh'], 1)
    assert.equal(out.summary.byStatus['no-en'], 1)
    assert.equal(out.summary.byStatus['too-small'], 1)
    assert.equal(out.summary.byStatus['probe-failed'], 2)
    assert.equal(out.summary.fallbackFull, 0)
    assert.deepEqual(out.summary.translatable.map((x) => x.id), ['big'])
    assert.ok(out.summary.savedPct > 50, `应记录节省比例，实际 ${out.summary.savedPct}`)

    // 只读：site/data 与 site/public/lang 均未被写
    const dataAfter = readdirSync(join(repo, 'site/data')).map((f) => [f, readFileSync(join(repo, 'site/data', f), 'utf8')])
    assert.deepEqual(dataAfter, dataBefore, '不得改写 site/data')
    assert.equal(existsSync(join(repo, 'site/public/lang')), false, '不得写 site/public/lang')
  } finally {
    server?.close()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('CLI：服务端不支持 Range → 回退整包，fetchMode=full 被统计', { timeout: 180000 }, async () => {
  const projects = [{ id: 'native', projectId: 'p-native', title: 'Native', downloads: 100 }]
  const state = {
    baseUrl: '',
    rangeMode: false,
    zipRequests: [],
    failVersions: new Set(),
    projectToZip: { 'p-native': 'native' },
  }
  const repo = makeRepo(projects)
  let server
  try {
    server = await startFakeServer(state)
    const r = await runCli(repo, state, ['--limit', '5'])
    assert.equal(r.code, 0, r.err)
    const out = JSON.parse(r.out)
    assert.equal(out.candidates[0].status, 'native-zh')
    assert.equal(out.candidates[0].fetchMode, 'full')
    assert.equal(out.summary.fallbackFull, 1)
    assert.equal(state.zipRequests.filter((x) => x.range === null).length, 1)
  } finally {
    server?.close()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('CLI：--ids 只探测指定条目；--out 写文件、stdout 留空', { timeout: 180000 }, async () => {
  const projects = [
    { id: 'big', projectId: 'p-big', title: 'Big', downloads: 5000 },
    { id: 'native', projectId: 'p-native', title: 'Native', downloads: 4000 },
  ]
  const state = {
    baseUrl: '',
    rangeMode: true,
    zipRequests: [],
    failVersions: new Set(),
    projectToZip: { 'p-big': 'big', 'p-native': 'native' },
  }
  const repo = makeRepo(projects)
  let server
  try {
    server = await startFakeServer(state)
    const outPath = join(repo, 'artifacts', 'candidates.json')
    const r = await runCli(repo, state, ['--ids', 'big', '--out', outPath])
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, '', 'stdout 应留空（结果写文件）')
    const out = JSON.parse(readFileSync(outPath, 'utf8'))
    assert.deepEqual(out.candidates.map((c) => c.id), ['big'])
    assert.equal(state.zipRequests.some((x) => x.key === 'native'), false, '--ids 之外的包不该被探测')
  } finally {
    server?.close()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('默认阈值与流水线口径一致（导出常量可被引用）', () => {
  assert.equal(DEFAULT_MIN_EN_ENTRIES, 10)
  assert.equal(RANGE_MIN_BYTES, 65536, '必须与 shared/zip-range.mjs 的 minRangeBytes 默认值一致')
  assert.equal(PROBE_STATUS.TRANSLATABLE, 'translatable')
})
