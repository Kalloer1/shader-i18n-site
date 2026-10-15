#!/usr/bin/env node
/**
 * scripts/lib/llm-guard.mjs 的离线单元测试：推理模型「产不出译文」的早停判据。
 *
 * 真实失败样本（已实测）：模型 hy3 的 content 长度 = 0、reasoning_content 长度 = 379，
 * pipeline 只读 content，于是每块 100% 回退、每块重试 3 次，6 分钟预算被烧光却没有一行译文。
 * 判据必须在首块就把它拦下，同时不能把「块内全是数值型取值」这种正常情况误判成模型坏了。
 * 不发任何网络请求。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  EARLY_STOP_MIN_CHUNK_LINES,
  EmptyResponseError,
  isProviderNoOutput,
  providerUnusableMessage,
} from '../scripts/lib/llm-guard.mjs'

describe('isProviderNoOutput 首块早停判据', () => {
  it('hy3 实测形态：60 行全回退、解析出 0 行 → 判为产不出译文', () => {
    assert.equal(isProviderNoOutput({ chunkLength: 60, parsedLines: 0, fallback: 60, translatableLines: 60 }), true)
  })

  it('回显原文（键都在、值全同）→ 100% 回退也算产不出译文', () => {
    assert.equal(isProviderNoOutput({ chunkLength: 60, parsedLines: 60, fallback: 60, translatableLines: 60 }), true)
  })

  it('回退 90%（54/60）不算：模型有产出，属于「翻得差」，走原有重试/换模型', () => {
    assert.equal(isProviderNoOutput({ chunkLength: 60, parsedLines: 60, fallback: 54, translatableLines: 60 }), false)
  })

  it('整块都是数值/符号（无可翻译英文）→ 原样返回是正确行为，不判模型坏', () => {
    assert.equal(isProviderNoOutput({ chunkLength: 60, parsedLines: 60, fallback: 60, translatableLines: 0 }), false)
  })

  it(`首块不足 ${EARLY_STOP_MIN_CHUNK_LINES} 行（尾块样本太小）→ 不判`, () => {
    assert.equal(isProviderNoOutput({ chunkLength: 1, parsedLines: 1, fallback: 1, translatableLines: 1 }), false)
    assert.equal(isProviderNoOutput({ chunkLength: 9, parsedLines: 0, fallback: 9, translatableLines: 9 }), false)
    assert.equal(isProviderNoOutput({ chunkLength: 10, parsedLines: 0, fallback: 10, translatableLines: 10 }), true)
  })

  it('空块 → 不判', () => {
    assert.equal(isProviderNoOutput({ chunkLength: 0, parsedLines: 0, fallback: 0, translatableLines: 0 }), false)
  })
})

describe('EmptyResponseError 空正文错误类型', () => {
  it('默认文案是「返回为空」，可被 instanceof 识别（与网络错误区分）', () => {
    const err = new EmptyResponseError()
    assert.ok(err instanceof EmptyResponseError)
    assert.ok(err instanceof Error)
    assert.equal(err.name, 'EmptyResponseError')
    assert.equal(err.message, '返回为空')
  })
})

describe('providerUnusableMessage 失败文案', () => {
  it('含模型名、可读原因与下一步动作（会回写到队列 error）', () => {
    const msg = providerUnusableMessage(['hy3'])
    assert.match(msg, /^模型 hy3 无法产出译文/)
    assert.match(msg, /reasoning_content/)
    assert.match(msg, /请更换模型后重试$/)
  })

  it('多个模型用「、」连接', () => {
    assert.match(providerUnusableMessage(['hy3', 'step-5-preview']), /模型 hy3、step-5-preview 无法产出译文/)
  })
})
