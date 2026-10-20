#!/usr/bin/env node
/**
 * 断点续翻的**端到端**测试：真跑 `scripts/pipeline.mjs`（子进程），用本地假服务
 * 替代 Modrinth 与 LLM，验证「整条判失败 → 进度落盘 → 下次只补没翻成的行 → 成功后删除进度」。
 *
 * 为什么必须真跑：
 * - `pipeline.mjs` 顶层就执行流水线，无法 import；因此它的胶水层（进度读写与
 *   translateEntries 的接线）只能靠子进程覆盖。历史上正是这块盲区连续踩到
 *   `timestamp is not defined` / `log is not defined`（见 pipeline-smoke.test.mjs）。
 * - lib 单测用的是假 translateChunk，证明不了「进度文件真的被写出来、真的被读回去」。
 *
 * 做法：在临时目录里搭一个**最小仓库**（只拷 scripts/ 与 shared/，数据文件用最小桩），
 * 用 `NODE_OPTIONS=--import <shim>` 把 https://api.modrinth.com/v2 改写到本地服务。
 * 全程离线，不碰真实仓库的文件。
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

// ---------- 最小 zip（Stored）----------
function crc32(buf) {
  let c, crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

function makeZip(files) {
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
  return Buffer.concat([localBuf, centralBuf, eocd])
}

// ---------- 固定数据 ----------
const EN_LANG = [
  '# demo lang', '',
  'option.ALPHA=Alpha', 'option.BETA=Beta', 'option.GAMMA=Gamma', 'option.DELTA=Delta',
  'option.EPSILON=Epsilon', 'option.ZETA=Zeta', 'option.ETA=Eta', 'option.THETA=Theta',
].join('\n') + '\n'
const ZIP = makeZip({ 'shaders/lang/en_US.lang': EN_LANG })
/** 假模型用的译文表（与 glossary 无关：桩 glossary 是空的）。 */
const ZH = {
  Alpha: '阿尔法', Beta: '贝塔', Gamma: '伽马', Delta: '德尔塔',
  Epsilon: '艾普西龙', Zeta: '泽塔', Eta: '伊塔', Theta: '西塔',
}
/** 第 1 轮故意回退的行（4/8 = 50% > 30% 闸门）。 */
const FAIL_ROUND1 = new Set(['Beta', 'Delta', 'Zeta', 'Theta'])

/** 搭一个最小仓库：只拷流水线运行所需的代码与数据桩。 */
function makeMinimalRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'partial-save-e2e-'))
  cpSync(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true })
  cpSync(join(ROOT, 'shared'), join(dir, 'shared'), { recursive: true })
  mkdirSync(join(dir, 'site/data'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'e2e', type: 'module', private: true }))
  writeFileSync(join(dir, 'site/data/modrinth-catalog.json'), JSON.stringify({ shaders: [] }))
  writeFileSync(join(dir, 'site/data/curseforge-catalog.json'), JSON.stringify({ mods: [] }))
  writeFileSync(join(dir, 'site/data/shaders.json'), JSON.stringify({ shaders: [] }))
  writeFileSync(join(dir, 'site/data/glossary.json'), JSON.stringify({}))
  return dir
}

/** 起假服务：Modrinth 元数据/下载 + OpenAI 兼容的整块翻译接口。 */
async function startFakeServer(state) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, state.baseUrl)
    const json = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname.endsWith('/version') && url.pathname.startsWith('/v2/project/')) {
      return json([{
        version_number: '1.0.0',
        files: [{ primary: true, url: `${state.baseUrl}/download/demo.zip`, filename: 'demo.zip' }],
      }])
    }
    if (url.pathname.startsWith('/v2/project/')) {
      return json({ id: 'e2eProjectId', slug: 'e2e-demo', title: 'E2E Demo' })
    }
    if (url.pathname === '/download/demo.zip') {
      res.writeHead(200, { 'Content-Type': 'application/zip' })
      return res.end(ZIP)
    }
    if (url.pathname === '/llm/chat/completions') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const parsed = JSON.parse(body)
        const prompt = (parsed.messages ?? []).map((m) => m.content).join('\n')
        const lines = prompt.split('\n').filter((l) => /^[\w.]+\s*=/.test(l))
        state.requests.push({ round: state.round, lines })
        const out = lines.map((line) => {
          const eq = line.indexOf('=')
          const key = line.slice(0, eq).trim()
          const value = line.slice(eq + 1).trim()
          if (state.round === 1 && FAIL_ROUND1.has(value)) return `${key}=${value}`
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

function runPipeline(repo, state, shim) {
  const env = { ...process.env }
  // 清掉所有可能改变行为的变量，保证环境可控。
  for (const k of ['LLM_API_KEY', 'SILICONFLOW_API_KEY', 'LLM_MODELS', 'LLM_MODEL', 'LLM_BASE_URL',
    'LLM_EXTRA_BODY', 'FREE_TIER_CONCURRENCY', 'CF_SOURCE', 'CURSEFORGE_API_KEY',
    'WORKER_URL', 'INTERNAL_STATUS_TOKEN', 'HTTPS_PROXY', 'NODE_USE_ENV_PROXY']) {
    delete env[k]
  }
  Object.assign(env, {
    NODE_OPTIONS: `--import ${pathToFileURL(shim).href}`,
    FREE_TIER_ENABLED: '1',
    FREE_TIER_BASE_URL: `${state.baseUrl}/llm`,
    FREE_TIER_MODEL: 'Index-Translate-35B-A3B',
  })
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['scripts/pipeline.mjs', '--ids', 'e2e-demo'], { cwd: repo, env })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { out += d })
    p.on('exit', (code) => resolve({ code, out }))
  })
}

test('整条判失败 → 进度落盘 → 第二轮只补没翻成的行 → 成功后删除进度', { timeout: 120000 }, async () => {
  const repo = makeMinimalRepo()
  const state = { round: 1, requests: [], baseUrl: '' }
  const shim = join(tmpdir(), `partial-save-shim-${process.pid}-${Date.now()}.mjs`)
  let server
  try {
    server = await startFakeServer(state)
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

    const progressPath = join(repo, 'sources/e2e-demo/1.0.0/.progress.json')
    const zhPath = join(repo, 'site/public/lang/e2e-demo/1.0.0/zh_CN.lang')

    // ---------- 第 1 轮：50% 回退 → 判失败 ----------
    const r1 = await runPipeline(repo, state, shim)
    assert.equal(r1.code, 0, r1.out)
    assert.match(r1.out, /回退率过高（4\/8）/, `第 1 轮应判失败：\n${r1.out}`)
    assert.equal(existsSync(zhPath), false, '判失败时不能写 zh_CN.lang')

    assert.ok(existsSync(progressPath), `第 1 轮应留下进度文件：\n${r1.out}`)
    const progress = JSON.parse(readFileSync(progressPath, 'utf8'))
    assert.equal(progress.id, 'e2e-demo')
    assert.equal(progress.version, '1.0.0')
    // 成功的 4 行（Alpha/Gamma/Epsilon/Eta）在进度里；回退的 4 行不在。
    assert.deepEqual(Object.keys(progress.lines).sort(), ['option.ALPHA', 'option.EPSILON', 'option.ETA', 'option.GAMMA'])
    for (const rec of Object.values(progress.lines)) {
      assert.notEqual(rec.value, rec.src, '回退行（值=英文）绝不能进进度')
    }
    assert.match(r1.out, /断点进度已保存：4\/8 行/, r1.out)

    const afterRound1 = state.requests.length

    // ---------- 第 2 轮：只补没翻成的 4 行 ----------
    state.round = 2
    const r2 = await runPipeline(repo, state, shim)
    assert.equal(r2.code, 0, r2.out)
    assert.match(r2.out, /发现断点进度：4\/8 行已翻/, r2.out)

    const sent = state.requests.slice(afterRound1).flatMap((r) => r.lines).sort()
    assert.deepEqual(sent, [
      'option.BETA=Beta', 'option.DELTA=Delta', 'option.THETA=Theta', 'option.ZETA=Zeta',
    ], '第二轮只应把第一轮没翻成的行发给模型')

    // ---------- 成功后：产物正确、进度删除 ----------
    assert.ok(existsSync(zhPath), `第二轮应产出 zh_CN.lang：\n${r2.out}`)
    const zh = readFileSync(zhPath, 'utf8')
    for (const [en, cn] of Object.entries(ZH)) {
      assert.ok(zh.includes(`=${cn}`), `产物缺少 ${en} 的译文\n${zh}`)
    }
    // 文件结构原样保留（注释与空行不能被吞）
    assert.ok(zh.includes('# demo lang'), '注释行必须原样保留')
    assert.ok(zh.includes('\n\n'), '空行必须原样保留')
    assert.equal(existsSync(progressPath), false, '全部成功后必须删除进度文件')

    // ---------- 逐字节一致的直接证据 ----------
    // 在一个**全新**仓库里一次跑成功（没有断点、没有进度文件），
    // 产物必须与「先失败再续翻」得到的字节完全相同。
    const cleanRepo = makeMinimalRepo()
    try {
      const cleanState = { round: 2, requests: [], baseUrl: '' }
      const cleanServer = await startFakeServer(cleanState)
      const cleanShim = join(tmpdir(), `partial-save-shim-clean-${process.pid}-${Date.now()}.mjs`)
      try {
        writeFileSync(cleanShim, `
const realFetch = globalThis.fetch
globalThis.fetch = (url, opts) => {
  const s = String(url)
  if (s.startsWith('https://api.modrinth.com/v2')) {
    return realFetch(s.replace('https://api.modrinth.com/v2', '${cleanState.baseUrl}/v2'), opts)
  }
  return realFetch(s, opts)
}
export {}
`)
        const rc = await runPipeline(cleanRepo, cleanState, cleanShim)
        assert.equal(rc.code, 0, rc.out)
        const cleanZh = readFileSync(join(cleanRepo, 'site/public/lang/e2e-demo/1.0.0/zh_CN.lang'), 'utf8')
        assert.equal(
          Buffer.from(zh).equals(Buffer.from(cleanZh)), true,
          '断点续翻的产物必须与一次跑完的产物逐字节一致',
        )
      } finally {
        cleanServer.close()
        rmSync(cleanShim, { force: true })
      }
    } finally {
      rmSync(cleanRepo, { recursive: true, force: true })
    }
  } finally {
    server?.close()
    rmSync(shim, { force: true })
    rmSync(repo, { recursive: true, force: true })
  }
})

test('进度文件损坏 / 不属于本条 → 当作没翻过，不崩、不产出错译', { timeout: 120000 }, async () => {
  const repo = makeMinimalRepo()
  const state = { round: 2, requests: [], baseUrl: '' }
  const shim = join(tmpdir(), `partial-save-shim-corrupt-${process.pid}-${Date.now()}.mjs`)
  let server
  try {
    server = await startFakeServer(state)
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
    // 放进一个「别的光影」的进度：id/version 与本次不符，且内容半截。
    mkdirSync(join(repo, 'sources/e2e-demo/1.0.0'), { recursive: true })
    writeFileSync(join(repo, 'sources/e2e-demo/1.0.0/.progress.json'), '{"schema":1,"id":"other","vers')

    const r = await runPipeline(repo, state, shim)
    assert.equal(r.code, 0, r.out)
    assert.doesNotMatch(r.out, /is not defined|ReferenceError/, r.out)
    // 全部行重新发给模型（没有可复用的进度）
    const sent = state.requests.flatMap((x) => x.lines)
    assert.equal(sent.length, 8, `应重翻全部 8 行：\n${r.out}`)
    assert.ok(existsSync(join(repo, 'site/public/lang/e2e-demo/1.0.0/zh_CN.lang')))
  } finally {
    server?.close()
    rmSync(shim, { force: true })
    rmSync(repo, { recursive: true, force: true })
  }
})
