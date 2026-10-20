#!/usr/bin/env node
/**
 * 探测阶段的**端到端**测试：真跑 `scripts/pipeline.mjs`（子进程），用本地假服务
 * 同时扮演 Modrinth、CurseForge 与 zip 下载源，验证：
 *
 * 1. 探测命中终态（自带中文 / 无 en_US.lang）时**没有下载整包** —— 直接数假服务收到的请求；
 * 2. 探测失败（Range 不可用）时回退整包，判定与副作用（hasNativeZhCN / noEnUsLang）不变；
 * 3. 需要翻译的包仍然走整包路径，产物与「关闭探测」逐字节一致；
 * 4. CF 分支同样探测，且候选循环里每个候选都探测、终态标记落到 shaders.json。
 *
 * 为什么必须真跑：pipeline.mjs 顶层就执行流水线、无法 import，探测与终态的接线
 * 只能靠子进程覆盖。做法照 tests/partial-save-e2e.test.mjs：临时目录里搭最小仓库，
 * 用 NODE_OPTIONS=--import <shim> 把 https://api.modrinth.com/v2 与 https://api.curseforge.com/v1
 * 改写到本地服务。全程离线。
 *
 * 假 zip 服务**如实实现 Range**（206 + Content-Range），所以这里能区分
 * 「只发了尾部窗口/条目 Range 请求」与「发了整包请求」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------- 最小 zip（Stored，可 padTo 撑大） ----------
function crc32(buf) {
  let c, crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 构造 zip；padTo 会在文件头部补零（EOCD/CD 的偏移同步修正）。 */
function makeZip(files, { padTo = 0 } = {}) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8')
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const localBuf = Buffer.concat(locals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(localBuf.length, 16)

  let body = Buffer.concat([localBuf, centralBuf, eocd])
  if (padTo > body.length) {
    const padLen = padTo - body.length
    const padded = Buffer.alloc(padTo)
    body.copy(padded, padLen)
    padded.writeUInt32LE(localBuf.length + padLen, padded.length - 22 + 16)
    // 每条 CD 的 localOffset 也要加上填充长度
    let p = padLen + localBuf.length
    for (let i = 0; i < Object.keys(files).length; i++) {
      const nameLen = padded.readUInt16LE(p + 28)
      const extraLen = padded.readUInt16LE(p + 30)
      const commentLen = padded.readUInt16LE(p + 32)
      padded.writeUInt32LE(padded.readUInt32LE(p + 42) + padLen, p + 42)
      p += 46 + nameLen + extraLen + commentLen
    }
    body = padded
  }
  return body
}

// ---------- 固定数据 ----------
const EN_LANG = [
  '# demo lang', '',
  'option.ALPHA=Alpha', 'option.BETA=Beta', 'option.GAMMA=Gamma', 'option.DELTA=Delta',
  'option.EPSILON=Epsilon', 'option.ZETA=Zeta', 'option.ETA=Eta', 'option.THETA=Theta',
].join('\n') + '\n'
const ZH_LANG = 'option.ALPHA=阿尔法\n'
const ZH = {
  Alpha: '阿尔法', Beta: '贝塔', Gamma: '伽马', Delta: '德尔塔',
  Epsilon: '艾普西龙', Zeta: '泽塔', Eta: '伊塔', Theta: '西塔',
}
// 全部撑到 1.2MB：高于 openZip 的 minRangeBytes 默认阈值（64KB）且远大于初始 64KB 尾部窗口，
// 这样「Range 探测」与「整包下载」在字节数上明显可区分。
const PAD = 1200000
const ZIPS = {
  // 需要翻译
  translate: makeZip({ 'shaders/lang/en_US.lang': EN_LANG }, { padTo: PAD }),
  // 自带中文
  native: makeZip(
    { 'shaders/lang/en_US.lang': EN_LANG, 'shaders/lang/zh_CN.lang': ZH_LANG },
    { padTo: PAD },
  ),
  // 无 en_US.lang（只有别的语种）
  noen: makeZip({ 'shaders/lang/ru_RU.lang': 'option.ALPHA=Альфа\n' }, { padTo: PAD }),
  // 小于 Range 阈值（64KB）的小包：自带中文
  small: makeZip({ 'shaders/lang/en_US.lang': EN_LANG, 'shaders/lang/zh_CN.lang': ZH_LANG }),
  // CF 外层目录结构：候选 1 无英文源，候选 2 自带中文
  cfNoen: makeZip({ 'CF/shaders/lang/ru_RU.lang': 'option.ALPHA=Альфа\n' }, { padTo: PAD }),
  cfNative: makeZip(
    { 'CF/shaders/lang/en_US.lang': EN_LANG, 'CF/shaders/lang/zh_CN.lang': ZH_LANG },
    { padTo: PAD },
  ),
}

/**
 * 搭一个最小仓库：只拷流水线运行所需的代码与数据桩。
 * modrinthIds 里的 id 写进 Modrinth 目录，让 `--ids` 命中 Modrinth 分支
 * （不在目录里的 id 会先被当作 CF slug 现场解析，走不到 Modrinth 路径）。
 */
function makeMinimalRepo(modrinthIds = []) {
  const dir = mkdtempSync(join(tmpdir(), 'range-probe-e2e-'))
  cpSync(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true })
  cpSync(join(ROOT, 'shared'), join(dir, 'shared'), { recursive: true })
  mkdirSync(join(dir, 'site/data'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'e2e', type: 'module', private: true }))
  writeFileSync(
    join(dir, 'site/data/modrinth-catalog.json'),
    JSON.stringify({ shaders: modrinthIds.map((id) => ({ id, projectId: id, title: `Title ${id}` })) }),
  )
  writeFileSync(join(dir, 'site/data/curseforge-catalog.json'), JSON.stringify({ mods: [] }))
  writeFileSync(join(dir, 'site/data/shaders.json'), JSON.stringify({ shaders: [] }))
  writeFileSync(join(dir, 'site/data/glossary.json'), JSON.stringify({}))
  return dir
}

/**
 * 假服务：Modrinth 元数据 + CF v1 API + 会 Range 的 zip 下载 + OpenAI 兼容翻译。
 * state.rangeMode=false 时对带 Range 头的请求返回 200 整包（模拟 CDN 不支持 Range），
 * openZip 会据此回退整包 —— 这就是「探测失败」路径。
 */
async function startFakeServer(state) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, state.baseUrl)
    const json = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    // ---- Modrinth ----
    if (url.pathname.endsWith('/version') && url.pathname.startsWith('/v2/project/')) {
      const slug = url.pathname.split('/')[3]
      const file = state.modrinthFiles[slug]
      if (!file) return json([])
      return json([{
        version_number: '1.0.0',
        files: [{ primary: true, url: `${state.baseUrl}/download/${file}.zip`, filename: `${file}.zip`, size: ZIPS[file].length }],
      }])
    }
    if (url.pathname.startsWith('/v2/project/')) {
      const slug = url.pathname.split('/')[3]
      return json({ id: `project-${slug}`, slug, title: `Title ${slug}` })
    }

    // ---- CurseForge v1 ----
    if (url.pathname.startsWith('/v1/mods/search')) {
      // 不在目录里 → 走 cfFindBySlug 现场解析
      const slug = url.searchParams.get('slug')
      return json({ data: [{ id: 9001, slug, name: `CF ${slug}` }] })
    }
    if (/^\/v1\/mods\/\d+\/files\/\d+\/download-url$/.test(url.pathname)) {
      const fileId = Number(url.pathname.split('/')[5])
      return json({ data: `${state.baseUrl}/download/${state.cfFiles[fileId]}.zip` })
    }
    if (/^\/v1\/mods\/\d+\/files$/.test(url.pathname)) {
      return json({
        data: state.cfCandidates.map((fileId, i) => ({
          id: fileId,
          fileName: `pack-${fileId}.zip`,
          releaseType: 1,
          // fileDate 决定候选顺序：数组里越靠前越新（与 candidates 的倒序排序一致）
          fileDate: `2026-10-0${state.cfCandidates.length - i}T00:00:00Z`,
          fileLength: ZIPS[state.cfFiles[fileId]].length,
        })),
      })
    }
    if (/^\/v1\/mods\/\d+$/.test(url.pathname)) {
      return json({ data: { id: 9001, slug: 'cf-demo', name: 'CF Demo', allowModDistribution: true } })
    }

    // ---- zip 下载（如实支持 Range）----
    if (url.pathname.startsWith('/download/')) {
      const key = url.pathname.slice('/download/'.length).replace(/\.zip$/, '')
      const buf = ZIPS[key]
      if (!buf) { res.writeHead(404); return res.end('no such zip') }
      const range = req.headers.range
      const record = { key, range: range ?? null, status: 0, bytes: 0 }
      state.zipRequests.push(record)
      if (range && state.rangeMode) {
        const m = /^bytes=(\d+)-(\d+)$/.exec(range)
        if (!m) { record.status = 416; res.writeHead(416); return res.end() }
        const start = Number(m[1])
        const end = Math.min(Number(m[2]), buf.length - 1)
        const slice = buf.subarray(start, end + 1)
        record.status = 206
        record.bytes = slice.length
        res.writeHead(206, {
          'Content-Type': 'application/zip',
          'Content-Range': `bytes ${start}-${end}/${buf.length}`,
          'Content-Length': String(slice.length),
        })
        return res.end(slice)
      }
      // 无 Range 头，或服务端不支持 Range → 整包 200
      record.status = 200
      record.bytes = buf.length
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': String(buf.length) })
      return res.end(buf)
    }

    // ---- 假 LLM ----
    if (url.pathname === '/llm/chat/completions') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const parsed = JSON.parse(body)
        const prompt = (parsed.messages ?? []).map((m) => m.content).join('\n')
        const lines = prompt.split('\n').filter((l) => /^[\w.]+\s*=/.test(l))
        state.llmRequests.push({ lines })
        const out = lines.map((line) => {
          const eq = line.indexOf('=')
          const key = line.slice(0, eq).trim()
          const value = line.slice(eq + 1).trim()
          return `${key}=${ZH[value] ?? value}`
        }).join('\n')
        return json({ choices: [{ message: { content: out } }] })
      })
      return
    }

    res.writeHead(404)
    res.end('not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  state.baseUrl = `http://127.0.0.1:${server.address().port}`
  return server
}

function writeShim(state) {
  const shim = join(tmpdir(), `range-probe-shim-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(shim, `
const realFetch = globalThis.fetch
globalThis.fetch = (url, opts) => {
  const s = String(url)
  // 测试钩子：让探测阶段（openZip）的所有请求都失败 —— Range 直接抛错，openZip 内部的
  // 整包回退也抛错，于是探测返回 UNKNOWN。流水线随后的**原路径**整包下载放行。
  // 只影响发往本地 zip 下载源的请求，Modrinth/CF API 与 LLM 不受影响。
  if (${JSON.stringify(state.throwProbe)} && s.startsWith('${state.baseUrl}/download/')) {
    if (opts?.headers?.Range) return Promise.reject(new Error('probe exploded'))
    if (!globalThis.__probeFullFailed) {
      globalThis.__probeFullFailed = true
      return Promise.reject(new Error('probe fallback exploded'))
    }
  }
  if (s.startsWith('https://api.modrinth.com/v2')) {
    return realFetch(s.replace('https://api.modrinth.com/v2', '${state.baseUrl}/v2'), opts)
  }
  if (s.startsWith('https://api.curseforge.com/v1')) {
    return realFetch(s.replace('https://api.curseforge.com/v1', '${state.baseUrl}/v1'), opts)
  }
  return realFetch(s, opts)
}
export {}
`)
  return shim
}

function runPipeline(repo, state, shim, ids) {
  const env = { ...process.env }
  for (const k of ['LLM_API_KEY', 'SILICONFLOW_API_KEY', 'LLM_MODELS', 'LLM_MODEL', 'LLM_BASE_URL',
    'LLM_EXTRA_BODY', 'FREE_TIER_CONCURRENCY', 'CF_SOURCE', 'WORKER_URL', 'INTERNAL_STATUS_TOKEN',
    'HTTPS_PROXY', 'NODE_USE_ENV_PROXY']) {
    delete env[k]
  }
  Object.assign(env, {
    NODE_OPTIONS: `--import ${pathToFileURL(shim).href}`,
    FREE_TIER_ENABLED: '1',
    FREE_TIER_BASE_URL: `${state.baseUrl}/llm`,
    FREE_TIER_MODEL: 'Index-Translate-35B-A3B',
    CURSEFORGE_API_KEY: 'dummy-cf-key',
  })
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['scripts/pipeline.mjs', '--ids', ids.join(',')], { cwd: repo, env })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { out += d })
    p.on('exit', (code) => resolve({ code, out }))
  })
}

/** 统计某个 zip 的整包请求（无 Range 头且响应 200）。 */
function fullDownloads(state, key) {
  return state.zipRequests.filter((r) => r.key === key && r.range === null)
}
/** 统计某个 zip 的 Range 请求。 */
function rangeRequests(state, key) {
  return state.zipRequests.filter((r) => r.key === key && r.range !== null)
}

function newState(overrides = {}) {
  return {
    baseUrl: '',
    rangeMode: true,
    throwProbe: false,
    zipRequests: [],
    llmRequests: [],
    modrinthFiles: {},
    cfFiles: {},
    cfCandidates: [],
    ...overrides,
  }
}

/** 起服务 + 仓库 + shim，跑完自动清理。 */
async function withEnv(state, fn) {
  // 目录里有 Modrinth 文件桩的 id 一律写进 Modrinth 目录；其余（CF 用例）留空。
  const repo = makeMinimalRepo(Object.keys(state.modrinthFiles))
  let server
  let shim
  try {
    server = await startFakeServer(state)
    shim = writeShim(state)
    return await fn({ repo, state, shim })
  } finally {
    server?.close()
    if (shim) rmSync(shim, { force: true })
    rmSync(repo, { recursive: true, force: true })
  }
}

test('探测命中「自带中文」：只发 Range 请求，不下载整包，副作用与判定不变', { timeout: 120000 }, async () => {
  const state = newState({ modrinthFiles: { 'native-demo': 'native' } })
  await withEnv(state, async ({ repo, shim }) => {
    const r = await runPipeline(repo, state, shim, ['native-demo'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /自带中文（v1\.0\.0）/, r.out)

    // 证据 1：整包请求为 0，Range 请求存在
    assert.equal(fullDownloads(state, 'native').length, 0, `不该下载整包：\n${r.out}`)
    assert.ok(rangeRequests(state, 'native').length >= 1, `应发出 Range 请求：\n${r.out}`)
    // 证据 2：下载字节远小于整包
    const bytes = rangeRequests(state, 'native').reduce((s, x) => s + x.bytes, 0)
    assert.ok(bytes < ZIPS.native.length / 4, `Range 下载字节 ${bytes} 应远小于整包 ${ZIPS.native.length}`)
    // 证据 3：没有调用 LLM
    assert.equal(state.llmRequests.length, 0, '自带中文不该调用 LLM')

    // 副作用：与原整包路径完全一致 —— Modrinth 分支标记的是 catalog 里的候选条目
    // （原 translateFromZip 只在 CF 分支补建 shaders.json 条目）。
    const catalog = JSON.parse(readFileSync(join(repo, 'site/data/modrinth-catalog.json'), 'utf8'))
    assert.equal(catalog.shaders.find((s) => s.id === 'native-demo')?.hasNativeZhCN, true, '必须写 hasNativeZhCN')
    // 不产出 lang 文件
    assert.equal(existsSync(join(repo, 'site/public/lang/native-demo')), false)
  })
})

test('探测命中「无 en_US.lang」：不下载整包，noEnUsLang 标记保留', { timeout: 120000 }, async () => {
  const state = newState({ modrinthFiles: { 'noen-demo': 'noen' } })
  await withEnv(state, async ({ repo, shim }) => {
    const r = await runPipeline(repo, state, shim, ['noen-demo'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /无 en_US\.lang（lang 文件: shaders\/lang\/ru_RU\.lang）/, r.out)

    assert.equal(fullDownloads(state, 'noen').length, 0, `不该下载整包：\n${r.out}`)
    assert.ok(rangeRequests(state, 'noen').length >= 1, r.out)
    assert.equal(state.llmRequests.length, 0)

    // 原路径的 noEnUsLang 写在 catalog 的候选条目上（Modrinth 分支不补建 shaders.json 条目）
    const catalog = JSON.parse(readFileSync(join(repo, 'site/data/modrinth-catalog.json'), 'utf8'))
    assert.equal(catalog.shaders.find((s) => s.id === 'noen-demo')?.noEnUsLang, true, '必须写 noEnUsLang')
    assert.equal(existsSync(join(repo, 'site/public/lang/noen-demo')), false)
  })
})

test('探测失败（服务端不支持 Range）→ 回退整包，判定与副作用不变', { timeout: 120000 }, async () => {
  const state = newState({ rangeMode: false, modrinthFiles: { 'native-demo': 'native' } })
  await withEnv(state, async ({ repo, shim }) => {
    const r = await runPipeline(repo, state, shim, ['native-demo'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /自带中文（v1\.0\.0）/, r.out)

    // 探测尝试过（带 Range 头），但服务端回了 200 → openZip 内部回退整包
    assert.ok(rangeRequests(state, 'native').length >= 1, '探测应发出过 Range 请求')
    assert.equal(fullDownloads(state, 'native').length, 1, `回退路径应恰好下载 1 次整包：\n${r.out}`)

    const catalog = JSON.parse(readFileSync(join(repo, 'site/data/modrinth-catalog.json'), 'utf8'))
    assert.equal(catalog.shaders.find((s) => s.id === 'native-demo')?.hasNativeZhCN, true)
  })
})

test('探测抛错 → 回退原整包路径，结论与副作用一致', { timeout: 120000 }, async () => {
  // 探测阶段被强制抛错（只在测试里用全局钩子模拟：生产里探测失败来自 openZip 自身异常）。
  // 断言：日志如实记录回退，最终判定与副作用仍由原整包路径给出。
  const state = newState({ modrinthFiles: { 'native-demo': 'native' }, throwProbe: true })
  await withEnv(state, async ({ repo, shim }) => {
    const r = await runPipeline(repo, state, shim, ['native-demo'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /探测失败.*回退整包路径/, `探测失败应记日志：\n${r.out}`)
    assert.match(r.out, /自带中文（v1\.0\.0）/, r.out)

    const catalog = JSON.parse(readFileSync(join(repo, 'site/data/modrinth-catalog.json'), 'utf8'))
    assert.equal(catalog.shaders.find((s) => s.id === 'native-demo')?.hasNativeZhCN, true)
  })
})

test('需要翻译的包：探测后仍下载整包，产物与「关闭探测」逐字节一致', { timeout: 180000 }, async () => {
  // 参照组：服务端不支持 Range → 探测等价于「直接整包」，走的是改造前的原路径。
  const baselineState = newState({ rangeMode: false, modrinthFiles: { 'translate-demo': 'translate' } })
  const baseline = await withEnv(baselineState, async ({ repo, shim }) => {
    const r = await runPipeline(repo, baselineState, shim, ['translate-demo'])
    assert.equal(r.code, 0, r.out)
    // 参照组：探测先回退一次整包（openZip 内部），随后原路径再下载一次 —— 这正是改造前的净开销。
    assert.ok(fullDownloads(baselineState, 'translate').length >= 1, r.out)
    return readFileSync(join(repo, 'site/public/lang/translate-demo/1.0.0/zh_CN.lang'))
  })

  // 实验组：Range 可用 → 探测走 Range，判定 NEEDS_TRANSLATION 后仍整包下载
  const state = newState({ modrinthFiles: { 'translate-demo': 'translate' } })
  await withEnv(state, async ({ repo, shim }) => {
    const r = await runPipeline(repo, state, shim, ['translate-demo'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /8 个键/, r.out)
    assert.ok(rangeRequests(state, 'translate').length >= 1, '探测应发出 Range 请求')
    assert.equal(fullDownloads(state, 'translate').length, 1, `需要翻译时必须下载整包：\n${r.out}`)

    const zh = readFileSync(join(repo, 'site/public/lang/translate-demo/1.0.0/zh_CN.lang'))
    assert.equal(Buffer.compare(zh, baseline), 0, '探测开/关的产物必须逐字节一致')
  })
})

test('包小于 Range 阈值：跳过探测，只下载一次整包（不白花一倍流量）', { timeout: 120000 }, async () => {
  const state = newState({ modrinthFiles: { 'small-demo': 'small' } })
  await withEnv(state, async ({ repo, shim }) => {
    const r = await runPipeline(repo, state, shim, ['small-demo'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /自带中文（v1\.0\.0）/, r.out)
    // 只应有 1 次整包请求，且没有任何 Range 请求
    assert.equal(fullDownloads(state, 'small').length, 1, `应只下载一次整包：\n${r.out}`)
    assert.equal(rangeRequests(state, 'small').length, 0, '小包不该发探测请求')

    const catalog = JSON.parse(readFileSync(join(repo, 'site/data/modrinth-catalog.json'), 'utf8'))
    assert.equal(catalog.shaders.find((s) => s.id === 'small-demo')?.hasNativeZhCN, true)
  })
})

test('CF 分支：每个候选都探测；无英文源→下一个候选，自带中文→终态并落盘标记', { timeout: 180000 }, async () => {
  const state = newState({
    cfFiles: { 101: 'cfNoen', 102: 'cfNative' },
    cfCandidates: [102, 101], // release 同类型内按 fileDate 倒序：102 先试
  })
  await withEnv(state, async ({ repo, shim }) => {
    const r = await runPipeline(repo, state, shim, ['cf-demo'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /自带中文（vcf-pack-102）/, r.out)

    // 候选 102 探测命中自带中文：不下载它的整包
    assert.equal(fullDownloads(state, 'cfNative').length, 0, `不该下载整包：\n${r.out}`)
    assert.ok(rangeRequests(state, 'cfNative').length >= 1, 'CF 探测应发出 Range 请求')
    // 候选 101 未被尝试（102 已是终态）
    assert.equal(state.zipRequests.filter((x) => x.key === 'cfNoen').length, 0, '终态后不该再探测其他候选')

    // 副作用：CF 条目必须落到 shaders.json（entry 是临时对象）
    const db = JSON.parse(readFileSync(join(repo, 'site/data/shaders.json'), 'utf8'))
    const entry = db.shaders.find((s) => s.id === 'cf-demo')
    assert.ok(entry, 'CF 条目应补建进 shaders.json')
    assert.equal(entry.source, 'curseforge')
    assert.equal(entry.hasNativeZhCN, true)
    assert.equal(state.llmRequests.length, 0)
  })
})

test('CF 分支：首个候选无 en_US.lang → 探测后换下一个候选，不下载整包', { timeout: 180000 }, async () => {
  const state = newState({
    cfFiles: { 101: 'cfNoen', 102: 'cfNative' },
    cfCandidates: [101, 102],
  })
  await withEnv(state, async ({ repo, shim }) => {
    const r = await runPipeline(repo, state, shim, ['cf-demo'])
    assert.equal(r.code, 0, r.out)
    // 候选 101：探测判无英文源（cfMode 下不算终态，继续下一个）
    assert.match(r.out, /候选文件 vcf-pack-101 无 en_US\.lang（lang 文件: CF\/shaders\/lang\/ru_RU\.lang），尝试下一个/, r.out)
    assert.match(r.out, /候选文件 101（cf-pack-101）失败: 候选文件无 en_US\.lang/, r.out)
    // 候选 102：探测判自带中文，终态
    assert.match(r.out, /自带中文（vcf-pack-102）/, r.out)

    assert.equal(fullDownloads(state, 'cfNoen').length, 0, `不该下载候选 101 的整包：\n${r.out}`)
    assert.equal(fullDownloads(state, 'cfNative').length, 0, `不该下载候选 102 的整包：\n${r.out}`)
    assert.ok(rangeRequests(state, 'cfNoen').length >= 1, '候选 101 应被探测')
    assert.ok(rangeRequests(state, 'cfNative').length >= 1, '候选 102 应被探测')

    const db = JSON.parse(readFileSync(join(repo, 'site/data/shaders.json'), 'utf8'))
    assert.equal(db.shaders.find((s) => s.id === 'cf-demo')?.hasNativeZhCN, true)
  })
})
