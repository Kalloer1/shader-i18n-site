#!/usr/bin/env node
/**
 * CurseForge 目录采集的 `fileLength` 端到端测试（scripts/fetch-curseforge-catalog.mjs）。
 *
 * 背景：CF 目录条目原来没有文件大小，`probeZip()` 拿不到 totalSize 只能整包下载，
 * CF 侧探测收益为 0。修法是在采集时从「文件列表接口」的 `fileLength` 落进目录。
 *
 * 真跑 CLI 子进程 + 本地假 CF 服务（CF 真 API 在本机会被 WAF 403）。
 * 断言：
 * - 目录条目带 fileLength，且来自**文件列表接口**（不是 search 的 latestFiles）；
 * - 取的是「release 优先 + fileDate 倒序」的候选文件（与 pipeline 同口径）；
 * - allowModDistribution=false 的项目不发文件列表请求；
 * - 文件列表接口失败时沿用旧目录里的大小，不把整列清空；
 * - 数量偏少（<700）时拒绝覆盖（既有保护不回归）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 最小仓库：只拷采集脚本需要的部分。 */
function makeRepo({ oldCatalog = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cf-catalog-e2e-'))
  cpSync(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true })
  cpSync(join(ROOT, 'shared'), join(dir, 'shared'), { recursive: true })
  mkdirSync(join(dir, 'site/data'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'e2e', type: 'module', private: true }))
  writeFileSync(join(dir, 'site/data/modrinth-catalog.json'), JSON.stringify({ shaders: [] }))
  if (oldCatalog) {
    writeFileSync(join(dir, 'site/data/curseforge-catalog.json'), JSON.stringify(oldCatalog))
  }
  return dir
}

/**
 * 假 CF 服务。`mods` 是 search 返回的项目列表；`files` 是 cfId → 文件数组。
 * `failFiles` 里的 cfId 让文件列表接口返回 500（验证沿用旧值）。
 */
async function startFakeCf(state) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, state.baseUrl)
    const json = (body, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/v1/mods/search') {
      return json({
        data: state.mods,
        pagination: { totalCount: state.mods.length },
      })
    }
    const filesMatch = /^\/v1\/mods\/(\d+)\/files$/.exec(url.pathname)
    if (filesMatch) {
      const cfId = Number(filesMatch[1])
      state.filesRequests.push(cfId)
      if (state.failFiles.has(cfId)) return json({ error: 'boom' }, 500)
      const files = state.files[cfId]
      if (!files) return json({ data: [] })
      return json({ data: files })
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  state.baseUrl = `http://127.0.0.1:${server.address().port}`
  return server
}

function runCli(repo, state, env = {}) {
  const shim = join(tmpdir(), `cf-cat-shim-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(shim, `
const realFetch = globalThis.fetch
globalThis.fetch = (url, opts) => {
  const s = String(url)
  if (s.startsWith('https://api.curseforge.com/v1')) {
    return realFetch(s.replace('https://api.curseforge.com/v1', '${state.baseUrl}/v1'), opts)
  }
  return realFetch(s, opts)
}
export {}
`)
  const childEnv = { ...process.env }
  for (const k of ['HTTPS_PROXY', 'NODE_USE_ENV_PROXY']) delete childEnv[k]
  Object.assign(childEnv, {
    NODE_OPTIONS: `--import ${new URL(`file://${shim.replace(/\\/g, '/')}`).href}`,
    CURSEFORGE_API_KEY: 'dummy-cf-key',
    // 关掉请求间隔：700 个假项目的端到端测试不该被限流间隔拖成 90 秒。
    CF_FILE_REQUEST_DELAY_MS: '0',
    ...env,
  })
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['scripts/fetch-curseforge-catalog.mjs'], { cwd: repo, env: childEnv })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('exit', (code) => {
      rmSync(shim, { force: true })
      resolve({ code, out, err })
    })
  })
}

/** 生成 n 个假项目（默认 700 条，刚好过 MIN_EXPECTED 门槛）。 */
function fakeMods(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: 1000 + i,
    slug: `shader-${i}`,
    name: `Shader ${i}`,
    downloadCount: 1000 - i,
    authors: [{ name: 'a' }],
    links: { websiteUrl: `https://www.curseforge.com/minecraft/shaders/shader-${i}` },
    allowModDistribution: true,
    latestFiles: [{ id: 1 }], // search 里的 latestFiles 不带 fileLength —— 必须走文件列表接口
  }))
}

test('采集：fileLength 来自文件列表接口，取 release 优先 + fileDate 倒序的候选', { timeout: 180000 }, async () => {
  const mods = fakeMods(700)
  const state = {
    baseUrl: '',
    mods,
    filesRequests: [],
    failFiles: new Set(),
    files: {
      1000: [
        // 同 release 类型：fileDate 较新的应在前面
        { id: 11, fileName: 'old.zip', releaseType: 1, fileDate: '2026-01-01T00:00:00Z', fileLength: 111 },
        { id: 12, fileName: 'new.zip', releaseType: 1, fileDate: '2026-09-01T00:00:00Z', fileLength: 222 },
        // beta 比 release 新，但 release 优先
        { id: 13, fileName: 'beta.zip', releaseType: 2, fileDate: '2026-10-01T00:00:00Z', fileLength: 333 },
      ],
    },
  }
  const repo = makeRepo()
  let server
  try {
    server = await startFakeCf(state)
    const r = await runCli(repo, state)
    assert.equal(r.code, 0, r.out + r.err)

    const catalog = JSON.parse(readFileSync(join(repo, 'site/data/curseforge-catalog.json'), 'utf8'))
    assert.equal(catalog.count, 700)
    const first = catalog.mods.find((m) => m.cfId === 1000)
    assert.equal(first.fileLength, 222, '应取 release 类型里 fileDate 最新的那个文件')
    assert.equal(first.latestFileId, 12, 'latestFileId 应与 fileLength 指向同一个文件')

    // 没有文件的条目：不写 fileLength（探测侧按「无大小」走整包）
    const noFile = catalog.mods.find((m) => m.cfId === 1001)
    assert.equal('fileLength' in noFile, false, '没有文件时不该凭空造 fileLength')

    // 每个项目都查了文件列表
    assert.equal(state.filesRequests.length, 700)
  } finally {
    server?.close()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('采集：allowModDistribution=false 的项目不请求文件列表（省额度）', { timeout: 180000 }, async () => {
  const mods = fakeMods(700)
  mods[0].allowModDistribution = false
  mods[1].allowModDistribution = false
  const state = {
    baseUrl: '',
    mods,
    filesRequests: [],
    failFiles: new Set(),
    files: { 1002: [{ id: 1, fileName: 'a.zip', releaseType: 1, fileDate: '2026-01-01', fileLength: 500 }] },
  }
  const repo = makeRepo()
  let server
  try {
    server = await startFakeCf(state)
    const r = await runCli(repo, state)
    assert.equal(r.code, 0, r.out + r.err)

    assert.ok(!state.filesRequests.includes(1000), '禁止分发的项目不该查文件列表')
    assert.ok(!state.filesRequests.includes(1001), '禁止分发的项目不该查文件列表')
    assert.equal(state.filesRequests.length, 698, '其余 698 个项目都应查询')

    const catalog = JSON.parse(readFileSync(join(repo, 'site/data/curseforge-catalog.json'), 'utf8'))
    const blocked = catalog.mods.find((m) => m.cfId === 1000)
    assert.equal(blocked.allowModDistribution, false, '禁止分发的标记要原样保留')
    assert.equal('fileLength' in blocked, false, '禁止分发的条目不写大小')
    assert.equal(catalog.mods.find((m) => m.cfId === 1002)?.fileLength, 500)
  } finally {
    server?.close()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('采集：文件列表接口失败时沿用旧目录的大小（一次抖动不清空整列）', { timeout: 180000 }, async () => {
  const mods = fakeMods(700)
  const oldCatalog = {
    mods: [{ cfId: 1000, slug: 'shader-0', latestFileId: 99, fileLength: 4242 }],
  }
  const state = {
    baseUrl: '',
    mods,
    filesRequests: [],
    failFiles: new Set([1000]),
    files: {},
  }
  const repo = makeRepo({ oldCatalog })
  let server
  try {
    server = await startFakeCf(state)
    const r = await runCli(repo, state)
    assert.equal(r.code, 0, r.out + r.err)

    const catalog = JSON.parse(readFileSync(join(repo, 'site/data/curseforge-catalog.json'), 'utf8'))
    const first = catalog.mods.find((m) => m.cfId === 1000)
    assert.equal(first.fileLength, 4242, '取失败时沿用旧值')
    assert.equal(first.latestFileId, 99, 'latestFileId 与沿用的大小保持同一文件')
  } finally {
    server?.close()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('采集：数量明显偏少（<700）时拒绝覆盖已有目录（既有保护不回归）', { timeout: 120000 }, async () => {
  const state = { baseUrl: '', mods: fakeMods(10), filesRequests: [], failFiles: new Set(), files: {} }
  const repo = makeRepo()
  let server
  try {
    server = await startFakeCf(state)
    const r = await runCli(repo, state)
    assert.notEqual(r.code, 0, '数量不足应失败退出')
    assert.match(r.err, /拒绝覆盖已有目录/)
    assert.equal(existsSync(join(repo, 'site/data/curseforge-catalog.json')), false, '不该写出残缺目录')
  } finally {
    server?.close()
    rmSync(repo, { recursive: true, force: true })
  }
})
