#!/usr/bin/env node
/**
 * 把 `键=值` 列表 + 译文表渲染成 zh_CN.lang 全文（纯函数，无 IO）。
 *
 * 为什么抽到 lib：断点续翻必须证明「复用进度里的译文」与「重新调 LLM 得到同样的译文」
 * 渲染出的文件**逐字节一致**。渲染只要留在 pipeline.mjs 里就无法在单测中复现，
 * 这个证明就只能靠口头断言。抽出来之后 tests/resume-progress.test.mjs 可以直接拿
 * 仓库里 602 个真实 lang 文件做往返比对。
 *
 * 渲染规则必须与改造前逐字一致：
 * - 非 `键=值` 行（注释、空行、小节标题）**原样保留**；
 * - 取不到译文的键回退成英文原值；
 * - 译文落盘前修掉初翻常见的畸形 § 序列（修复函数由调用方注入，避免 lib 反向依赖 scripts/）。
 */

/**
 * @param {object} p
 * @param {string[]} p.lines 英文源按行切开的结果（含注释与空行）
 * @param {Map<string,string>} p.zhMap 键 → 译文
 * @param {(text: string) => {text: string, fixed: number}} p.repair 畸形 § 修复
 * @returns {string[]} 渲染后的行（未加文件头）
 */
export function renderBody(lines, zhMap, repair) {
  return lines.map((line) => {
    const t = line.trim()
    if (!t || t.startsWith('#')) return line
    const eq = t.indexOf('=')
    if (eq <= 0) return line
    const key = t.slice(0, eq)
    const value = zhMap.get(key) ?? t.slice(eq + 1)
    return `${key}=${repair(value).text}`
  })
}

/** 文件头。三段：固定首行、来源与版本、英文源文件名。 */
export function buildHeader({ title, id, shaderVersion, sourceFileName, enName }) {
  return `#shaders/lang/zh_CN.lang\n# ${title ?? id} v${shaderVersion} 简体中文翻译（AI 初翻，未人工校对）\n# 源文件：${sourceFileName} 的 ${enName}\n`
}

/** 渲染全文（文件头 + 正文），与 pipeline 落盘的字节完全一致。 */
export function renderZhLang({ title, id, shaderVersion, sourceFileName, enName, lines, zhMap, repair }) {
  const header = buildHeader({ title, id, shaderVersion, sourceFileName, enName })
  return header + renderBody(lines, zhMap, repair).join('\n')
}
