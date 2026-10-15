#!/usr/bin/env node
/**
 * 固定并发度的 worker pool（纯函数，无 IO/网络），pipeline 的**两个**并发维度共用：
 * - 光影级：LLM_CONCURRENCY（多条光影同时处理）；
 * - 分块级：LLM_CHUNK_CONCURRENCY（同一条光影内的多个分块同时翻译）。
 *
 * 抽到 lib 里是为了能被离线单测覆盖：块级并发的正确性只有两件事要证——并发度真的生效、
 * 结果与串行逐块一致（调用方按 index 回填，见 pipeline.mjs 的 results[index]）。
 */

// 单条光影内的分块并发度：默认 3（保守值），上限 4。
// 光影级并发 LLM_CONCURRENCY=10 在「只提交 1 条」时用不上，而块级串行会让这条慢慢翻；
// 但网关有账号级并发上限（实测并发过高会 503「无可用账号」），所以不跟着 10 走。
export const DEFAULT_CHUNK_CONCURRENCY = 3
export const MAX_CHUNK_CONCURRENCY = 4

/**
 * 固定并发度的 worker pool。concurrency = 1 时与改造前的串行 for 完全等价。
 * queue.shift() 与空值判断之间没有 await，单线程下不会把同一条派发给两个 worker。
 *
 * 派发顺序与串行一致（先来先派），但完成顺序不保证；调用方必须按条目的 index 回填结果，
 * 不能依赖 worker 的返回顺序。
 *
 * @param {Array} items 待处理条目
 * @param {(item: any) => Promise<void>} worker 单条处理函数
 * @param {number} concurrency 并发度（大于条目数时按条目数收缩，不会空转）
 */
export async function runPool(items, worker, concurrency) {
  const queue = [...items]
  const workers = Math.min(concurrency, queue.length)
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const entry = queue.shift()
      if (!entry) return
      await worker(entry)
    }
  }))
}
