#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG_FILE = join(root, 'site/data/modrinth-catalog.json')
const OUT_FILE = join(root, 'site/data/gallery-hires.json')
const MODRINTH_API = 'https://api.modrinth.com/v2'
const UA = 'shader-i18n-site/0.1.0 (hires sync)'
const top = 80
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.json()
}
const catalog = JSON.parse(readFileSync(CATALOG_FILE, 'utf8'))
const targets = (catalog.shaders ?? []).filter((s) => s.gallery?.length).slice(0, top)
console.log(`Top${targets.length}拉取中`)
const out = {}
let done = 0
for (const s of targets) {
  try {
    const detail = await getJSON(`${MODRINTH_API}/project/${s.id}`)
    const details = detail.gallery ?? []
    const byThumb = new Map(details.map((g) => [g.url, g.raw_url]))
    const raws = (s.gallery ?? []).slice(0, 3).map((thumb) => byThumb.get(thumb) ?? '')
    const featRaw = details.find((g) => g.featured)?.raw_url ?? details[0]?.raw_url ?? ''
    out[s.id] = raws.map((r) => r || featRaw).filter(Boolean)
    done++
    process.stdout.write(`\r${done}/${targets.length} ${s.id}`)
  } catch (e) {
    console.log(`\nskip ${s.id} ${e.message}`)
  }
  await sleep(300)
}
console.log()
writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n')
console.log(`wrote ${OUT_FILE} ${Object.keys(out).length}`)
