#!/usr/bin/env node
/**
 * 多线程批量下载全部光影最新版 zip，抽取 shaders/lang/en_US.lang 原始文件。
 * 产出：sources/<光影id>/<版本>/en_US.lang + sources/manifest.json（含自带中文检测结果）
 * sources/ 目录已加入 .gitignore（原语言文件版权归光影作者，不入库、不进站点）。
 *
 * 用法：node scripts/fetch-lang-sources.mjs [--threads 16]
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG_FILE = join(ROOT, 'site/data/modrinth-catalog.json')
const OUT_DIR = join(ROOT, 'sources')
const MODRINTH_API = 'https://api.modrinth.com/v2'
const UA = 'shader-i18n-site/0.1.0 (lang source cache)'

const args = process.argv.slice(2)
const tIdx = args.indexOf('--threads')
const THREADS = Math.max(1, Math.min(32, Number(args[tIdx + 1]) || 16))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 极简 zip 读取（与 pipeline.mjs 相同实现） ----------
function zipEntries(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('zip: 找不到 EOCD')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const entries = new Map()
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip: 中央目录损坏')
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOffset = buf.readUInt32LE(off + 42)
    entries.set(buf.slice(off + 46, off + 46 + nameLen).toString('utf8'), { method, compSize, localOffset })
    off += 46 + nameLen + extraLen + commentLen
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name)
      const lho = e.localOffset
      const nameLen = buf.readUInt16LE(lho + 26)
      const extraLen = buf.readUInt16LE(lho + 28)
      const raw = buf.slice(lho + 30 + nameLen + extraLen, lho + 30 + nameLen + extraLen + e.compSize)
      return e.method === 0 ? raw : inflateRawSync(raw)
    },
  }
}

const catalog = JSON.parse(readFileSync(CATALOG_FILE, 'utf8'))
const manifestFile = join(OUT_DIR, 'manifest.json')
const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : { entries: {} }
mkdirSync(OUT_DIR, { recursive: true })

let idx = 0
let done = 0, skipped = 0, failed = 0
const total = catalog.shaders.length
const t0 = Date.now()

async function worker() {
  while (idx < total) {
    const s = catalog.shaders[idx++]
    const prev = manifest.entries[s.id]
    if (prev?.file && existsSync(join(OUT_DIR, prev.file))) { skipped++; continue }
    try {
      const versions = await fetch(`${MODRINTH_API}/project/${s.projectId}/version`, { headers: { 'User-Agent': UA } }).then((r) => r.json())
      const latest = versions[0]
      const file = latest?.files?.find((f) => f.primary) ?? latest?.files?.[0]
      if (!file) { failed++; continue }
      const shaderVersion = latest.version_number
      const res = await fetch(file.url, { headers: { 'User-Agent': UA } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const zip = zipEntries(Buffer.from(await res.arrayBuffer()))
      const langNames = zip.names.filter((n) => /^shaders\/lang\/[^/]+$/i.test(n))
      const nativeZh = langNames.some((n) => /^shaders\/lang\/zh_CN\.lang$/i.test(n))
      const enName = langNames.find((n) => /^shaders\/lang\/en_US\.lang$/i.test(n))
      let relPath = null
      if (enName) {
        relPath = join(s.id, shaderVersion, 'en_US.lang')
        const dest = join(OUT_DIR, relPath)
        mkdirSync(dirname(dest), { recursive: true })
        writeFileSync(dest, zip.read(enName))
      }
      manifest.entries[s.id] = {
        shaderVersion,
        file: relPath,
        hasEn: !!enName,
        hasNativeZhCN: nativeZh,
        zipFile: file.filename,
        fetchedAt: new Date().toISOString().slice(0, 10),
      }
      done++
      if (done % 25 === 0) {
        // 增量写盘：中途被停也不丢进度记录
        writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
        const rate = (done / ((Date.now() - t0) / 1000)).toFixed(1)
        process.stdout.write(`\r${done + skipped}/${total}（${rate} 个/秒，并发 ${THREADS}）`)
      }
    } catch (err) {
      failed++
      console.log(`\n[${s.id}] 失败: ${err.message.slice(0, 100)}`)
    }
    await sleep(80)
  }
}

await Promise.all(Array.from({ length: THREADS }, worker))
writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
const sec = ((Date.now() - t0) / 1000).toFixed(0)
console.log(`\n完成：新增 ${done}，已存在跳过 ${skipped}，失败 ${failed}，耗时 ${sec}s`)
console.log(`输出：${OUT_DIR}（sources/ 已 gitignore，不入库）`)
