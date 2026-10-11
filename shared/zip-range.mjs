/**
 * 按 HTTP Range 增量抽取 zip 内文件：只下载尾部中央目录与目标条目，任何异常透明回退整包。
 *
 * 与 scripts/fetch-lang-sources.mjs 原有的 zipEntries() 同形，替换后调用点几乎零改动。
 * 设计见 docs/range-download-plan.md，四条硬约束：
 * - 必须用显式 bytes=start-end（Modrinth CDN 对后缀区间返回 501）
 * - 不读 Accept-Ranges 预判 Range 支持，只看响应状态码
 * - 501 / 5xx 视为可重试的瞬时错误（指数退避 1s/2s）
 * - 尾部窗口 64KB 起 ×4 递增，上限 maxTailBytes（默认 8MB）
 *
 * 核心保证：Range 路径要么产出与整包逐字节相同的内容，要么回退整包，绝不静默产出错误字节。
 */
import { inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50 // End Of Central Directory
const CD_SIG = 0x02014b50 // Central Directory File Header
const LOCAL_SIG = 0x04034b50 // Local File Header
const ZIP64_LOCATOR_SIG = 0x07064b50 // zip64 EOCD locator
const TAIL_INITIAL = 65536 // 尾部窗口初始 64KB
const TAIL_GROW = 4 // 窗口放大幅度

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- CRC32（IEEE 802.3，查表版，与 zlib 同款；Node 内置无 crc32） ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

/**
 * CRC32 校验（查表版）。
 * @param {Buffer} buf
 * @returns {number} 无符号 32 位 CRC32
 */
export function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// ---------- zip 结构解析 ----------

/**
 * 在尾部切片中查找 EOCD 并解析中央目录。
 * @param {Buffer} buf 文件尾部切片
 * @param {number} baseAbs 切片起点在 zip 文件中的绝对偏移
 * @returns {{ entries: Array<{name:string, method:number, compSize:number, uncompSize:number, crc:number, localOffset:number}> }}
 * @throws 找不到 EOCD / 中央目录越界或损坏 / 检出 zip64（err.zip64 = true）
 */
function parseCentralDir(buf, baseAbs) {
  let eocd = -1
  const searchStart = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip: 找不到 EOCD')

  // zip64 不实现：检出 zip64 EOCD locator 即回退整包
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG) {
    const err = new Error('zip64 暂不支持，回退整包')
    err.zip64 = true
    throw err
  }

  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdStart = buf.readUInt32LE(eocd + 16)
  const off = cdStart - baseAbs
  // CD 起点在窗口之前或 CD 超出窗口 → 窗口不够大，由调用方放大重试
  if (off < 0 || off + cdSize > buf.length) throw new Error('中央目录超出尾部窗口')

  const entries = []
  let p = off
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) throw new Error('中央目录损坏')
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    entries.push({
      name: buf.slice(p + 46, p + 46 + nameLen).toString('utf8'),
      method: buf.readUInt16LE(p + 10),
      compSize: buf.readUInt32LE(p + 20),
      uncompSize: buf.readUInt32LE(p + 24),
      crc: buf.readUInt32LE(p + 16),
      localOffset: buf.readUInt32LE(p + 42),
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return { entries }
}

// ---------- 网络请求 ----------

/** 整包下载。 */
async function fetchFull(url, headers) {
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * 发一次显式 bytes=start-end 的 Range 请求并返回区间字节。
 * 非 206（含 501 / 5xx）一律视为可重试的瞬时错误，指数退避 1s/2s 重试 retries 次。
 * 206 必须同时满足：Content-Range 的 start/end 与请求一致，且响应体长度恰好等于区间长度。
 * 任一不符（服务器返回错位/陈旧内容）按瞬时错误重试，防止 Range 路径静默产出与整包不同的字节。
 * @returns {Buffer} 校验通过的区间字节
 */
async function fetchRange(url, start, end, retries, headers) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1))
    try {
      const res = await fetch(url, { headers: { ...headers, Range: `bytes=${start}-${end}` } })
      if (res.status === 206) {
        // 校验 Content-Range：服务器必须声明返回的正是请求区间
        const cr = res.headers.get('content-range')
        const m = cr && /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(cr.trim())
        if (!m || Number(m[1]) !== start || Number(m[2]) !== end || (m[3] !== '*' && Number(m[3]) <= end)) {
          // Content-Range 缺失或与请求区间不符：丢弃连接，按瞬时错误重试
          if (res.body) await res.body.cancel().catch(() => {})
          lastErr = new Error('Content-Range 与请求区间不符')
          continue
        }
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length !== end - start + 1) {
          lastErr = new Error('Range 响应体长度不符')
          continue
        }
        return buf
      }
      // 非 206 不读取响应体，直接丢弃连接，按瞬时错误重试
      if (res.body) await res.body.cancel().catch(() => {})
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr ?? new Error('Range 请求失败')
}

// ---------- 条目抽取与校验 ----------

/**
 * 按 method 解压并做 CRC32 / 长度强校验。
 * @returns {Buffer} 解压后的原始数据
 */
function inflateEntry(entry, raw) {
  if (raw.length !== entry.compSize) throw new Error('条目数据长度不符')
  let data
  if (entry.method === 0) {
    data = raw // Stored
  } else if (entry.method === 8) {
    data = inflateRawSync(raw) // Deflate
  } else {
    throw new Error(`不支持的压缩方法：${entry.method}`)
  }
  if (data.length !== entry.uncompSize) throw new Error('解压后长度不符')
  if (crc32(data) !== entry.crc) throw new Error('CRC32 校验失败')
  return data
}

/** 从整包 buffer 中按 local header 定位并抽取一个条目。 */
function extractFromBuffer(buf, entry) {
  const lho = entry.localOffset
  if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== LOCAL_SIG) throw new Error('local header magic 不符')
  const nameLen = buf.readUInt16LE(lho + 26)
  const extraLen = buf.readUInt16LE(lho + 28)
  const dataStart = lho + 30 + nameLen + extraLen
  const raw = buf.slice(dataStart, dataStart + entry.compSize)
  return inflateEntry(entry, raw)
}

/**
 * Range 模式下按需取目标条目：先取 local header 固定 30 字节，再精确取压缩数据区间。
 * @returns {{ data: Buffer, downloaded: number }} 校验通过的解压数据与本次实际下载字节数
 */
async function readEntryByRange(url, entry, headers, retries) {
  const head = await fetchRange(url, entry.localOffset, entry.localOffset + 29, retries, headers)
  if (head.length < 30 || head.readUInt32LE(0) !== LOCAL_SIG) throw new Error('local header magic 不符')
  const nameLen = head.readUInt16LE(26)
  const extraLen = head.readUInt16LE(28)
  const dataStart = entry.localOffset + 30 + nameLen + extraLen

  let raw
  let downloaded = head.length
  if (entry.compSize === 0) {
    raw = Buffer.alloc(0)
  } else {
    // zip64 占位大小（0xFFFFFFFF）不实现：直接回退整包，避免发出 4GB 巨型 Range
    if (entry.compSize === 0xffffffff) throw new Error('zip64 占位大小，回退整包')
    raw = await fetchRange(url, dataStart, dataStart + entry.compSize - 1, retries, headers)
    downloaded += raw.length
  }
  return { data: inflateEntry(entry, raw), downloaded }
}

// ---------- 整包模式对象 ----------

/** 从整包 buffer 构造 full 模式 zip 对象。 */
function zipFromBuffer(buf) {
  const { entries } = parseCentralDir(buf, 0)
  const byName = new Map(entries.map((e) => [e.name.toLowerCase(), e]))
  return {
    names: entries.map((e) => e.name),
    fetchMode: 'full',
    bytesDownloaded: buf.length,
    async read(name) {
      const entry = byName.get(String(name).toLowerCase())
      return entry ? extractFromBuffer(buf, entry) : null
    },
  }
}

/**
 * 打开远程 zip：优先 Range 模式，任何异常透明回退整包。
 *
 * @param {string} url zip 下载地址
 * @param {object} [opts]
 * @param {number} opts.totalSize 文件总大小（调用方从 Modrinth API 的 file.size 获取）
 * @param {object} [opts.headers] 附加请求头（如 User-Agent）
 * @param {number} [opts.minRangeBytes=65536] 小于该值直接整包
 * @param {number} [opts.maxTailBytes=8<<20] 尾部窗口上限
 * @param {number} [opts.retries=2] 非 206 重试次数（指数退避 1s/2s）
 * @param {boolean} [opts.forceFull=false] 强制整包（用于 A/B 对比与排障）
 * @returns {Promise<{ names: string[], read: (name: string) => Promise<Buffer|null>, fetchMode: 'range'|'full', bytesDownloaded: number }>}
 */
export async function openZip(url, opts = {}) {
  const {
    totalSize,
    headers = {},
    minRangeBytes = 65536,
    maxTailBytes = 8 << 20,
    retries = 2,
    forceFull = false,
  } = opts

  // 阈值判断：小于 minRangeBytes 或未提供 totalSize → 整包（1 次请求）
  const canRange = !forceFull && Number.isFinite(totalSize) && totalSize >= minRangeBytes
  if (!canRange) {
    return zipFromBuffer(await fetchFull(url, headers))
  }

  // Range 模式状态：read() 内任何失败都会升级为整包并更新计数
  const zip = { names: [], fetchMode: 'range', bytesDownloaded: 0, _full: null }

  try {
    // 1. 取尾部窗口（64KB 起，×4 递增，上限 maxTailBytes），解析 EOCD + 中央目录
    let win = TAIL_INITIAL
    let tail = null
    let baseAbs = 0
    let entries = null

    while (true) {
      if (win > maxTailBytes) throw new Error('尾部窗口超过上限，回退整包')
      const start = Math.max(0, totalSize - win) // 显式区间，禁止 bytes=-N 后缀形式
      const end = totalSize - 1
      const buf = await fetchRange(url, start, end, retries, headers)
      zip.bytesDownloaded += buf.length
      try {
        const parsed = parseCentralDir(buf, start)
        entries = parsed.entries
        tail = buf
        baseAbs = start
        break
      } catch (err) {
        if (err.zip64) throw err // zip64 → 整包
        win *= TAIL_GROW // EOCD 未找到 / CD 越界 → 窗口放大重试
      }
    }

    const byName = new Map(entries.map((e) => [e.name.toLowerCase(), e]))
    zip.names = entries.map((e) => e.name)
    // 窗口覆盖整个文件 → 复用该 buffer，不再发第二次请求
    const wholeFile = baseAbs === 0 && tail.length === totalSize

    // 2. 按需取目标条目（大小写不敏感匹配）
    zip.read = async (name) => {
      const entry = byName.get(String(name).toLowerCase())
      if (!entry) return null // 目标条目不存在不是错误
      try {
        if (wholeFile) return extractFromBuffer(tail, entry)
        const { data, downloaded } = await readEntryByRange(url, entry, headers, retries)
        zip.bytesDownloaded += downloaded
        return data
      } catch {
        // 任何异常（CRC 不符 / 长度不符 / 网络错误 / 方法不支持等）→ 静默回退整包
        return upgradeToFull(zip, url, headers, name)
      }
    }

    return zip
  } catch {
    // 尾部窗口阶段失败 → 整包
    return upgradeToFull(zip, url, headers)
  }
}

/** 把已返回的 range 模式对象升级为整包模式，保证内容正确。 */
async function upgradeToFull(zip, url, headers, name) {
  if (!zip._full) {
    const buf = await fetchFull(url, headers)
    zip._full = zipFromBuffer(buf)
    zip.fetchMode = 'full'
    zip.bytesDownloaded += buf.length
  }
  zip.names = zip._full.names
  zip.read = zip._full.read
  return name === undefined ? zip : zip._full.read(name)
}