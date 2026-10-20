#!/usr/bin/env node
/**
 * 「一条光影的初翻」编排：记忆命中 → 断点进度 → 剩余行分块调 LLM → 合并结果。
 *
 * 为什么从 pipeline.mjs 抽出来：pipeline.mjs 顶层就会跑整个流水线，无法被单测 import，
 * 于是「记忆/进度/LLM 三者的优先级」「逐块记录进度」这些**真正决定产物**的逻辑
 * 从来没被跑过。抽成注入依赖的工厂后，tests/translate-entries.test.mjs 可以用假
 * translateChunk 复现整条路径，包括「第一次失败 → 第二次只补没翻成的行」。
 *
 * 优先级（与改造前一致，加上进度层）：
 *   1. 翻译记忆（全局 glossary + 本条局部增量）—— 最高，保持原行为；
 *   2. 断点进度 —— 只补记忆没命中的键；
 *   3. LLM —— 剩下的。
 * 进度只记录 judgeLine 判为成功的行（见 resume-progress.mjs），回退行天然不进进度。
 *
 * 本模块不碰网络、不读环境变量、不写文件；`onChunkDone` 用于让调用方即时落盘。
 */
import { runPool } from './pool.mjs'
import { stripSkeleton, shouldRememberMemory } from './glossary.mjs'
import { planLines, recordProgress } from './resume-progress.mjs'

/**
 * @param {object} deps
 * @param {(chunk: Array<[string,string]>, providers: Array<object>, signal: AbortSignal, opts: object) => Promise<{map: Map<string,string>, fallback: number, providerIds?: string[]}>} deps.translateChunk
 * @param {(list: Array<object>) => Array<object>} deps.nextProviderOrder 分块间轮转起始模型
 * @param {() => boolean} deps.everythingUnusable 所有提供方（含免费层）是否都不可用
 * @param {(ids: string[]) => string} deps.providerUnusableMessage
 * @param {number} deps.chunkLines 每个分块的行数
 * @param {number} deps.chunkConcurrency 分块并发
 * @param {(msg: string) => void} [deps.log]
 * @param {() => number} [deps.now] 毫秒时间戳（日志用；测试可注入）
 */
export function createTranslateEntries(deps) {
  const {
    translateChunk,
    nextProviderOrder,
    everythingUnusable,
    providerUnusableMessage,
    chunkLines,
    chunkConcurrency,
    log = console.log,
    now = () => Date.now(),
  } = deps

  /**
   * @param {Array<[string,string]>} pairs
   * @param {Array<object>} activeProviders
   * @param {AbortSignal} signal
   * @param {Map<string,string>} localGlossary 本条记忆增量（原地写入）
   * @param {object} p
   * @param {(skeleton: string) => string|undefined} p.lookup
   * @param {object} p.progress 本轮进度对象（原地写入）
   * @param {string} p.id
   * @param {string} p.version
   * @param {() => void} [p.onChunkDone] 每块完成后回调（调用方据此即时落盘）
   */
  return async function translateEntries(pairs, activeProviders, signal, localGlossary, {
    lookup,
    progress,
    id,
    version,
    onChunkDone = () => {},
  }) {
    const providerList = Array.isArray(activeProviders) ? activeProviders : [activeProviders]
    const out = new Map()
    let totalFallback = 0
    let llmCalls = 0

    // 第一步：决定哪些行直接复用、哪些要发 LLM（记忆优先，其次进度）。
    const plan = planLines(pairs, { lookup, progress, id, version })
    const { reuse, pending } = plan
    const sources = new Map(pairs)
    for (const [k, rec] of reuse) {
      out.set(k, rec.value)
      // 记忆命中的行也记进进度：进度文件的职责是「这条光影这一版翻到哪了」，
      // 只记 LLM 新翻的行会低估完成度（日志会说「剩 6 行」，实际只有 3 行要翻）。
      // 复用记忆的译文与产物里的值一致，删掉进度文件也只是退回记忆，安全。
      recordProgress(progress, k, sources.get(k) ?? '', rec.value)
    }
    const glossaryHit = plan.memoryHits
    const progressHit = plan.progressHits

    if (pending.length === 0) {
      log(`    翻译记忆覆盖 ${glossaryHit}/${pairs.length}${progressHit ? `，进度复用 ${progressHit}` : ''}，跳过 LLM`)
      onChunkDone()
      return { map: out, totalFallback: 0, glossaryHit, progressHit, llmCalls: 0, providersUsed: [] }
    }

    log(`    翻译记忆命中 ${glossaryHit}/${pairs.length}${progressHit ? `，进度复用 ${progressHit}` : ''}，剩余 ${pending.length} 个需 LLM 翻译`)

    // 全部模型都已判定「产不出译文」：直接失败，不再逐个分块空跑。
    const modelIds = providerList.map((p) => p.id)
    if (everythingUnusable(providerList)) throw new Error(providerUnusableMessage(modelIds))

    // 第二步：剩余行分块、并发、按块序合并（保证与串行时的插入顺序一致）。
    const chunks = []
    for (let i = 0; i < pending.length; i += chunkLines) chunks.push(pending.slice(i, i + chunkLines))
    if (chunks.length > 1) {
      log(`    分块并发 ${Math.min(chunkConcurrency, chunks.length)}（共 ${chunks.length} 块）`)
    }
    const results = new Array(chunks.length)
    await runPool(
      chunks.map((chunk, index) => ({ chunk, index })),
      async ({ chunk, index }) => {
        const label = `分块 ${index + 1}/${chunks.length} `
        log(`    ${label}开始（${chunk.length} 行）`)
        const started = now()
        const orderedProviders = providerList.length > 1 ? nextProviderOrder(providerList) : providerList
        results[index] = await translateChunk(chunk, orderedProviders, signal, {
          label,
          isFirstChunk: index === 0,
        })
        // 进度在**分块完成时立刻**记：整条超时/后续分块抛错时，已翻好的块仍然留下痕迹。
        // 键在分块间互不相交，并发写入顺序不影响最终内容。
        const sources = new Map(chunk)
        for (const [k, v] of results[index].map) recordProgress(progress, k, sources.get(k) ?? '', v)
        onChunkDone()
        log(`    ${label}完成：回退 ${results[index].fallback}/${chunk.length}，耗时 ${now() - started}ms`)
        // 本轮所有模型都已不可用**且免费层也不可用** → 立即整体失败，不再空跑剩余分块。
        if (everythingUnusable(providerList)) throw new Error(providerUnusableMessage(modelIds))
      },
      chunkConcurrency,
    )

    // 第三步：合并译文，并把「非回显」的新译文记入本条记忆增量。
    const providersUsed = new Set()
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]
      const { map, fallback, providerIds } = results[index]
      for (const pid of providerIds ?? []) providersUsed.add(pid)
      for (const [k, v] of map) {
        out.set(k, v)
        const source = chunk.find(([key]) => key === k)?.[1] ?? ''
        const sourceSkeleton = stripSkeleton(source)
        // 写入端守卫：值不是英文原文回显时才记入记忆（模型回显原文会被 translateChunk 原样放进 map）。
        if (shouldRememberMemory(sourceSkeleton, v, source, lookup(sourceSkeleton))) {
          localGlossary.set(sourceSkeleton, v)
        }
      }
      totalFallback += fallback
      llmCalls++
    }

    return { map: out, totalFallback, glossaryHit, progressHit, llmCalls, providersUsed: [...providersUsed] }
  }
}
