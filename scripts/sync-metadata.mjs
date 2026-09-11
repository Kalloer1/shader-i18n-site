#!/usr/bin/env node
/**
 * 同步光影元数据到 site/data/shaders.json（ADR-0002）。
 *
 * - Modrinth：无需密钥，直接拉取项目与成员信息。
 * - CurseForge：需要 key，从环境变量 CURSEFORGE_API_KEY 读取，绝不写入任何文件。
 *
 * 手动维护字段（nameCN / curseforge / quark / langVersions）永不被覆盖；
 * 同步结果写入 shader._meta.modrinth / shader._meta.curseforge。
 *
 * 用法：npm run sync
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const DATA_FILE = join(dirname(fileURLToPath(import.meta.url)), '../site/data/shaders.json')
const MODRINTH_API = 'https://api.modrinth.com/v2'
const CURSEFORGE_API = 'https://api.curseforge.com/v1'
const UA = 'shader-i18n-site/0.1.0 (metadata sync)'

const db = JSON.parse(readFileSync(DATA_FILE, 'utf8'))

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} <- ${url}`)
  return res.json()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function syncModrinth(shader) {
  const { slug } = shader.modrinth
  const project = await getJSON(`${MODRINTH_API}/project/${slug}`)
  const members = await getJSON(`${MODRINTH_API}/project/${project.id}/members`)
  const owner = members.find((m) => m.role === 'Owner') ?? members[0]
  shader.modrinth.projectId = project.id
  shader._meta = shader._meta ?? {}
  shader._meta.modrinth = {
    title: project.title,
    description: project.description,
    downloads: project.downloads,
    iconUrl: project.icon_url ?? '',
    author: owner?.user?.username ?? '',
    pageUrl: `https://modrinth.com/shader/${project.slug}`,
    lastSync: new Date().toISOString().slice(0, 10),
  }
  return `${project.title}（${project.downloads} 下载）`
}

async function syncCurseForge(shader) {
  const key = process.env.CURSEFORGE_API_KEY
  if (!key) return null
  const headers = { 'x-api-key': key, accept: 'application/json' }
  let mods
  if (shader.curseforge?.slug) {
    mods = await getJSON(
      `${CURSEFORGE_API}/mods/search?gameId=432&classId=6552&slug=${shader.curseforge.slug}`,
      headers,
    ).then((r) => r.data)
  }
  const mod = mods?.[0]
  if (!mod) return undefined
  shader.curseforge = shader.curseforge ?? {}
  shader.curseforge.slug = shader.curseforge.slug || mod.slug
  shader.curseforge.projectId = mod.id
  shader._meta = shader._meta ?? {}
  shader._meta.curseforge = {
    name: mod.name,
    downloads: mod.downloadCount,
    pageUrl: mod.links?.websiteUrl,
    lastSync: new Date().toISOString().slice(0, 10),
  }
  return `${mod.name}（${mod.downloadCount} 下载）`
}

let ok = 0
for (const shader of db.shaders) {
  const lines = [shader.id]
  try {
    if (shader.modrinth?.slug) lines.push(`  modrinth: ${await syncModrinth(shader)}`)
    const cf = await syncCurseForge(shader)
    if (cf === null) lines.push('  curseforge: 跳过（未设置 CURSEFORGE_API_KEY）')
    else if (cf === undefined) lines.push('  curseforge: 未匹配到项目')
    else lines.push(`  curseforge: ${cf}`)
    ok++
  } catch (err) {
    lines.push(`  失败: ${err.message}`)
    console.error(lines.join('\n'))
    continue
  }
  console.log(lines.join('\n'))
  await sleep(300) // Modrinth 限流礼貌间隔
}

writeFileSync(DATA_FILE, JSON.stringify(db, null, 2) + '\n')
console.log(`\n完成：${ok}/${db.shaders.length} 个光影元数据已写入 ${DATA_FILE}`)
