#!/usr/bin/env node
/**
 * 流水线的**探测阶段**：下载整包之前，用 HTTP Range 读中央目录，判断这个包是否已是终态。
 *
 * 为什么要它：2026-10-20 实测，按下载量取 10 个热门未翻译光影，8 个「自带中文」、
 * 2 个无 en_US.lang，真正需要翻译的 0 个 —— 但为了得出这个结论，整包下载了 10 次几十 MB。
 * 中央目录里已经有全部条目名，判定只需要条目名，不需要包体。
 *
 * 硬约束（改动这里之前请先读 tests/zip-probe.test.mjs）：
 * 1. **判据与整包路径同源**：只用 lib/lang-source.mjs 的 isLangFilePath / isZhCNLangPath /
 *    isEnUsLangPath，顺序也与 translateFromZip 一致（先 zh，再 en_US）。绝不在这里另写正则。
 * 2. **只判终态**：NATIVE_ZH / NO_EN_US 才是终态；NEEDS_TRANSLATION 表示要下载整包继续翻译；
 *    UNKNOWN（探测抛错、openZip 内部都回退失败等）必须由调用方**回退到原整包路径**，
 *    宁可多下载，不能少判断。
 * 3. **不碰网络细节**：Range 读取、重试、回退整包全部由 shared/zip-range.mjs 的 openZip 负责；
 *    这里只注入依赖，方便离线单测。
 */

import { isEnUsLangPath, isLangFilePath, isZhCNLangPath } from './lang-source.mjs'

/** 探测结论。UNKNOWN 只表示「不知道」，调用方必须走原路径。 */
export const PROBE_VERDICT = Object.freeze({
  /** 包内已有 zh_CN.lang → 自带中文，终态 */
  NATIVE_ZH: 'native-zh',
  /** 包内没有 en_US.lang（也没有 zh_CN.lang）→ 无英文源，终态 */
  NO_EN_US: 'no-en-us',
  /** 有 en_US.lang、无 zh_CN.lang → 需要翻译，下载整包 */
  NEEDS_TRANSLATION: 'needs-translation',
  /** 探测失败 → 不知道，回退原整包路径 */
  UNKNOWN: 'unknown',
})

/**
 * 按条目名分类（纯函数）。判定顺序与 scripts/pipeline.mjs 的 translateFromZip 一致：
 * 先看有没有 zh_CN（自带中文是终态，哪怕同时有 en_US），再看有没有 en_US。
 *
 * @param {string[]} names zip 中央目录里的全部条目名
 * @returns {{ verdict: string, langNames: string[], enName: string|null }}
 *   langNames 与 translateFromZip 的 `zip.names.filter(isLangFilePath)` 同序同内容，
 *   供跳过时打印日志（「无 en_US.lang（lang 文件: …）」）用。
 */
export function classifyLangNames(names) {
  const list = Array.isArray(names) ? names : []
  const langNames = list.filter(isLangFilePath)
  if (langNames.some(isZhCNLangPath)) {
    return { verdict: PROBE_VERDICT.NATIVE_ZH, langNames, enName: null }
  }
  const enName = langNames.find(isEnUsLangPath) ?? null
  if (!enName) return { verdict: PROBE_VERDICT.NO_EN_US, langNames, enName: null }
  return { verdict: PROBE_VERDICT.NEEDS_TRANSLATION, langNames, enName }
}

/**
 * 探测一个远程 zip 是否已是终态。
 *
 * openZip 以依赖注入方式传入（生产用 shared/zip-range.mjs 的实现），因此本模块
 * 不发网络请求、可离线单测。任何异常都收敛为 UNKNOWN：探测阶段永远不该让流水线失败。
 *
 * 返回的 zip 对象在 NEEDS_TRANSLATION 且 fetchMode === 'range' 时是**未下载整包**的
 * Range 对象；调用方可以直接用它读 en_US.lang，省掉第二次下载。fetchMode === 'full'
 * 表示 openZip 内部已经回退整包，调用方应把 zip 交回 translateFromZip，避免重复下载。
 *
 * @param {object} opts
 * @param {(url: string, opts: object) => Promise<{names: string[], fetchMode: string}>} opts.openZip
 * @param {string} opts.url
 * @param {number} [opts.totalSize] 文件总大小（Range 阈值判断用；缺省时 openZip 走整包）
 * @param {object} [opts.headers]
 * @param {AbortSignal} [opts.signal] 本条光影/候选文件的中断信号（CF 预算控制）
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ verdict: string, zip?: object, langNames?: string[], enName?: string|null, error?: Error }>}
 */
export async function probeZipTerminalState({ openZip, url, totalSize, headers, signal, log }) {
  const say = typeof log === 'function' ? log : () => {}
  let zip
  try {
    zip = await openZip(url, { totalSize, headers, signal })
  } catch (err) {
    say(`探测失败（${err?.message ?? err}），回退整包路径`)
    return { verdict: PROBE_VERDICT.UNKNOWN, error: err }
  }
  if (!zip || !Array.isArray(zip.names)) {
    say('探测返回的 zip 对象缺少条目名，回退整包路径')
    return { verdict: PROBE_VERDICT.UNKNOWN, error: new Error('探测结果缺少 names') }
  }
  const { verdict, langNames, enName } = classifyLangNames(zip.names)
  return { verdict, zip, langNames, enName }
}
