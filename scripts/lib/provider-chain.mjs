#!/usr/bin/env node
/**
 * 两层的**分块翻译链**：免费层优先，失败落回退池（issue #2 / #3 / #5）。
 *
 * 为什么抽到 lib：这段是「免费层到底有没有生效」的唯一判据所在，必须能被离线单测覆盖。
 * pipeline.mjs 顶层就会跑整个流水线（读目录、下载、写盘），import 它等于跑一遍生产流程，
 * 因此把决策逻辑与 IO 分离：本模块**不碰网络、不读环境变量、不写文件**，
 * 网络调用由调用方以 `call(provider, messages, signal)` 注入。
 *
 * 三层关注点，各自独立可测：
 * 1. `parseLangLines`  —— 模型回话 → Map（纯解析）
 * 2. `evaluateOutput`  —— Map → {map, fallback, missingKeys}（纯计算）
 * 3. `translateChunkTwoLayer` —— 编排：先免费层，再回退池
 */

/**
 * 解析模型回话里的 `键=值` 行，**同时**报告重复键。
 *
 * 为什么必须报告重复键：模型有时会把 `option.X.comment` 重命名成 `option.X`。
 * 若 `option.X` 本身也在本块里，两个键就撞车——单纯 last-wins 会让 `option.X` 拿到
 * `.comment` 的长句，**静默污染界面文案**（键集合反而看起来是完整的，回退率也是 0，
 * 现有判据完全拦不住）。实测该情形在真实分块上 20 轮 0 次，但它一旦发生就是脏数据，
 * 因此把重复键单独标出来，由调用方降级处理。
 *
 * 注意 `eq <= 0`：等号在行首（空键）或整行没有等号都跳过，
 * 这样模型输出的解释性文字不会污染键集合。
 *
 * @param {string} text
 * @returns {{got: Map<string,string>, duplicated: Set<string>}}
 */
export function parseLangResponse(text) {
  const got = new Map()
  const duplicated = new Set()
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (got.has(key)) duplicated.add(key)
    got.set(key, line.slice(eq + 1).trim())
  }
  return { got, duplicated }
}

/**
 * 解析模型回话里的 `键=值` 行（只要 Map 的便捷形式）。
 *
 * @param {string} text
 * @returns {Map<string,string>}
 */
export function parseLangLines(text) {
  return parseLangResponse(text).got
}

/**
 * 把模型回话对齐到待译分块：命中的用译文，未命中或译文与原文相同的算**回退**。
 *
 * 「译文 === 原文」计回退是有意的：模型回显英文不是译文，
 * 与 pipeline 判回退的 `zh !== v` 同口径（大小写/空格差异不误判）。
 *
 * **部分回退是合法的**：模型漏掉几个键（实测免费层会丢掉孤立的 `.comment` 后缀）时，
 * 只把那几行回退成英文，其余译文照用。全有或全无的判据会把整块好译文扔掉 ——
 * 在「免费层单跑」模式下（网关不可用）那等于整个光影失败。
 *
 * 重复键视为**该键不可信**，同样按行回退（防静默污染，见 parseLangResponse）。
 *
 * @param {Array<[string,string]>} chunk
 * @param {Map<string,string>} got
 * @param {Set<string>} [duplicated] 回话里重复出现的键
 */
export function evaluateOutput(chunk, got, duplicated = new Set()) {
  const map = new Map()
  let fallback = 0
  const missingKeys = []
  const duplicatedKeys = []
  for (const [k, v] of chunk) {
    // 重复键不可信：哪一行对应哪一行分不清，宁可回退也不要写错。
    if (duplicated.has(k)) {
      map.set(k, v)
      fallback++
      duplicatedKeys.push(k)
      continue
    }
    const zh = got.get(k)
    if (zh && zh !== v) map.set(k, zh)
    else {
      map.set(k, v)
      fallback++
      if (!got.has(k)) missingKeys.push(k)
    }
  }
  return { map, fallback, missingKeys, duplicatedKeys }
}

/** 回退率阈值：超过则视为该提供方这次翻得不够好。 */
export function fallbackThreshold(chunkLength, ratio = 0.1) {
  return Math.ceil(chunkLength * ratio)
}

/**
 * 试一次免费层。
 *
 * 免费层的失败处理与回退池**故意不同**（见 issue #3）：
 * - 单次尝试、无退避（由 provider 的 `maxAttempts` 在调用方生效）、60 秒超时；
 * - 失败时调 `onFailure()`（**连续 2 次**才熔断），并返回 null 让调用方落回退池。
 *
 * **部分回退不算失败**：模型漏掉几个键时只把那几行回退成英文，其余译文照用。
 * 实测免费层会以约 60% 的概率丢掉孤立的 `.comment` 后缀（同名主键已命中记忆、
 * 输入里只剩 `.comment` 时），若按「键集合不完整即整块失败」处理，
 * 28 行丢 2 个键就会把 26 条好译文全扔掉 —— 在「免费层单跑」模式下等于整个光影失败。
 * 整体质量由调用方的回退率阈值把关（>10% 才转交回退池）。
 *
 * @returns {Promise<{map: Map<string,string>, fallback: number}|null>}
 */
export async function tryFreeTier({ chunk, provider, call, signal, log = () => {} }) {
  if (!provider) return null
  let text
  try {
    text = await call(provider, signal)
  } catch (err) {
    log(`[免费层] 失败（${err?.message?.slice(0, 120) ?? err}），降级到回退池`)
    return null
  }
  const { got, duplicated } = parseLangResponse(text)
  const evaluated = evaluateOutput(chunk, got, duplicated)
  if (evaluated.duplicatedKeys.length > 0) {
    log(`[免费层] 回话里有重复键 ${evaluated.duplicatedKeys.length} 个（疑似键名重命名撞车），这些行按回退处理`)
  }
  if (evaluated.missingKeys.length > 0) {
    log(`[免费层] 漏掉 ${evaluated.missingKeys.length}/${chunk.length} 个键，这些行回退成英文（其余译文照用）`)
  }
  return evaluated
}

/**
 * 装配一个 `translateChunk(chunk, activeProviders, signal, opts)` 函数。
 *
 * 为什么连装配也要抽出来：这里曾经是**真实覆盖盲区**。pipeline.mjs 顶层就会跑整个
 * 流水线，无法被单测 import，所以它的胶水层（把环境状态注入纯逻辑）从来没被跑过 ——
 * 重构时接连踩到 `timestamp is not defined` 与 `log is not defined`，单测全绿、真实跑才炸。
 * 把装配变成可注入依赖的工厂后，这个盲区就没了。
 *
 * @param {object} deps
 * @param {object|null} deps.freeTierProvider 免费层 provider
 * @param {() => boolean} deps.isFreeTierUsable 免费层本轮是否可用（熔断状态在调用方）
 * @param {() => void} deps.onFreeTierFailure
 * @param {() => void} deps.onFreeTierSuccess
 * @param {(id: string) => boolean} deps.isUnusable
 * @param {(id: string) => void} deps.markUnusable
 * @param {(provider: object, messages: Array, signal: AbortSignal) => Promise<string>} deps.callProvider
 * @param {(p: object) => boolean} deps.isNoOutput
 * @param {(msg: string) => void} [deps.log]
 * @param {(msg: string) => void} [deps.logError] 失败/降级类日志
 */
export function createChunkTranslator(deps) {
  const {
    freeTierProvider,
    isFreeTierUsable,
    onFreeTierFailure,
    onFreeTierSuccess,
    isUnusable,
    markUnusable,
    callProvider,
    isNoOutput,
    log = console.log,
  } = deps

  return async function translateChunk(chunk, activeProviders, signal, { label = '', isFirstChunk = false } = {}) {
    const providerList = (Array.isArray(activeProviders) ? activeProviders : [activeProviders])
      .filter((p) => !isUnusable(p.id))
    const input = chunk.map(([k, v]) => `${k}=${v}`).join('\n')
    // 缩进与 label 在这里统一拼，lib 内部只管消息内容。
    const emit = (msg) => log(`    ${label}${msg}`)
    return translateChunkTwoLayer({
      chunk,
      input,
      freeTier: isFreeTierUsable() ? freeTierProvider : null,
      poolProviders: providerList,
      // 提示词由 provider 自己给（免费层 instTrans、网关 SYSTEM_PROMPT）。
      call: (activeProvider, sig) => callProvider(activeProvider, activeProvider.buildPrompt(input), sig ?? signal),
      signal,
      isFirstChunk,
      log: emit,
      onFreeTierFailure,
      onFreeTierSuccess,
      isUsable: () => isFreeTierUsable(),
      markUnusable,
      isNoOutput,
    })
  }
}

/**
 * 编排一个分块：先免费层，不合格或失败才走回退池。
 *
 * 回退池内部行为与改造前**完全一致**：每个提供方最多试 3 次、回退率 ≤10% 即停、
 * 首块零译文则弃用该模型。免费层的结果作为回退池的起始最优值，
 * 因此回退池若反而更差不会把已拿到的较好结果覆盖掉。
 *
 * @param {object} p
 * @param {Array<[string,string]>} p.chunk 待译分块
 * @param {string} p.input 已拼好的 `键=值` 文本（免费层与回退池共用）
 * @param {object|null} p.freeTier 免费层 provider；null 表示本轮不可用
 * @param {Array<object>} p.poolProviders 回退池（**已过滤掉不可用者**）
 * @param {(provider: object, signal: AbortSignal) => Promise<string>} p.call 注入的网络调用
 * @param {AbortSignal} p.signal
 * @param {boolean} [p.isFirstChunk] 首块早停判据只对首块生效
 * @param {(msg: string) => void} [p.log]
 * @param {() => void} [p.onFreeTierFailure] 免费层失败回调（熔断计数在调用方）
 * @param {() => void} [p.onFreeTierSuccess] 免费层成功回调（重置熔断计数）
 * @param {(p: object) => boolean} [p.isUsable] 提供方是否仍可用（熔断状态在调用方）
 * @param {(id: string) => void} [p.markUnusable] 标记某提供方本轮不可用
 * @param {(p: object) => boolean} [p.isNoOutput] 首块零译文判据（注入以便单测）
 * @returns {Promise<{map: Map<string,string>, fallback: number, providerIds: string[]}>}
 */
export async function translateChunkTwoLayer({
  chunk,
  input,
  freeTier = null,
  poolProviders = [],
  call,
  signal,
  isFirstChunk = false,
  log = () => {},
  onFreeTierFailure = () => {},
  onFreeTierSuccess = () => {},
  isUsable = () => true,
  markUnusable = () => {},
  isNoOutput = () => false,
}) {
  const threshold = fallbackThreshold(chunk.length)

  // ---------- 第一层：免费层 ----------
  let best = null
  let bestFallback = chunk.length
  const usedProviderIds = new Set()

  if (freeTier && isUsable(freeTier)) {
    const free = await tryFreeTier({ chunk, provider: freeTier, call: (p, s) => call(p, s), signal, log })
    if (free) {
      onFreeTierSuccess()
      best = free.map
      bestFallback = free.fallback
      usedProviderIds.add(freeTier.id)
      if (free.fallback <= threshold) {
        return { map: free.map, fallback: free.fallback, providerIds: [freeTier.id] }
      }
      // 回话完整但回退率偏高：仍交给回退池再试一次（不熔断，它确实在产出译文）。
      log(`[免费层] 回退率 ${free.fallback}/${chunk.length} 偏高，转交回退池`)
    } else {
      onFreeTierFailure()
    }
  }

  // ---------- 第二层：回退池（行为与改造前完全一致） ----------
  const translatableLines = chunk.filter(([, v]) => /[A-Za-z]/.test(v)).length
  for (const activeProvider of poolProviders) {
    for (let attempt = 1; attempt <= 3 && bestFallback > threshold; attempt++) {
      let text
      try {
        text = await call(activeProvider, signal)
      } catch (err) {
        const why = err?.name === 'EmptyResponseError' ? '正文为空，不重试' : '重试耗尽'
        log(`[${activeProvider.id}] 分块翻译失败（${why}）: ${err?.message?.slice(0, 120) ?? err}`)
        if (isFirstChunk && err?.name === 'EmptyResponseError') {
          markUnusable(activeProvider.id)
          log(`[${activeProvider.id}] 首块正文为空（疑似推理模型把内容写在 reasoning_content），本轮弃用该模型`)
        }
        break
      }
      // 重复键也要挡：键名重命名撞车会让短键拿到 .comment 的长句（静默污染）。
      const { got, duplicated } = parseLangResponse(text)
      const evaluated = evaluateOutput(chunk, got, duplicated)
      if (evaluated.fallback < bestFallback) {
        best = evaluated.map
        bestFallback = evaluated.fallback
        usedProviderIds.add(activeProvider.id)
      }
      if (isFirstChunk && isNoOutput({
        chunkLength: chunk.length,
        parsedLines: got.size,
        fallback: evaluated.fallback,
        translatableLines,
      })) {
        markUnusable(activeProvider.id)
        log(`[${activeProvider.id}] 首块零译文（回退 ${evaluated.fallback}/${chunk.length}，解析出 ${got.size} 行），本轮弃用该模型，不重试`)
        break
      }
      if (bestFallback > threshold) {
        log(`第 ${attempt} 次分块回退率 ${evaluated.fallback}/${chunk.length}，重试`)
      }
    }
    if (bestFallback <= threshold) break
  }

  return {
    map: best ?? new Map(chunk.map(([k, v]) => [k, v])),
    fallback: bestFallback,
    providerIds: [...usedProviderIds],
  }
}
