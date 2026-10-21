#!/usr/bin/env node
/**
 * 提供方抽象（issue #1）：**提示词与请求体形状是 provider 自己的属性**。
 *
 * 这组测试锁的是「改造后行为不变」——抽象本身不改变任何外部行为：
 * 网关 provider 的 messages 与请求体必须与改造前逐字一致。
 * 免费层接入（#2）才引入第二个 provider 形态。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SYSTEM_PROMPT,
  buildGatewayPrompt,
  createGatewayProvider,
  GATEWAY_TEMPERATURE,
  GATEWAY_MAX_TOKENS,
  GATEWAY_REQUEST_TIMEOUT_MS,
} from '../scripts/lib/providers.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('提示词：system 承载规则、user 只放待译文本（与改造前逐字一致）', () => {
  const input = 'option.SHADOWS=Shadows\noption.BLOOM=Bloom'
  const messages = buildGatewayPrompt(input)
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'system')
  assert.equal(messages[0].content, SYSTEM_PROMPT)
  assert.equal(messages[1].role, 'user')
  assert.equal(messages[1].content, input)
})

test('提示词：SYSTEM_PROMPT 的内容与 pipeline.mjs 改造前逐字一致', () => {
  // 逐字比对搬运前后的关键片段，防止搬运时被顺手「优化」。
  assert.ok(SYSTEM_PROMPT.startsWith('你是 Minecraft Java 版光影包（Iris / OptiFine）语言文件（.lang）的专业本地化译者。'))
  assert.ok(SYSTEM_PROMPT.includes('8. 语义不明的键保持英文原值，不要猜。'))
  assert.ok(SYSTEM_PROMPT.includes('chunk=区块｜biome=群系｜vanilla=原版｜shaderpack=光影包｜resource pack=资源包'))
  // 结尾不多不少：最后一个字符就是规则 8 的句号
  assert.equal(SYSTEM_PROMPT.at(-1), '。')
  // 规则条数：硬性 3 条 + 风格 5 条
  assert.equal(SYSTEM_PROMPT.match(/^\d+\. /gm).length, 8)
})

test('提示词：pipeline.mjs 不再自带 SYSTEM_PROMPT 常量（已移入 lib）', () => {
  const src = readFileSync(join(ROOT, 'scripts/pipeline.mjs'), 'utf8')
  assert.ok(!/^const SYSTEM_PROMPT = /m.test(src), 'pipeline.mjs 里不该再定义 SYSTEM_PROMPT')
  assert.ok(!/content: SYSTEM_PROMPT/.test(src), 'pipeline.mjs 不该再直接引用 SYSTEM_PROMPT')
})

test('网关 provider：请求体固定字段与改造前一致', () => {
  const p = createGatewayProvider({
    model: 'opencode-zen-free/space-bunny-free',
    url: () => 'https://example.invalid/v1/chat/completions',
    key: () => 'k',
    label: 'x',
  })
  const body = p.body([{ role: 'user', content: 'hi' }])
  assert.deepEqual(body, {
    model: 'opencode-zen-free/space-bunny-free',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: GATEWAY_TEMPERATURE,
    max_tokens: GATEWAY_MAX_TOKENS,
  })
  assert.equal(body.temperature, 0.2)
  assert.equal(body.max_tokens, 8192)
})

test('网关 provider：LLM_EXTRA_BODY 仍然浅合并进 body（现有行为不许变）', () => {
  const p = createGatewayProvider({
    model: 'm',
    url: () => 'https://example.invalid/v1',
    key: () => 'k',
    extraBody: { enable_thinking: false, top_p: 0.9 },
    label: 'x',
  })
  const body = p.body([])
  assert.equal(body.enable_thinking, false)
  assert.equal(body.top_p, 0.9)
  // 合并是浅合并：既有字段仍在
  assert.equal(body.temperature, 0.2)
  assert.equal(body.model, 'm')
})

test('网关 provider：extraBody 缺省时请求体不含额外键', () => {
  const p = createGatewayProvider({ model: 'm', url: () => 'u', key: () => 'k', label: 'x' })
  assert.deepEqual(Object.keys(p.body([])).sort(), ['max_tokens', 'messages', 'model', 'temperature'])
})

test('网关 provider：url / key 保持函数形式（调用时才读环境变量）', () => {
  let url = 'https://a.invalid/v1'
  let key = 'k1'
  const p = createGatewayProvider({ model: 'm', url: () => url, key: () => key, label: 'x' })
  assert.equal(p.url(), 'https://a.invalid/v1')
  url = 'https://b.invalid/v1'
  key = 'k2'
  assert.equal(p.url(), 'https://b.invalid/v1', 'url 必须每次重新求值')
  assert.equal(p.key(), 'k2', 'key 必须每次重新求值')
})

test('网关 provider：extract 从 choices[0].message.content 取正文', () => {
  const p = createGatewayProvider({ model: 'm', url: () => 'u', key: () => 'k', label: 'x' })
  assert.equal(p.extract({ choices: [{ message: { content: '译文' } }] }), '译文')
  assert.equal(p.extract({ choices: [] }), undefined)
  assert.equal(p.extract({}), undefined)
})

test('网关 provider：buildPrompt 挂在 provider 上（提示词是 provider 属性）', () => {
  const p = createGatewayProvider({ model: 'm', url: () => 'u', key: () => 'k', label: 'x' })
  assert.equal(typeof p.buildPrompt, 'function')
  assert.deepEqual(p.buildPrompt('A=B'), buildGatewayPrompt('A=B'))
})

// Bug 修复（实测 CI run 39520489773）：网关 provider 以前没有 requestTimeoutMs，
// chatOnce 只在该字段存在时才加单请求超时，于是网关请求**没有任何单请求超时** ——
// 一次挂起只能等外层候选 signal 中止（8 分钟）。免费层 12 秒就翻完的光影，
// 因 3 个分块转交回退池而整条超时，4.7% 的回退率却没能落盘。
test('网关 provider：默认带 90 秒单请求超时（挂住的请求快速失败，不拖满候选预算）', () => {
  const p = createGatewayProvider({ model: 'm', url: () => 'u', key: () => 'k', label: 'x' })
  assert.equal(p.requestTimeoutMs, GATEWAY_REQUEST_TIMEOUT_MS)
  assert.equal(p.requestTimeoutMs, 90000)
})

test('网关 provider：requestTimeoutMs 可覆盖（LLM_REQUEST_TIMEOUT_MS 由此注入）', () => {
  const p = createGatewayProvider({ model: 'm', url: () => 'u', key: () => 'k', label: 'x', requestTimeoutMs: 30000 })
  assert.equal(p.requestTimeoutMs, 30000)
})
