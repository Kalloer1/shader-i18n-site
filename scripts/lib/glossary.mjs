#!/usr/bin/env node
/**
 * 翻译记忆（glossary.json）的纯函数：骨架提取、「回退」判定与读写守卫。
 *
 * pipeline.mjs（线上读写记忆）与 scripts/rebuild-glossary.mjs（一次性重建）共用这一份实现：
 * 重建必须按「跑在线上的同一套骨架规则」复算，复制一份改过的副本必然漂移。
 * 无 IO、无网络，可直接单测。
 */

/**
 * 骨架提取：剥离合法 § 格式码（§ 后**一个**字符）、小写、压缩空白。
 *
 * 正则必须是 `§[0-9a-fk-or]`（**无** `+`）。带 `+` 时 `§` 会把后面所有落在字符集里的字符
 * 一路吞掉：`§cOFF` → `""`（O 在 k-o、F 在 a-f）、`§b2` → `""`（数字在集合里）。
 * 空骨架在读写两端都会被守卫挡下，于是这些条目永远记不进记忆。
 * `[+]`/`[-]` 这类方括号占位符不在字符集里，不受影响（§ 只吃紧随其后的那一个字符）。
 */
export function stripSkeleton(value) {
  return value
    .replace(/§[0-9a-fk-or]/gi, '')   // 剥离合法 § 码：§ 后只跟一个字符（§e、§r、§a[+]§c[-] 等）
    .toLowerCase()
    .replace(/\s+/g, ' ')             // 压缩空白
    .trim()
}

/**
 * 「回退」判据：模型把英文原文原样回显（值 === 原文）。
 *
 * 口径与 translateChunk 判回退的 `zh !== v` 完全一致：逐字比较，不做大小写/空白归一，
 * 因此大小写或空格的正常差异不会被误判成回退。
 */
export function isSourceEcho(translated, source) {
  return translated === source
}

/**
 * 读取端守卫：记忆条目能不能当命中用。
 * 值等于英文原文的历史污染（回退被写进记忆）视为未命中，否则英文原文会被永久当译文用。
 * @param {string|undefined} memory 记忆里该骨架当前的值
 * @param {string} source 该键的英文原文
 */
export function isUsableMemory(memory, source) {
  return Boolean(memory) && !isSourceEcho(memory, source)
}

/**
 * 写入端守卫：只有「骨架非空 + 记忆里还没有这个骨架 + 值不是英文原文回显」才记入记忆。
 * @param {string} skeleton stripSkeleton(英文原文) 的结果
 * @param {string} translated 译文
 * @param {string} source 该键的英文原文
 * @param {string|undefined} existing 记忆里该骨架当前的值（undefined 表示没有）
 */
export function shouldRememberMemory(skeleton, translated, source, existing) {
  return Boolean(skeleton) && !existing && !isSourceEcho(translated, source)
}
