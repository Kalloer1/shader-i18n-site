// CurseForge 可达性 + 英文源覆盖探针（一次性诊断）
// 用途：本机被 CurseForge 的 CloudFront 边缘 WAF 拦截（API 与下载均 403），
// 需在 GitHub runner（不同出口 IP）上实测能否访问 API 与下载包，并顺便统计热门包是否含 shaders/lang/en_US.lang。
import { openZip } from '../shared/zip-range.mjs'

const KEY = process.env.CURSEFORGE_API_KEY
const UA = 'shader-i18n-site/0.1.0'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const api = (p) => `https://api.curseforge.com/v1${p}`

async function cfGet(url) {
  const res = await fetch(url, { headers: { 'x-api-key': KEY, 'User-Agent': UA } })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}

if (!KEY) {
  console.error('CURSEFORGE_API_KEY 未设置，退出')
  process.exit(1)
}

const search = await cfGet(api('/mods/search?gameId=432&classId=6552&pageSize=50&index=0&sortField=6&sortOrder=desc'))
console.log('SEARCH status =', search.status)
if (!search.json || !search.json.data) {
  console.log('SEARCH 失败，响应前 300 字：', String(search.text).slice(0, 300))
  process.exit(1)
}
console.log('SEARCH totalCount =', search.json.pagination?.totalCount)

const mods = search.json.data.slice(0, 20)
const rows = []
for (const m of mods) {
  const row = { modId: m.id, slug: m.slug, name: m.name, downloads: m.downloadCount }
  try {
    const files = await cfGet(api(`/mods/${m.id}/files`))
    if (files.status !== 200 || !files.json?.data?.length) {
      row.note = `files HTTP ${files.status}`
      rows.push(row); console.log(JSON.stringify(row)); await sleep(400); continue
    }
    const sorted = files.json.data.slice().sort((a, b) => String(b.fileDate).localeCompare(String(a.fileDate)))
    const f = sorted.find((x) => x.releaseType === 1) || sorted[0]
    row.fileId = f.id
    row.packBytes = f.fileLength
    if (f.fileLength > 50 * 1024 * 1024) { row.note = '过大跳过'; rows.push(row); console.log(JSON.stringify(row)); await sleep(400); continue }
    const du = await cfGet(api(`/mods/${m.id}/files/${f.id}/download-url`))
    if (du.status !== 200 || !du.json?.data) {
      row.note = `download-url HTTP ${du.status}`
      rows.push(row); console.log(JSON.stringify(row)); await sleep(400); continue
    }
    row.downloadUrl = du.json.data
    const zip = await openZip(du.json.data, { totalSize: f.fileLength, headers: { 'User-Agent': UA } })
    const enName = zip.names.find((n) => /shaders\/lang\/en_us\.lang$/i.test(n))
    row.fetchMode = zip.fetchMode
    row.downloadedBytes = zip.bytesDownloaded
    if (enName) {
      const buf = await zip.read(enName)
      row.hasEnUs = !!buf
      row.enBytes = buf ? buf.length : null
      row.enName = enName
    } else {
      row.hasEnUs = false
    }
  } catch (e) {
    row.note = 'error: ' + (e && e.message ? e.message : String(e))
  }
  rows.push(row)
  console.log(JSON.stringify(row))
  await sleep(400)
}

const ok = rows.filter((r) => r.hasEnUs)
console.log('===SUMMARY===')
console.log(JSON.stringify({
  sampled: rows.length,
  reachable: rows.filter((r) => !r.note && r.fetchMode).length,
  withEnUs: ok.length,
  withEnUsList: ok.map((r) => ({ slug: r.slug, enBytes: r.enBytes, packBytes: r.packBytes })),
  failed: rows.filter((r) => r.note).map((r) => ({ slug: r.slug, note: r.note })),
  rangeMode: rows.filter((r) => r.fetchMode === 'range').length,
  fullMode: rows.filter((r) => r.fetchMode === 'full').length,
}, null, 2))