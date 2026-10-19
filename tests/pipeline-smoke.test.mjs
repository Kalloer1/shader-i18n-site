#!/usr/bin/env node
/**
 * pipeline.mjs 的**子进程冒烟测试**（issue #4 的验收 + 胶水层回归）。
 *
 * 为什么需要它：`scripts/pipeline.mjs` 顶层就会跑整个流水线（读目录、下载、写盘），
 * 因此**无法被单测 import**。这留下一个真实覆盖盲区：胶水层里引用了未定义的标识符
 * 时，单测全绿、真实跑才炸。这不是假想 —— 重构免费层时确实连续踩到两次
 * （`timestamp is not defined`、`log is not defined`），都是真实跑才暴露的。
 *
 * 这里用子进程跑真实的 CLI 入口，断言：
 * - 无 key 时**不再 exit 2**，而是警告后继续（issue #4 的核心）；
 * - 无 key 且免费层被显式关闭时，仍然硬失败（没有可用提供方时不该假装能干活）；
 * - 启动输出如实反映两层结构（回退池为空 / 免费层优先）。
 *
 * 全部离线：用 `--ids __nonexistent__` 让流水线在「解析条目」阶段就结束，不触网。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PIPELINE = join(ROOT, 'scripts/pipeline.mjs')

/** 跑一次 pipeline，清掉所有 LLM_* 与代理变量，保证环境可控。 */
function runPipeline(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv }
  for (const k of ['LLM_API_KEY', 'SILICONFLOW_API_KEY', 'LLM_MODELS', 'LLM_MODEL', 'LLM_BASE_URL', 'LLM_EXTRA_BODY', 'HTTPS_PROXY', 'NODE_USE_ENV_PROXY', 'FREE_TIER_ENABLED']) {
    if (!(k in extraEnv)) delete env[k]
  }
  const r = spawnSync(process.execPath, [PIPELINE, '--ids', '__nonexistent__'], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 120000,
  })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

test('无 key：不再 exit 2，警告后以「免费层单跑」继续（issue #4）', () => {
  const { code, out } = runPipeline()
  assert.notEqual(code, 2, `不该硬失败；实际输出：\n${out}`)
  assert.equal(code, 0, `应正常结束；实际输出：\n${out}`)
  assert.match(out, /警告：未设置 LLM_API_KEY/, '应打印警告')
  assert.match(out, /免费层单跑/)
})

test('无 key：启动输出如实反映「回退池为空」与「免费层优先」', () => {
  const { out } = runPipeline()
  assert.match(out, /LLM 提供方：（无，回退池为空）/, '回退池为空要说清楚')
  assert.match(out, /免费层（优先）：Index-Translate-35B-A3B/, '免费层要单独打印')
})

test('无 key + 免费层被显式关闭 → 仍硬失败 exit 2（没有可用提供方）', () => {
  const { code, out } = runPipeline({ FREE_TIER_ENABLED: '0' })
  assert.equal(code, 2, `应硬失败；实际输出：\n${out}`)
  assert.match(out, /没有任何可用提供方/)
})

test('有 key：不打印「免费层单跑」警告，回退池正常列出', () => {
  const { code, out } = runPipeline({ LLM_API_KEY: 'dummy-key-for-smoke-test' })
  assert.equal(code, 0, `应正常结束；实际输出：\n${out}`)
  assert.ok(!out.includes('免费层单跑'), '有 key 时不该出现该警告')
  assert.match(out, /LLM 提供方：opencode-zen-free\/space-bunny-free/, '应列出默认模型池')
})

test('免费层默认开启（不设 FREE_TIER_ENABLED 时也是开的）', () => {
  const { out } = runPipeline({ LLM_API_KEY: 'dummy' })
  assert.match(out, /免费层（优先）：Index-Translate-35B-A3B/)
})

test('免费层可通过 FREE_TIER_ENABLED=0 关闭', () => {
  const { out } = runPipeline({ LLM_API_KEY: 'dummy', FREE_TIER_ENABLED: '0' })
  assert.match(out, /免费层（优先）：已通过 FREE_TIER_ENABLED 关闭/)
})

test('胶水层无未定义标识符：启动路径不抛 ReferenceError', () => {
  const { out } = runPipeline()
  assert.ok(!/is not defined/.test(out), `不该有未定义标识符；实际输出：\n${out}`)
  assert.ok(!/ReferenceError/.test(out), `不该有 ReferenceError；实际输出：\n${out}`)
})

/**
 * 回归：什么都没做时不得重写数据文件。
 *
 * 真实缺陷（2026-10-19）：`persist()` / `persistGlossary()` 曾无条件重写
 * catalog(2MB) + shaders + glossary(39k 条)，连 `--ids __nonexistent__` 这种
 * 零工作量运行也写。`npm test` 会**并行**跑多个测试文件，多个 pipeline 子进程
 * 同时重写同一对文件 → Windows 上偶发
 * `UNKNOWN: unknown error, open 'glossary.json'` → deploy 闸门随机变红
 * （实测修前 5 次里红 3 次，修后 10/10 绿）。
 *
 * 这里用 mtime + 内容双重断言：文件必须**完全没被碰过**。
 */
test('无改动时不得重写数据文件（防并发写文件锁导致 deploy 随机变红）', () => {
  const files = ['site/data/modrinth-catalog.json', 'site/data/shaders.json', 'site/data/glossary.json']
  const before = files.map((f) => {
    const p = join(ROOT, f)
    return { f, mtime: statSync(p).mtimeMs, size: statSync(p).size }
  })
  const { code } = runPipeline({ LLM_API_KEY: 'dummy' })
  assert.equal(code, 0)
  for (const b of before) {
    const p = join(ROOT, b.f)
    const now = statSync(p)
    assert.equal(now.mtimeMs, b.mtime, `${b.f} 不该被重写（mtime 变了）`)
    assert.equal(now.size, b.size, `${b.f} 不该被重写（大小变了）`)
  }
})
