#!/usr/bin/env node
/**
 * 多线程批量下载全部光影最新版 zip，抽取 shaders/lang/en_US.lang 原始文件。
 * 产出：sources/<光影id>/<版本>/en_US.lang + sources/manifest.json（含自带中文检测结果）
 * sources/ 目录已加入 .gitignore（原语言文件版权归光影作者，不入库、不进站点）。
 *
 * 用法：node scripts/fetch-lang-sources.mjs [--threads 16] [--no-range]
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { openZip } from '../shared/zip-range.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG_FILE = join(ROOT, 'site/data/modrinth-catalog.json')
const OUT_DIR = join(ROOT, 'sources')
const MODRINTH_API = 'https://api.modrinth.com/v2'
const UA = 'shader-i18n-site/0.1.0 (lang source cache)'

const args = process.argv.slice(2)
const tIdx = args.indexOf('--threads')
const THREADS = Math.max(1, Math.min(32, Number(args[tIdx + 1]) || 16))
// --no-range：强制整包下载（A/B 对比与排障用），默认 Range 优先
const noRange = args.includes('--no-range')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const catalog = JSON.parse(readFileSync(CATALOG_FILE, 'utf8'))
const manifestFile = join(OUT_DIR, 'manifest.json')
const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : { entries: {} }
mkdirSync(OUT_DIR, { recursive: true })

let idx = 0
let done = 0, skipped = 0, failed = 0
// 汇总统计：Range/整包计数与下载字节数（并发下共享累加，JS 单线程无需加锁）
let rangeCount = 0, fullCount = 0, downloadedBytes = 0, fullBytes = 0
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
      // Range 优先按需抽取 en_US.lang；--no-range 或任何异常时 openZip 内部透明回退整包
      const zip = await openZip(file.url, {
        totalSize: file.size,
        headers: { 'User-Agent': UA },
        forceFull: noRange,
      })
      const langNames = zip.names.filter((n) => /^shaders\/lang\/[^/]+$/i.test(n))
      const nativeZh = langNames.some((n) => /^shaders\/lang\/zh_CN\.lang$/i.test(n))
      const enName = langNames.find((n) => /^shaders\/lang\/en_US\.lang$/i.test(n))
      let relPath = null
      if (enName) {
        relPath = join(s.id, shaderVersion, 'en_US.lang')
        const dest = join(OUT_DIR, relPath)
        mkdirSync(dirname(dest), { recursive: true })
        writeFileSync(dest, await zip.read(enName))
      }
      manifest.entries[s.id] = {
        shaderVersion,
        file: relPath,
        hasEn: !!enName,
        hasNativeZhCN: nativeZh,
        zipFile: file.filename,
        fetchedAt: new Date().toISOString().slice(0, 10),
        // 新增字段（向后兼容）：本次下载模式与实际下载字节数
        fetchMode: zip.fetchMode,
        bytesDownloaded: zip.bytesDownloaded,
      }
      if (zip.fetchMode === 'range') rangeCount++; else fullCount++
      downloadedBytes += zip.bytesDownloaded
      fullBytes += file.size
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
// 汇总：Range/整包计数与流量节省（若全整包需 fullBytes）
const savedPct = fullBytes > 0 ? ((1 - downloadedBytes / fullBytes) * 100).toFixed(1) : '0.0'
console.log(
  `Range ${rangeCount} 个 / 整包 ${fullCount} 个，共下载 ${(downloadedBytes / 1048576).toFixed(2)} MB` +
    `（若全整包需 ${(fullBytes / 1048576).toFixed(2)} MB，节省 ${savedPct}%）`,
)
