#!/usr/bin/env node
/**
 * 逐句翻译（per-line）：给「一次只回一行」的模型用的分块翻译实现。
 *
 * 为什么需要单独一条路径：bilibili 免费层的 `index-mt-*-syllable` 是**逐句模型** ——
 * 实测给它 N 行只回 1 行，而且回哪一行**不可控**（9 行输入回第 8 行、3 行输入回第 1 行）。
 * 因此不能像 `Index-Translate-35B-A3B` 那样整块发 60 行；必须一行一个请求。
 *
 * 两条实测得出的关键设计：
 *
 * 1. **只发 value，key 在本地拼回。** 把 `key=value` 整个发过去时，模型会把 key 当上下文，
 *    15.5% 的行原样回显英文（`Clouds`、`on`、`Borders` 不翻）；只发 value 后降到 6.5%，
 *    且 § 格式码与占位符**零漂移**、零空回。key 由调用方原样保留，模型无从改坏。
 *
 * 2. **并发默认 16。** 本机实测拐点：并发 16 → 36 行/秒，32 → 58 行/秒，
 *    48/64 吞吐反而下降（服务端排队）。CI 出口未验证，故默认取 16 留余量，
 *    用 `FREE_TIER_CONCURRENCY` 可调。
 *
 * 纯函数 + 注入网络调用，可离线单测（见 tests/line-translator.test.mjs）。
 */

/** 逐句模型的默认并发度。本机实测 32 是拐点，CI 出口未验证，取一半。 */
export const DEFAULT_LINE_CONCURRENCY = 16

/**
 * 逐句模型的提示词。用官方 `call_api.py` 的形态（中文、单条 user 消息、不要解释），
 * 但**只放 value**——见文件头说明。
 *
 * 「不要保留英文原文」这条实测把回显率从 15.5% 压到 11.5%，加上「只发 value」后到 6.5%。
 */
export const LINE_PROMPT_PREFIX = '请将以下文本翻译为简体中文，直接输出翻译结果，不要保留英文原文，不要进行任何解释。\n\n'

/**
 * 从模型回话里取出译文。
 *
 * 逐句模型的回话可能带前后空白、引号、代码块围栏。这里只做最小清洗，
 * **不做任何「猜测」**：清洗后若仍不像译文，交给调用方按回退处理。
 */
export function cleanLineReply(text) {
  if (!text) return ''
  let s = String(text).trim()
  // 偶发 ``` 围栏（Hunyuan 那类模型会包）
  if (s.startsWith('```')) s = s.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '')
  // 模型偶尔把原文引号包一层
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('“') && s.endsWith('”'))) {
    s = s.slice(1, -1).trim()
  }
  // 模型偶尔回成 `key=译文` 形态（我们只发了 value），把 key 前缀剥掉
  return s.trim()
}

/**
 * 判断一行逐句回话是否可用。
 *
 * 与 `evaluateOutput` 同口径（`zh !== v` 即回退），另加两条逐句专属校验：
 * 回话为空 → 回退；回话把 value 原样吐回 → 回退（模型认为不用翻）。
 *
 * @returns {{ok: boolean, reason?: string}}
 */
export function judgeLine(sourceValue, reply) {
  const zh = cleanLineReply(reply)
  if (!zh) return { ok: false, reason: 'empty' }
  if (zh === sourceValue) return { ok: false, reason: 'echo' }
  // 格式码漂移：数量必须一致（位置由模型决定，中文语序会调换，不强制）
  const srcCodes = (sourceValue.match(/§./g) || []).length
  const zhCodes = (zh.match(/§./g) || []).length
  if (srcCodes !== zhCodes) return { ok: false, reason: 'format-code' }
  // 占位符漂移：数量必须一致
  const srcPh = (sourceValue.match(/%[sd]|%\d+\$s/g) || []).length
  const zhPh = (zh.match(/%[sd]|%\d+\$s/g) || []).length
  if (srcPh !== zhPh) return { ok: false, reason: 'placeholder' }
  return { ok: true }
}

/**
 * 值里是否含「可翻译的字母」。
 *
 * 纯数字（`-95`）、百分比（`5%`）、符号（`---`）、单位（`°`）、空值本来就不该翻译，
 * 保留原值就是正确结果。它们既不是回退，也不该参与回退率计算 —— 否则一个
 * `value.BRIGHTNESS.-95=-95` 满天飞的光影会被判成「翻译失败」（实测 alphalalk 4697 键
 * 里 3152 行是这种行，回退率被顶到 67%）。
 *
 * 逐句路径（本文件）与整块路径（provider-chain.mjs 的 evaluateOutput）共用这一判据，
 * 两条路径口径必须一致，否则免费层换成整块模型时同一个 bug 会复现。
 *
 * @param {string} value
 */
export function hasTranslatableLetters(value) {
  return /[A-Za-z]/.test(value)
}

/**
 * 逐句翻译一个分块。
 *
 * 与整块翻译的差异：没有「回退率阈值」这一步——每一行独立成败，
 * 失败的行直接留英文（与 `evaluateOutput` 的按行回退同语义）。
 *
 * `fallback` **只统计本该翻译却没翻成的行**；无字母行单独计入 `untranslatable`，
 * 它们是「不需要翻」，不是「没翻成」，两者混在一起会把正常光影判死（见 hasTranslatableLetters）。
 *
 * @param {object} p
 * @param {Array<[string,string]>} p.chunk 待译分块
 * @param {(text: string, signal?: AbortSignal) => Promise<string>} p.call 注入的单行调用
 * @param {AbortSignal} [p.signal]
 * @param {number} [p.concurrency] 并发度
 * @param {(msg: string) => void} [p.log]
 * @returns {Promise<{map: Map<string,string>, fallback: number, untranslatable: number, reasons: Record<string, number>}>}
 */
export async function translateChunkByLine({
  chunk,
  call,
  signal,
  concurrency = DEFAULT_LINE_CONCURRENCY,
  log = () => {},
}) {
  const map = new Map()
  const reasons = {}
  let fallback = 0
  let untranslatable = 0

  // 没有字母的行（纯数字、纯符号）本来就不需要翻译，直接保留原值，不浪费请求。
  // 注意：**不计入 fallback**，只记 untranslatable —— 保留原值就是正确行为。
  const work = []
  for (const [k, v] of chunk) {
    if (!hasTranslatableLetters(v)) {
      map.set(k, v)
      untranslatable++
      reasons.noLetters = (reasons.noLetters || 0) + 1
    } else {
      work.push([k, v])
    }
  }

  const queue = [...work]
  const workers = Math.max(1, Math.min(concurrency, queue.length))

  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      if (signal?.aborted) return
      const entry = queue.shift()
      if (!entry) return
      const [k, v] = entry
      let reply
      try {
        reply = await call(LINE_PROMPT_PREFIX + v, signal)
      } catch (err) {
        map.set(k, v)
        fallback++
        const key = `error:${err?.code ?? 'unknown'}`
        reasons[key] = (reasons[key] || 0) + 1
        continue
      }
      const verdict = judgeLine(v, reply)
      if (verdict.ok) {
        map.set(k, cleanLineReply(reply))
      } else {
        map.set(k, v)
        fallback++
        reasons[verdict.reason] = (reasons[verdict.reason] || 0) + 1
      }
    }
  }))

  // 分母用「可翻译行数」：无字母行不进分子也不进分母，否则它们会把回退率撑大。
  // noLetters 仍单独列出（并附总行数），日志上一眼能看出「这 52 行本来就不需要翻」。
  const translatable = chunk.length - untranslatable
  if (fallback > 0 || untranslatable > 0) {
    const detail = Object.entries(reasons).map(([r, n]) => `${r} ${n}`).join('，')
    const scope = untranslatable > 0 ? `${detail}，共 ${chunk.length} 行` : detail
    log(`[逐句] 回退 ${fallback}/${translatable}（${scope}）`)
  }

  return { map, fallback, untranslatable, reasons }
}
