#!/usr/bin/env node
/**
 * LLM「产不出译文」的早停判据与错误类型（纯函数，无 IO/网络）。
 *
 * 背景（已实测）：推理模型会把内容全写在 reasoning_content、正文为空（实测 hy3 的
 * content 长度=0、reasoning_content 长度=379）。pipeline 只读 content，于是每一块都
 * 100% 回退，每块还要重试 3 次、每次重试再退避 10 次 —— 6 分钟预算在首块之后就被烧光，
 * 却一行译文都没有。因此必须尽早把「这个模型根本不在产出译文」和「这个模型翻得差」区分开。
 *
 * 早停只认「首块一行译文都没有」，不做任何猜测式降级：
 * 绝不把 reasoning_content 当译文用（那是模型的思考过程，不是译文）。
 */

// 首块行数下限：不足该行数时样本太小（尾块可能只有 1 行，一个数值型取值原样返回
// 就会凑成「100% 回退」），不足以判定模型不可用。首块正常为 CHUNK_LINES=60 行。
export const EARLY_STOP_MIN_CHUNK_LINES = 10

/** 模型返回空正文（content 为空/纯空白）。与网络瞬时故障不同，重试同一模型只会拿到同样的空正文。 */
export class EmptyResponseError extends Error {
  constructor(message = '返回为空') {
    super(message)
    this.name = 'EmptyResponseError'
  }
}

/**
 * 模型是否在首块「完全没产出译文」。
 *
 * 判据取 100% 而不是 90%：90% 回退仍意味着模型产出了若干行译文，属于「翻得差」，
 * 现有逻辑（回退率 >10% 重试 3 次、仍不行就换下一个模型）已经覆盖；
 * 而 100% 回退 + 有可翻译行，只可能是模型没在产出译文，对它重试纯属烧预算。
 *
 * @param {object} p
 * @param {number} p.chunkLength 首块行数
 * @param {number} p.parsedLines 模型回话里能解析出的 `键=值` 行数
 * @param {number} p.fallback 回退（沿用英文原值）的行数
 * @param {number} p.translatableLines 首块里「值含 ASCII 字母」的行数（可能被翻译的行）
 * @returns {boolean}
 */
export function isProviderNoOutput({ chunkLength, parsedLines, fallback, translatableLines }) {
  if (chunkLength < EARLY_STOP_MIN_CHUNK_LINES) return false
  // 整块都是数值/符号（没有可翻译的英文），原样返回是正确行为，不能据此弃用模型。
  if (translatableLines === 0) return false
  return parsedLines === 0 || fallback === chunkLength
}

/**
 * 「所有模型都产不出译文」时的失败文案。会经 reportStatus 回写到队列 error，用户能在 /request 页看到。
 * @param {string[]} models 模型名列表
 */
export function providerUnusableMessage(models) {
  return `模型 ${(models ?? []).join('、')} 无法产出译文（正文为空，疑似推理模型把内容写在 reasoning_content），请更换模型后重试`
}
