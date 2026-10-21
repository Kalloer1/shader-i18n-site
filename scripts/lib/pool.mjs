#!/usr/bin/env node
/**
 * 固定并发度的 worker pool（纯函数，无 IO/网络），pipeline 的**两个**并发维度共用：
 * - 光影级：LLM_CONCURRENCY（多条光影同时处理）；
 * - 分块级：LLM_CHUNK_CONCURRENCY（同一条光影内的多个分块同时翻译）。
 *
 * 抽到 lib 里是为了能被离线单测覆盖：块级并发的正确性只有两件事要证——并发度真的生效、
 * 结果与串行逐块一致（调用方按 index 回填，见 pipeline.mjs 的 results[index]）。
 */

// 单条光影内的分块并发度：默认 4（2026-10-21 提，原 3）。
// 实测（免费层，30 行块，真实 lang 文件）：
//   并发 1 → 3.5 行/秒；2 → 6.5；3 → 9.0；4 → 11.7；6 → 14.5（成功率始终 100%）。
// 上限仍取 4：再高对公共服务（bilibili 无 SLA）是持续施压，且 35B 这类慢模型会让
// 在飞请求数虚高。用户已同意分两步走——先在 4 上验证 CI 出口表现，再考虑提。
// ⚠️ 旧注释里「网关账号级并发上限」只在走网关时成立：GATEWAY_ENABLED=0 时无网关。
export const DEFAULT_CHUNK_CONCURRENCY = 4
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
