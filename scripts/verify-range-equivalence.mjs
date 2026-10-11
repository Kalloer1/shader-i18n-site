#!/usr/bin/env node
/**
 * 联网等价性验证：对同一 zip URL 分别用 Range 与整包抽取 en_US.lang，
 * 逐字节 Buffer.equals 断言相同，并校验 CRC32 与长度。任一不等退出码 1。
 *
 * 用法：
 *   node scripts/verify-range-equivalence.mjs             # 全量 N=30 样本
 *   node scripts/verify-range-equivalence.mjs --limit 3   # 只跑前 3 个样本（快速冒烟）
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { openZip, crc32 } from '../shared/zip-range.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG_FILE = join(ROOT, 'site/data/modrinth-catalog.json')
const MODRINTH_API = 'https://api.modrinth.com/v2'
const UA = 'shader-i18n-site/0.1.0 (verify:range)'
const SAMPLE_SIZE = 30
// 已知样本：覆盖大/中/小（allium-shaders 约 13.63MB，complementary-reimagined 与 miniature-shader 为中小）
const KNOWN_IDS = ['allium-shaders', 'complementary-reimagined', 'miniature-shader']

const args = process.argv.slice(2)
const limitIdx = args.indexOf('--limit')
const limit = limitIdx >= 0 ? Math.max(1, Number(args[limitIdx + 1]) || SAMPLE_SIZE) : SAMPLE_SIZE
const n = Math.min(limit, SAMPLE_SIZE)

const catalog = JSON.parse(readFileSync(CATALOG_FILE, 'utf8'))

/** 构造 N 个样本：必测已知光影 + 按目录均匀抽样，覆盖大/中/小。 */
function buildSample(shaders, n) {
  const sample = []
  const seen = new Set()
  for (const id of KNOWN_IDS) {
    const s = shaders.find((x) => x.id === id)
    if (s && !seen.has(s.id)) {
      sample.push(s)
      seen.add(s.id)
    }
  }
  const need = n - sample.length
  if (need > 0) {
    const step = shaders.length / need
    // 均匀抽样；若撞上已知样本则顺延取下一个未选中的光影
    for (let i = 0; i < need; i++) {
      let idx = Math.floor(i * step)
      while (idx < shaders.length && seen.has(shaders[idx].id)) idx++
      if (idx >= shaders.length) break
      sample.push(shaders[idx])
      seen.add(shaders[idx].id)
    }
  }
  return sample.slice(0, n)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getLatestFile(projectId) {
  const res = await fetch(`${MODRINTH_API}/project/${projectId}/version`, {
    headers: { 'User-Agent': UA },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const versions = await res.json()
  const latest = versions?.[0]
  const file = latest?.files?.find((f) => f.primary) ?? latest?.files?.[0]
  if (!file) throw new Error('版本列表无文件')
  return file
}

const sample = buildSample(catalog.shaders, n)
const rows = []
let failed = 0

for (let i = 0; i < sample.length; i++) {
  const s = sample[i]
  process.stdout.write(`[${i + 1}/${sample.length}] ${s.id} ...`)
  try {
    const file = await getLatestFile(s.projectId)
    const url = file.url
    const totalSize = file.size

    // Range 优先（与生产路径一致）
    const zipRange = await openZip(url, { totalSize, headers: { 'User-Agent': UA } })
    const enNameR = zipRange.names.find((nm) => /^shaders\/lang\/en_US\.lang$/i.test(nm))

    // 整包对照
    const zipFull = await openZip(url, {
      totalSize,
      headers: { 'User-Agent': UA },
      forceFull: true,
    })
    const enNameF = zipFull.names.find((nm) => /^shaders\/lang\/en_US\.lang$/i.test(nm))

    let ok
    let detail
    if (enNameR && enNameF) {
      const [dataR, dataF] = await Promise.all([zipRange.read(enNameR), zipFull.read(enNameF)])
      const equal = Buffer.isBuffer(dataR) && Buffer.isBuffer(dataF) && dataR.equals(dataF)
      const lenOk = equal && dataR.length === dataF.length
      const crcOk = equal && crc32(dataR) === crc32(dataF)
      ok = equal && lenOk && crcOk
      detail = `Range(${zipRange.fetchMode}, ${zipRange.bytesDownloaded}B) vs Full(${zipFull.bytesDownloaded}B)`
      rows.push({
        id: s.id,
        sizeMB: (totalSize / 1048576).toFixed(2),
        mode: zipRange.fetchMode,
        equal,
        crcOk,
        lenOk,
      })
    } else if (!enNameR && !enNameF) {
      // 两模式一致地没有 en_US.lang：不算失败
      ok = true
      detail = '两模式一致：无 en_US.lang'
      rows.push({
        id: s.id,
        sizeMB: (totalSize / 1048576).toFixed(2),
        mode: zipRange.fetchMode,
        equal: true,
        crcOk: true,
        lenOk: true,
        noEn: true,
      })
    } else {
      ok = false
      detail = `en_US.lang 存在性不一致：Range=${!!enNameR} Full=${!!enNameF}`
      rows.push({
        id: s.id,
        sizeMB: (totalSize / 1048576).toFixed(2),
        mode: zipRange.fetchMode,
        equal: false,
        crcOk: false,
        lenOk: false,
      })
    }

    if (!ok) failed++
    console.log(ok ? ' ✓' : ` ✗ ${detail}`)
  } catch (err) {
    failed++
    console.log(` ✗ 异常：${err.message.slice(0, 120)}`)
    rows.push({
      id: s.id,
      sizeMB: '-',
      mode: 'error',
      equal: false,
      crcOk: false,
      lenOk: false,
    })
  }
  await sleep(100)
}

// ---------- 汇总表 ----------
console.log('\n=== verify:range 汇总 ===')
console.log(`${'id'.padEnd(26)} ${'MB'.padStart(8)}  模式      相等   CRC   长度`)
for (const r of rows) {
  const eq = r.equal ? '✓' : '✗'
  const crc = r.crcOk ? '✓' : '✗'
  const len = r.lenOk ? '✓' : '✗'
  const mode = r.mode === 'error' ? 'error' : r.mode.padEnd(7)
  const noEn = r.noEn ? '（无 en_US.lang）' : ''
  console.log(`${r.id.padEnd(26)} ${r.sizeMB.padStart(8)}  ${mode}   ${eq}     ${crc}    ${len}${noEn}`)
}
console.log(`\n样本 ${rows.length}，失败 ${failed}`)
process.exitCode = failed > 0 ? 1 : 0