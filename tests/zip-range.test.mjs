#!/usr/bin/env node
/**
 * shared/zip-range.mjs 的离线单元测试。
 *
 * 全部用例用 node:zlib 在内存构造合成 zip 夹具 + stub fetch 注入响应，
 * 不发任何真实网络请求。覆盖 docs/range-download-plan.md「测试与验收」全部 9 条。
 *
 * 运行：npm test
 */
import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { crc32, openZip } from '../shared/zip-range.mjs'

// ---------- zip 夹具构造（内存合成，无网络） ----------

const LOCAL_SIG = 0x04034b50
const CD_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const ZIP64_LOCATOR_SIG = 0x07064b50

function localHeader(name, method, crc, compSize, uncompSize) {
  const nameBuf = Buffer.from(name, 'utf8')
  const h = Buffer.alloc(30)
  h.writeUInt32LE(LOCAL_SIG, 0)
  h.writeUInt16LE(20, 4) // version needed
  h.writeUInt16LE(0, 6) // flags
  h.writeUInt16LE(method, 8)
  h.writeUInt32LE(crc, 14)
  h.writeUInt32LE(compSize, 18)
  h.writeUInt32LE(uncompSize, 22)
  h.writeUInt16LE(nameBuf.length, 26)
  h.writeUInt16LE(0, 28) // extra len
  return Buffer.concat([h, nameBuf])
}

function centralDirEntry(name, method, crc, compSize, uncompSize, localOffset) {
  const nameBuf = Buffer.from(name, 'utf8')
  const h = Buffer.alloc(46)
  h.writeUInt32LE(CD_SIG, 0)
  h.writeUInt16LE(20, 4) // version made by
  h.writeUInt16LE(20, 6) // version needed
  h.writeUInt16LE(0, 8) // flags
  h.writeUInt16LE(method, 10)
  h.writeUInt32LE(crc, 16)
  h.writeUInt32LE(compSize, 20)
  h.writeUInt32LE(uncompSize, 24)
  h.writeUInt16LE(nameBuf.length, 28)
  h.writeUInt16LE(0, 30) // extra len
  h.writeUInt16LE(0, 32) // comment len
  h.writeUInt16LE(0, 34) // disk start
  h.writeUInt16LE(0, 36) // internal attrs
  h.writeUInt32LE(0, 38) // external attrs
  h.writeUInt32LE(localOffset, 42)
  return Buffer.concat([h, nameBuf])
}

/**
 * 构造合成 zip 文件。
 * @param {Array<{name:string, data:string|Buffer, method?:0|8}>} entries
 * @param {{padTo?: number}} [opts] padTo：在文件头部补零撑到指定总长（EOCD 仍在末尾）
 */
function buildZip(entries, { padTo = 0 } = {}) {
  const locals = []
  const cds = []
  let offset = 0
  for (const e of entries) {
    const method = e.method ?? 8
    const raw = Buffer.from(e.data)
    const comp = method === 0 ? raw : deflateRawSync(raw)
    const crc = crc32(raw)
    locals.push(Buffer.concat([localHeader(e.name, method, crc, comp.length, raw.length), comp]))
    cds.push(centralDirEntry(e.name, method, crc, comp.length, raw.length, offset))
    offset += locals[locals.length - 1].length
  }

  const cdStart = offset
  const cdBuf = Buffer.concat(cds)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(cdStart, 16)

  let body = Buffer.concat([...locals, cdBuf, eocd])
  if (padTo > body.length) {
    const padLen = padTo - body.length
    const padded = Buffer.alloc(padTo)
    body.copy(padded, padLen)
    // EOCD 的 cdStart 与每条 CD 的 localOffset 都要加上头部填充长度
    padded.writeUInt32LE(cdStart + padLen, padded.length - 22 + 16)
    let p = padLen + cdStart
    for (let i = 0; i < entries.length; i++) {
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

/** 复制 zip 并篡改指定条目在中央目录里的 CRC 字段。 */
function withTamperedCrc(buf, targetName) {
  const copy = Buffer.from(buf)
  const eocd = copy.length - 22
  const count = copy.readUInt16LE(eocd + 10)
  const cdStart = copy.readUInt32LE(eocd + 16)
  let p = cdStart
  for (let i = 0; i < count; i++) {
    const nameLen = copy.readUInt16LE(p + 28)
    const extraLen = copy.readUInt16LE(p + 30)
    const commentLen = copy.readUInt16LE(p + 32)
    const name = copy.slice(p + 46, p + 46 + nameLen).toString('utf8')
    if (name === targetName) {
      copy.writeUInt32LE(copy.readUInt32LE(p + 16) ^ 0xffffffff, p + 16)
      break
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  return copy
}

/** 在 EOCD 前插入 20 字节 zip64 EOCD locator（签名 0x07064b50）。 */
function withZip64Locator(buf) {
  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(ZIP64_LOCATOR_SIG, 0)
  return Buffer.concat([buf.subarray(0, buf.length - 22), locator, buf.subarray(buf.length - 22)])
}

/**
 * stub fetch：Range 请求从 rangeBuf 切片返回 206，整包请求返回 fullBuf。
 * rangeStatus 可以是数字或函数 (req) => status，用于模拟非 206 / 瞬时错误。
 */
function makeServer(rangeBuf, fullBuf = rangeBuf, { rangeStatus = 206, fullStatus = 200 } = {}) {
  const requests = []
  const statusFor = typeof rangeStatus === 'function' ? rangeStatus : () => rangeStatus
  const fetchImpl = async (url, init = {}) => {
    const headers = new Headers(init.headers)
    const range = headers.get('range')
    const req = { url: String(url), range }
    requests.push(req)
    if (range) {
      const m = /^bytes=(\d+)-(\d+)$/.exec(range)
      if (!m) throw new Error(`非法 Range 头: ${range}`)
      const start = Number(m[1])
      const end = Number(m[2])
      const slice = rangeBuf.subarray(start, end + 1)
      return new Response(slice, {
        status: statusFor(req),
        headers: {
          'Content-Range': `bytes ${start}-${end}/${rangeBuf.length}`,
          'Content-Length': String(slice.length),
        },
      })
    }
    return new Response(fullBuf, { status: fullStatus })
  }
  return { fetchImpl, requests }
}

// ---------- 测试 ----------

describe('zip-range 离线单元测试', () => {
  afterEach(() => {
    mock.restoreAll()
  })

  it('1. Stored 与 Deflate 两种 method 均能正确抽取', async () => {
    const en = 'option.ao=Ambient Occlusion\noption.bloom=Bloom Strength: %s\n'
    const zh = 'option.ao=环境光遮蔽\noption.bloom=泛光强度：%s\n'
    // 撑到 200KB，迫使 read() 走条目级 Range 请求（local header + data）
    const buf = buildZip(
      [
        { name: 'shaders/lang/en_US.lang', method: 8, data: en },
        { name: 'shaders/lang/zh_CN.lang', method: 0, data: zh },
      ],
      { padTo: 200000 },
    )
    const server = makeServer(buf)
    mock.method(globalThis, 'fetch', server.fetchImpl)

    const zip = await openZip('https://example.test/shader.zip', {
      totalSize: buf.length,
      minRangeBytes: 0,
    })
    assert.equal(zip.fetchMode, 'range')
    assert.deepEqual(zip.names, ['shaders/lang/en_US.lang', 'shaders/lang/zh_CN.lang'])

    const enBuf = await zip.read('shaders/lang/en_US.lang')
    assert.equal(enBuf.toString('utf8'), en)
    const zhBuf = await zip.read('shaders/lang/zh_CN.lang')
    assert.equal(zhBuf.toString('utf8'), zh)

    const rangeReqs = server.requests.filter((r) => r.range)
    assert.ok(rangeReqs.length >= 3, `应发出多次 Range 请求，实际 ${rangeReqs.length}`)
  })

  it('2. CRC32 已知向量：crc32("123456789") === 0xCBF43926', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
  })

  it('3. CRC 字段被篡改 → 回退整包且内容正确', async () => {
    const correct = buildZip(
      [{ name: 'shaders/lang/en_US.lang', method: 8, data: 'option.ao=Ambient Occlusion\n' }],
      { padTo: 200000 },
    )
    const tampered = withTamperedCrc(correct, 'shaders/lang/en_US.lang')
    // Range 响应返回被篡改的 CD，整包响应返回正确文件
    const server = makeServer(tampered, correct)
    mock.method(globalThis, 'fetch', server.fetchImpl)

    const zip = await openZip('https://example.test/shader.zip', {
      totalSize: correct.length,
      minRangeBytes: 0,
    })
    assert.equal(zip.fetchMode, 'range')
    const data = await zip.read('shaders/lang/en_US.lang')
    assert.equal(zip.fetchMode, 'full', 'CRC 不匹配应回退整包')
    assert.equal(data.toString('utf8'), 'option.ao=Ambient Occlusion\n')
  })

  it('4. zip64 locator 检出即回退整包', async () => {
    const correct = buildZip([
      { name: 'shaders/lang/en_US.lang', method: 8, data: 'option.ao=Ambient Occlusion\n' },
    ])
    const zip64Buf = withZip64Locator(correct)
    const server = makeServer(zip64Buf, correct)
    mock.method(globalThis, 'fetch', server.fetchImpl)

    const zip = await openZip('https://example.test/shader.zip', {
      totalSize: zip64Buf.length,
      minRangeBytes: 0,
    })
    assert.equal(zip.fetchMode, 'full', '检出 zip64 应回退整包')
    const data = await zip.read('shaders/lang/en_US.lang')
    assert.equal(data.toString('utf8'), 'option.ao=Ambient Occlusion\n')
  })

  it('5. 中央目录大于初始窗口时窗口正确放大', async () => {
    const entries = [
      { name: 'shaders/lang/en_US.lang', method: 8, data: 'option.ao=Ambient Occlusion\n' },
    ]
    // 1400 条长名条目 → 中央目录 ~180KB，远超 64KB 初始窗口
    for (let i = 0; i < 1400; i++) {
      entries.push({
        name: `dir/file_${String(i).padStart(4, '0')}_${'x'.repeat(70)}.txt`,
        method: 8,
        data: '',
      })
    }
    const buf = buildZip(entries)
    const server = makeServer(buf)
    mock.method(globalThis, 'fetch', server.fetchImpl)

    const zip = await openZip('https://example.test/shader.zip', {
      totalSize: buf.length,
      minRangeBytes: 0,
    })
    assert.equal(zip.fetchMode, 'range')
    const starts = server.requests.filter((r) => r.range).map((r) => r.range)
    assert.ok(
      starts.includes(`bytes=${buf.length - 65536}-${buf.length - 1}`),
      '应先发 64KB 初始窗口请求',
    )
    assert.ok(
      starts.includes(`bytes=${buf.length - 262144}-${buf.length - 1}`),
      '窗口应放大到 256KB',
    )
    const data = await zip.read('shaders/lang/en_US.lang')
    assert.equal(data.toString('utf8'), 'option.ao=Ambient Occlusion\n')
  })

  it('6. 窗口覆盖整个文件时不发第二次请求', async () => {
    const buf = buildZip(
      [{ name: 'shaders/lang/en_US.lang', method: 8, data: 'option.ao=Ambient Occlusion\n' }],
      { padTo: 65536 },
    )
    assert.equal(buf.length, 65536)
    const server = makeServer(buf)
    mock.method(globalThis, 'fetch', server.fetchImpl)

    const zip = await openZip('https://example.test/shader.zip', { totalSize: buf.length })
    assert.equal(zip.fetchMode, 'range')
    assert.equal(server.requests.length, 1, '打开时只应发 1 次尾部窗口请求')

    const data = await zip.read('shaders/lang/en_US.lang')
    assert.equal(server.requests.length, 1, '窗口覆盖整个文件，read() 不应再发请求')
    assert.equal(data.toString('utf8'), 'option.ao=Ambient Occlusion\n')
    assert.equal(zip.bytesDownloaded, 65536)
  })

  it('7. 目标条目不存在时 read() 返回 null，names 仍完整', async () => {
    const buf = buildZip([
      { name: 'shaders/lang/zh_CN.lang', method: 0, data: 'option.ao=环境光遮蔽\n' },
      { name: 'shaders/shaders.json', method: 8, data: '{}' },
    ])
    const server = makeServer(buf)
    mock.method(globalThis, 'fetch', server.fetchImpl)

    const zip = await openZip('https://example.test/shader.zip', {
      totalSize: buf.length,
      minRangeBytes: 0,
    })
    assert.equal(zip.fetchMode, 'range')
    const before = server.requests.length
    const res = await zip.read('shaders/lang/en_US.lang')
    assert.equal(res, null)
    assert.equal(server.requests.length, before, '条目不存在不应触发额外请求')
    assert.deepEqual(zip.names, ['shaders/lang/zh_CN.lang', 'shaders/shaders.json'])
    assert.equal(zip.fetchMode, 'range', '条目不存在不是错误，不应回退整包')
  })

  for (const status of [200, 501, 500]) {
    it(`8. 非 206（${status}）重试后回退整包`, async () => {
      // 指数退避 1s/2s 与测试无关，mock 掉 setTimeout 让重试立即发生
      mock.method(globalThis, 'setTimeout', (fn) => fn())
      const buf = buildZip(
        [{ name: 'shaders/lang/en_US.lang', method: 8, data: 'option.ao=Ambient Occlusion\n' }],
        { padTo: 200000 },
      )
      const server = makeServer(buf, buf, { rangeStatus: status })
      mock.method(globalThis, 'fetch', server.fetchImpl)

      const zip = await openZip('https://example.test/shader.zip', {
        totalSize: buf.length,
        minRangeBytes: 0,
      })
      assert.equal(zip.fetchMode, 'full', `${status} 重试后应回退整包`)
      assert.equal(
        server.requests.filter((r) => r.range).length,
        3,
        '初始 + 2 次重试 = 3 次 Range 请求',
      )
      const data = await zip.read('shaders/lang/en_US.lang')
      assert.equal(data.toString('utf8'), 'option.ao=Ambient Occlusion\n')
    })
  }

  it('8b. 非 206（501）为瞬时错误时重试后成功走 Range', async () => {
    mock.method(globalThis, 'setTimeout', (fn) => fn())
    const buf = buildZip(
      [{ name: 'shaders/lang/en_US.lang', method: 8, data: 'option.ao=Ambient Occlusion\n' }],
      { padTo: 200000 },
    )
    let rangeCalls = 0
    const server = makeServer(buf, buf, {
      rangeStatus: () => (++rangeCalls === 1 ? 501 : 206),
    })
    mock.method(globalThis, 'fetch', server.fetchImpl)

    const zip = await openZip('https://example.test/shader.zip', {
      totalSize: buf.length,
      minRangeBytes: 0,
    })
    assert.equal(zip.fetchMode, 'range', '501 瞬时错误重试后应成功走 Range')
    const data = await zip.read('shaders/lang/en_US.lang')
    assert.equal(data.toString('utf8'), 'option.ao=Ambient Occlusion\n')
  })

  it('9. minRangeBytes 阈值：小于阈值不发 Range 请求', async () => {
    const buf = buildZip([
      { name: 'shaders/lang/en_US.lang', method: 8, data: 'option.ao=Ambient Occlusion\n' },
    ])
    assert.ok(buf.length < 65536)
    const server = makeServer(buf)
    mock.method(globalThis, 'fetch', server.fetchImpl)

    const zip = await openZip('https://example.test/shader.zip', { totalSize: buf.length })
    assert.equal(zip.fetchMode, 'full', '小于阈值应直接整包')
    assert.equal(server.requests.length, 1)
    assert.equal(server.requests[0].range, null, '不应发送 Range 请求头')
    const data = await zip.read('shaders/lang/en_US.lang')
    assert.equal(data.toString('utf8'), 'option.ao=Ambient Occlusion\n')

    // 对照组：同一小 zip 把阈值降到 0 就走 Range
    mock.restoreAll()
    const server2 = makeServer(buf)
    mock.method(globalThis, 'fetch', server2.fetchImpl)
    const zip2 = await openZip('https://example.test/shader.zip', {
      totalSize: buf.length,
      minRangeBytes: 0,
    })
    assert.equal(zip2.fetchMode, 'range', '阈值降到 0 应走 Range')
    const data2 = await zip2.read('shaders/lang/en_US.lang')
    assert.equal(data2.toString('utf8'), 'option.ao=Ambient Occlusion\n')
  })
})