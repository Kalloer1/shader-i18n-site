#!/usr/bin/env node
/**
 * Worker 免费层模型探测的判据单测。
 *
 * 为什么必须有真实调用判据：2026-10-20 实测两个元数据端点都不可信——
 * - `/health` 说 `Index-Translate-35B-A3B: true`，实际持续 504；
 * - `/health` 和 `/v1/models` 都**不列** syllable 系列，而它们是当时唯一能用的。
 * 所以只能「拿一句话真翻一次」，判据就是本文件锁的东西。
 *
 * 不发任何网络请求。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isFreeTierProbeAlive } from '../worker/index.js'

const reply = (content) => ({ choices: [{ message: { content } }] })

test('有中文译文 → 活着', () => {
  assert.equal(isFreeTierProbeAlive(200, reply('阴影强度')), true)
})

test('回显英文 → 判死（模型没在翻译，不能给管理员一个「能用」的假象）', () => {
  assert.equal(isFreeTierProbeAlive(200, reply('Shadow Strength')), false)
})

test('空正文 → 判死（推理模型把内容写进 reasoning_content 的典型形态）', () => {
  assert.equal(isFreeTierProbeAlive(200, reply('')), false)
  assert.equal(isFreeTierProbeAlive(200, reply('   ')), false)
  assert.equal(isFreeTierProbeAlive(200, null), false)
})

test('非 200 → 判死（504 超时、500 内部错误都是实测见过的死法）', () => {
  assert.equal(isFreeTierProbeAlive(504, reply('阴影强度')), false)
  assert.equal(isFreeTierProbeAlive(500, reply('阴影强度')), false)
  assert.equal(isFreeTierProbeAlive(400, reply('阴影强度')), false)
})

test('返回结构异常 → 判死而不抛', () => {
  assert.equal(isFreeTierProbeAlive(200, {}), false)
  assert.equal(isFreeTierProbeAlive(200, { choices: [] }), false)
  assert.equal(isFreeTierProbeAlive(200, { detail: 'internal development checkpoint' }), false)
})
