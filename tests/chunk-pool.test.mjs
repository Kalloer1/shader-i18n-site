#!/usr/bin/env node
/**
 * scripts/lib/pool.mjs 的离线单元测试：**同一条光影内的分块并发池**。
 *
 * 改造点（3d322ab）：原来同一条光影的分块是串行 for 循环，只提交 1 条时用不上
 * LLM_CONCURRENCY=10 的并发；现在按 LLM_CHUNK_CONCURRENCY（默认 3、上限 4）并发跑分块。
 *
 * 这里必须证两件事，缺一不可：
 * 1. 并发度**真的**生效（假 worker 记录「同时在飞数量」，断言峰值 = 3）；
 * 2. 结果与串行**逐块一致**（调用方按 index 回填 results，不能依赖完成顺序）。
 * 不发任何网络请求。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runPool, DEFAULT_CHUNK_CONCURRENCY, MAX_CHUNK_CONCURRENCY } from '../scripts/lib/pool.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 假分块 worker：越靠后的分块越快返回，逼出「完成顺序 ≠ 派发顺序」。 */
function makeFakeChunkWorker() {
  let inFlight = 0
  let peak = 0
  const started = []
  const finished = []
  const worker = async (chunk) => {
    inFlight++
    peak = Math.max(peak, inFlight)
    started.push(chunk.index)
    await sleep((8 - chunk.index) * 5)
    inFlight--
    finished.push(chunk.index)
    return new Map([[`option.CHUNK_${chunk.index}`, `块 ${chunk.index} 的译文`]])
  }
  return { worker, started, finished, peak: () => peak }
}

const chunks = Array.from({ length: 8 }, (_, index) => ({ index, lines: 60 }))

describe('runPool 分块并发池', () => {
  it('并发度 3（分块默认值）真的生效：峰值同时在飞 = 3，且所有块都跑到', async () => {
    const { worker, peak, started } = makeFakeChunkWorker()
    const results = new Array(chunks.length)
    await runPool(chunks, async (chunk) => { results[chunk.index] = await worker(chunk) }, DEFAULT_CHUNK_CONCURRENCY)

    assert.equal(DEFAULT_CHUNK_CONCURRENCY, 3)
    assert.equal(peak(), DEFAULT_CHUNK_CONCURRENCY, '峰值并发应等于分块并发度')
    assert.equal(started.length, chunks.length, '每个分块都要被处理且只处理一次')
    assert.deepEqual([...started].sort((a, b) => a - b), chunks.map((c) => c.index))
  })

  it('结果与串行逐块一致：按 index 回填后与串行结果完全相同（完成顺序是乱的）', async () => {
    const serial = []
    for (const chunk of chunks) serial.push(await makeFakeChunkWorker().worker(chunk))

    const { worker, started, finished } = makeFakeChunkWorker()
    const results = new Array(chunks.length)
    await runPool(chunks, async (chunk) => { results[chunk.index] = await worker(chunk) }, DEFAULT_CHUNK_CONCURRENCY)

    assert.deepEqual(started, chunks.map((c) => c.index), '派发顺序应与串行一致')
    assert.notDeepEqual(finished, chunks.map((c) => c.index), '完成顺序应与派发顺序不同（否则这条断言没意义）')
    assert.deepEqual(results, serial)
  })

  it('并发度 1 与改造前的串行 for 等价：峰值 1、顺序即派发顺序', async () => {
    const { worker, peak, started } = makeFakeChunkWorker()
    await runPool(chunks, worker, 1)

    assert.equal(peak(), 1)
    assert.deepEqual(started, chunks.map((c) => c.index))
  })

  it('并发度超过条目数时按条目数收缩（不空转、不漏块）', async () => {
    const { worker, peak } = makeFakeChunkWorker()
    const few = chunks.slice(0, 2)
    const seen = []
    await runPool(few, async (chunk) => { seen.push(chunk.index); await worker(chunk) }, MAX_CHUNK_CONCURRENCY)

    assert.equal(peak(), 2)
    assert.deepEqual(seen.sort((a, b) => a - b), [0, 1])
  })

  it('worker 抛错时 runPool 也抛（调用方靠它做「全部模型不可用即整体失败」）', async () => {
    await assert.rejects(
      runPool(chunks, async () => { throw new Error('模型 hy3 无法产出译文') }, DEFAULT_CHUNK_CONCURRENCY),
      /无法产出译文/,
    )
  })
})
