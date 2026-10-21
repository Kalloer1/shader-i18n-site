#!/usr/bin/env node
/**
 * 逐句翻译（per-line）离线单测。
 *
 * 锁住三件事，都是实测踩出来的：
 * 1. 只发 value（不带 key）—— 这是把回显率从 15.5% 压到 6.5% 的关键；
 * 2. 回退判据与整块翻译同口径（空回 / 原样回显 / 格式码漂移 / 占位符漂移）；
 * 3. 并发度真的生效，且结果与串行一致（按 key 回填，不依赖完成顺序）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  translateChunkByLine,
  judgeLine,
  cleanLineReply,
  LINE_PROMPT_PREFIX,
  DEFAULT_LINE_CONCURRENCY,
} from '../scripts/lib/line-translator.mjs'

test('提示词只含 value，不含 key（实测把回显率从 15.5% 压到 6.5%）', async () => {
  const sent = []
  await translateChunkByLine({
    chunk: [['option.SHADOW_STRENGTH', 'Shadow Strength']],
    call: async (text) => {
      sent.push(text)
      return '阴影强度'
    },
    concurrency: 1,
  })
  assert.equal(sent.length, 1)
  assert.equal(sent[0], LINE_PROMPT_PREFIX + 'Shadow Strength')
  assert.ok(!sent[0].includes('option.SHADOW_STRENGTH'), '不该把 key 发给模型')
})

test('提示词要求「不要保留英文原文」（实测把回显率再降 4 个百分点）', () => {
  assert.ok(LINE_PROMPT_PREFIX.includes('不要保留英文原文'))
  assert.ok(LINE_PROMPT_PREFIX.includes('简体中文'))
})

test('清洗：去掉代码块围栏与包裹引号', () => {
  assert.equal(cleanLineReply('```\n阴影强度\n```'), '阴影强度')
  assert.equal(cleanLineReply('```text\n阴影强度\n```'), '阴影强度')
  assert.equal(cleanLineReply('"阴影强度"'), '阴影强度')
  assert.equal(cleanLineReply('“阴影强度”'), '阴影强度')
  assert.equal(cleanLineReply('  阴影强度  '), '阴影强度')
  assert.equal(cleanLineReply(null), '')
})

test('判据：空回话 / 原样回显 / 格式码漂移 / 占位符漂移 都算回退', () => {
  assert.equal(judgeLine('Shadow Strength', '').reason, 'empty')
  assert.equal(judgeLine('Clouds', 'Clouds').reason, 'echo')
  assert.equal(judgeLine('§e[+]§r Toggle', '切换').reason, 'format-code')
  assert.equal(judgeLine('Format: %s', '格式').reason, 'placeholder')
})

test('判据：正常译文通过，§ 码与占位符数量一致即可（位置可换）', () => {
  assert.equal(judgeLine('Shadow Strength', '阴影强度').ok, true)
  assert.equal(judgeLine('§e[+]§r Toggle', '§e[+]§r 切换').ok, true)
  assert.equal(judgeLine('Format: %s', '格式：%s').ok, true)
  // 中文语序下 %1$s / %2$s 会调换位置，数量一致就放行
  assert.equal(judgeLine('%1$s of %2$s', '%2$s 中的 %1$s').ok, true)
})

// 语义变更（Bug 修复）：无字母行曾经被计成 fallback，把数值密集的正常光影判死
// （实测 alphalook 4697 键里 3152 行是纯数字/百分比，回退率被顶到 67%）。
// 正确语义：保留原值就是**正确行为**，不算回退，单独记 untranslatable。
test('无字母的行不发请求、保留原值，且**不计入回退**（单独记 untranslatable）', async () => {
  const sent = []
  const { map, fallback, untranslatable, reasons } = await translateChunkByLine({
    chunk: [['value.NUM', '128'], ['value.SYM', '---']],
    call: async (t) => {
      sent.push(t)
      return 'x'
    },
    concurrency: 2,
  })
  assert.equal(sent.length, 0, '不该为纯数字/符号行发请求')
  assert.equal(map.get('value.NUM'), '128')
  assert.equal(map.get('value.SYM'), '---')
  assert.equal(fallback, 0, '保留原值不是回退')
  assert.equal(untranslatable, 2)
  assert.equal(reasons.noLetters, 2, 'noLetters 仍如实统计，日志要能看出这些行本来就不用翻')
})

test('并发真的生效：串行与并发结果一致，且并发更快', async () => {
  const chunk = Array.from({ length: 20 }, (_, i) => [`k.${i}`, `Option ${i}`])
  const call = async (text) => {
    await new Promise((r) => setTimeout(r, 10))
    return '选项' + text.replace('Option ', '')
  }
  const serial = await translateChunkByLine({ chunk, call, concurrency: 1 })
  const t0 = Date.now()
  const parallel = await translateChunkByLine({ chunk, call, concurrency: 10 })
  const elapsed = Date.now() - t0

  // 结果一致（按 key 回填，不依赖完成顺序）
  assert.deepEqual([...parallel.map].sort(), [...serial.map].sort())
  assert.equal(parallel.fallback, 0)
  // 20 行 × 10ms 串行要 200ms；并发 10 应远低于此
  assert.ok(elapsed < 120, `并发未生效：耗时 ${elapsed}ms`)
})

test('单行失败不影响其他行（按行回退，与整块翻译同语义）', async () => {
  const chunk = [['a', 'Alpha'], ['b', 'Beta'], ['c', 'Gamma']]
  const { map, fallback, reasons } = await translateChunkByLine({
    chunk,
    call: async (text) => {
      if (text.endsWith('Beta')) throw new Error('boom')
      if (text.endsWith('Gamma')) return 'Gamma' // echo
      return '阿尔法'
    },
    concurrency: 3,
  })
  assert.equal(map.get('a'), '阿尔法')
  assert.equal(map.get('b'), 'Beta', '失败行保留英文')
  assert.equal(map.get('c'), 'Gamma', '回显行保留英文')
  assert.equal(fallback, 2)
  assert.ok(reasons.echo >= 1)
})

test('默认并发度是 16（本机实测 32 是拐点，CI 出口未验证取一半）', () => {
  assert.equal(DEFAULT_LINE_CONCURRENCY, 16)
})

test('signal 已中断时不再发起新请求', async () => {
  const ctrl = new AbortController()
  ctrl.abort()
  let calls = 0
  const { map } = await translateChunkByLine({
    chunk: [['a', 'Alpha'], ['b', 'Beta']],
    call: async () => {
      calls++
      return '译文'
    },
    signal: ctrl.signal,
    concurrency: 1,
  })
  assert.equal(calls, 0)
  assert.equal(map.size, 0)
})
