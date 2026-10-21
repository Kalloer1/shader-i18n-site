// CurseForge 可达性 + 英文源覆盖探针
// 用法：
//   不设 PROBE_SLUGS：取 CF shader 下载量前 20
//   设 PROBE_SLUGS="a,b,c"：按 slug 逐个查（用于测某批特定项目，例如 CF 独占集合）
import { openZip } from '../shared/zip-range.mjs'
import { resolveCfDownloadUrl } from './lib/cf-api.mjs'

const KEY = process.env.CURSEFORGE_API_KEY
const UA = 'shader-i18n-site/0.1.0'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const api = (p) => `https://api.curseforge.com/v1${p}`

/**
 * 从项目对象里挑出与「分发许可」相关的字段：名字含 allow 或 distribution（大小写不敏感）的全部原样保留，
 * 并额外补一个 allowModDistribution（缺失时为 null）。不猜字段名——字段名变了日志里也能直接看出来。
 */
function distributionFields(mod) {
  const out = {}
  if (!mod || typeof mod !== 'object') return out
  for (const [k, v] of Object.entries(mod)) {
    if (/allow|distribution/i.test(k)) out[k] = v
  }
  if (!('allowModDistribution' in out)) out.allowModDistribution = mod.allowModDistribution ?? null
  return out
}

async function cfGet(url) {
  const res = await fetch(url, { headers: { 'x-api-key': KEY, 'User-Agent': UA } })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}

if (!KEY) { console.error('CURSEFORGE_API_KEY 未设置，退出'); process.exit(1) }

const slugList = (process.env.PROBE_SLUGS || '').split(',').map((s) => s.trim()).filter(Boolean)
let mods = []
if (slugList.length) {
  console.log('MODE = slugs, count =', slugList.length)
  for (const slug of slugList) {
    const r = await cfGet(api(`/mods/search?gameId=432&classId=6552&slug=${encodeURIComponent(slug)}&pageSize=5`))
    const data = (r.json && r.json.data) || []
    const hit = data.find((m) => String(m.slug).toLowerCase() === slug.toLowerCase()) || data[0]
    if (hit) mods.push(hit)
    else console.log(JSON.stringify({ slug, note: `slug 未找到 (HTTP ${r.status})` }))
    await sleep(400)
  }
} else {
  const search = await cfGet(api('/mods/search?gameId=432&classId=6552&pageSize=50&index=0&sortField=6&sortOrder=desc'))
  console.log('SEARCH status =', search.status)
  if (!search.json || !search.json.data) {
    console.log('SEARCH 失败，响应前 300 字：', String(search.text).slice(0, 300))
    process.exit(1)
  }
  console.log('SEARCH totalCount =', search.json.pagination?.totalCount)
  mods = search.json.data.slice(0, 20)
}

const rows = []
for (const m of mods) {
  const row = { modId: m.id, slug: m.slug, name: m.name, downloads: m.downloadCount }
  try {
    // 单独取一次项目详情：search 结果里的许可字段可能被裁剪，GET /v1/mods/{id} 才是权威来源。
    const detail = await cfGet(api(`/mods/${m.id}`))
    row.detailStatus = detail.status
    row.distributionFields = distributionFields((detail.json && detail.json.data) || m)
    const files = await cfGet(api(`/mods/${m.id}/files`))
    if (files.status !== 200 || !files.json || !files.json.data || !files.json.data.length) {
      row.note = `files HTTP ${files.status}`
      rows.push(row); console.log(JSON.stringify(row)); await sleep(400); continue
    }
    const sorted = files.json.data.slice().sort((a, b) => String(b.fileDate).localeCompare(String(a.fileDate)))
    const f = sorted.find((x) => x.releaseType === 1) || sorted[0]
    row.fileId = f.id
    row.packBytes = f.fileLength
    if (f.fileLength > 50 * 1024 * 1024) {
      row.note = '过大跳过'; rows.push(row); console.log(JSON.stringify(row)); await sleep(400); continue
    }
    const du = await cfGet(api(`/mods/${m.id}/files/${f.id}/download-url`))
    if (du.status !== 200 || !du.json || !du.json.data) {
      row.downloadUrlStatus = `HTTP ${du.status}`
      row.note = `download-url HTTP ${du.status}`
      rows.push(row); console.log(JSON.stringify(row)); await sleep(400); continue
    }
    row.downloadUrlStatus = 'HTTP 200'
    // 解析成支持 Range 的最终地址（edge.forgecdn.net 带 Range 头会 404，见 cf-api.mjs）。
    row.downloadUrl = await resolveCfDownloadUrl(du.json.data)
    const zip = await openZip(row.downloadUrl, { totalSize: f.fileLength, headers: { 'User-Agent': UA } })
    row.packFetchStatus = 'HTTP 200'
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
    const msg = e && e.message ? e.message : String(e)
    row.note = 'error: ' + msg
    row.packFetchStatus = /HTTP\s+403/.test(msg) ? 'HTTP 403' : `其他（${msg.slice(0, 80)}）`
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

// 三列对照：slug | 分发许可字段（实际字段名+值） | download-url 下载结果（HTTP 200 / HTTP 403 / 其他）。
console.log('===DISTRIBUTION===')
console.log('slug | allowModDistribution(或实际字段名) | download-url 结果')
for (const r of rows) {
  const d = r.distributionFields || {}
  const keys = Object.keys(d)
  const allow = keys.length
    ? keys.map((k) => `${k}=${JSON.stringify(d[k])}`).join(' ')
    : '(项目对象里没有含 allow/distribution 的字段)'
  console.log(`${r.slug} | ${allow} | ${r.packFetchStatus || r.downloadUrlStatus || r.note || '未测'}`)
}