/**
 * 光影压缩包内语言源文件路径的判定（纯函数，供 pipeline 与离线测试使用）。
 *
 * 兼容 Modrinth（shaders/lang/en_US.lang）与 CurseForge（带外层目录
 * X/shaders/lang/en_US.lang）两种包结构：
 * - 路径必须以 shaders/lang/<文件名> 结尾，允许前面有任意层级外层目录；
 * - shaders 与 lang 必须相邻，lang 段大小写不敏感；
 * - 不匹配更深一层（shaders/lang/sub/en_US.lang）。
 *
 * 原 pipeline 中的正则均只用于 .test()，无捕获组；这里统一使用非捕获组，
 * 捕获组语义与原实现一致（均为无捕获组）。
 */

const LANG_FILE_RE = /(?:^|\/)shaders\/lang\/[^/]+$/i
const ZH_CN_RE = /(?:^|\/)shaders\/lang\/zh_CN\.lang$/i
const EN_US_RE = /(?:^|\/)shaders\/lang\/(?:en_US|en_us)\.lang$/i

/** 是否位于 shaders/lang 下一层的语言文件路径（任意大小写、可带外层目录）。 */
export function isLangFilePath(name) {
  return LANG_FILE_RE.test(name)
}

/** 是否简体中文语言文件路径（lang 段大小写不敏感，可带外层目录）。 */
export function isZhCNLangPath(name) {
  return ZH_CN_RE.test(name)
}

/** 是否英文源语言文件路径（仅 en_US.lang / en_us.lang，lang 段大小写不敏感，可带外层目录）。 */
export function isEnUsLangPath(name) {
  return EN_US_RE.test(name)
}