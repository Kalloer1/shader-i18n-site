#!/usr/bin/env node
/**
 * 每日目录同步（scripts/fetch-catalog.mjs）对「无英文源」黑名单的保留测试。
 *
 * 背景：黑名单由 pipeline 回写，同步脚本每天整体重写目录。若同步只保留
 * `noEnUsLang: true` 而丢掉 `noEnUsLangVersion`，版本判据就退化成永久跳过 ——
 * 上游补了 en_US.lang 也再也不会重探。这里真跑子进程 + 本地假 Modrinth。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const HITS = [
  { slug: 'alpha', project_id: 'pa', title: 'Alpha', author: 'a', downloads: 300, icon_url: '', description: '', versions: ['1.21'], gallery: [], color: 0, categories: [] },
  { slug: 'beta', project_id: 'pb', title: 'Beta', author: 'b', downloads: 200, icon_url: '', description: '', versions: ['1.21'], gallery: [], color: 0, categories: [] },
  { slug: 'gamma', project_id: 'pg', title: 'Gamma', author: 'c', downloads: 100, icon_url: '', description: '', versions: ['1.21'], gallery: [], color: 0, categories: [] },
]

function makeRepo(oldShaders) {
  const dir = mkdtempSync(join(tmpdir(), 'fetch-catalog-e2e-'))
  cpSync(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true })
  cpSync(join(ROOT, 'shared'), join(dir, 'shared'), { recursive: true })
  mkdirSync(join(dir, 'site/data'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'e2e', type: 'module', private: true }))
  writeFileSync(join(dir, 'site/data/modrinth-catalog.json'), JSON.stringify({ shaders: oldShaders }))
  writeFileSync(join(dir, 'site/data/shaders.json'), JSON.stringify({ shaders: [] }))
  return dir
}

async function startFakeModrinth(state) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, state.baseUrl)
    if (url.pathname === '/v2/search') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ hits: HITS, total_hits: HITS.length }))
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  state.baseUrl = `http://127.0.0.1:${server.address().port}`
  return server
}

function runCli(repo, state) {
  const shim = join(tmpdir(), `fetch-cat-shim-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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
  const env = { ...process.env, NODE_OPTIONS: `--import ${new URL(`file://${shim.replace(/\\/g, '/')}`).href}` }
  for (const k of ['HTTPS_PROXY', 'NODE_USE_ENV_PROXY']) delete env[k]
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['scripts/fetch-catalog.mjs'], { cwd: repo, env })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { out += d })
    p.on('exit', (code) => {
      rmSync(shim, { force: true })
      resolve({ code, out })
    })
  })
}

test('同步保留黑名单的**两个字段**（标记 + 判定版本）', { timeout: 120000 }, async () => {
  const repo = makeRepo([
    { id: 'alpha', noEnUsLang: true, noEnUsLangVersion: '1.2.3' },
    { id: 'beta', noEnUsLang: true }, // 历史数据：只有标记，没有版本
  ])
  const state = { baseUrl: '' }
  let server
  try {
    server = await startFakeModrinth(state)
    const r = await runCli(repo, state)
    assert.equal(r.code, 0, r.out)

    const catalog = JSON.parse(readFileSync(join(repo, 'site/data/modrinth-catalog.json'), 'utf8'))
    const byId = Object.fromEntries(catalog.shaders.map((s) => [s.id, s]))

    assert.equal(byId.alpha.noEnUsLang, true)
    assert.equal(byId.alpha.noEnUsLangVersion, '1.2.3', '判定版本必须一起保留，否则退化成永久跳过')

    assert.equal(byId.beta.noEnUsLang, true, '历史条目保留标记')
    assert.equal('noEnUsLangVersion' in byId.beta, false, '历史条目没有版本就不写空键')

    assert.equal('noEnUsLang' in byId.gamma, false, '未标记的条目不多出字段')
    assert.equal('noEnUsLangVersion' in byId.gamma, false)
  } finally {
    server?.close()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('同步同时保留 hasNativeZhCN 与黑名单（两者互不覆盖）', { timeout: 120000 }, async () => {
  const repo = makeRepo([
    { id: 'alpha', hasNativeZhCN: true, noEnUsLang: true, noEnUsLangVersion: '9.9' },
    { id: 'beta', hasNativeZhCN: false },
  ])
  const state = { baseUrl: '' }
  let server
  try {
    server = await startFakeModrinth(state)
    const r = await runCli(repo, state)
    assert.equal(r.code, 0, r.out)

    const catalog = JSON.parse(readFileSync(join(repo, 'site/data/modrinth-catalog.json'), 'utf8'))
    const byId = Object.fromEntries(catalog.shaders.map((s) => [s.id, s]))
    assert.equal(byId.alpha.hasNativeZhCN, true)
    assert.equal(byId.alpha.noEnUsLang, true)
    assert.equal(byId.alpha.noEnUsLangVersion, '9.9')
    assert.equal(byId.beta.hasNativeZhCN, false, 'false 也是已检测结果，必须保留')
    assert.equal(byId.gamma.hasNativeZhCN, null, '未检测的仍是 null')
  } finally {
    server?.close()
    rmSync(repo, { recursive: true, force: true })
  }
})
