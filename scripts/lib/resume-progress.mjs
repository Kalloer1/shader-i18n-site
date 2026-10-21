#!/usr/bin/env node
/**
 * 断点续翻的**进度状态**（纯函数，无 IO、无网络）。
 *
 * 解决什么：整条光影的回退率 >30% 时判失败、`zh_CN.lang` 完全不落盘（pipeline.mjs
 * 的既有闸门，本轮不动）。已翻出的行虽然进了全局翻译记忆（glossary.json），但记忆是
 * `英文骨架 → 译文` 的**全局**映射，它回答不了「这条光影、这一版、翻到哪了」：
 * - 回退行不进记忆（正确），但它们和「从未尝试过」的行无法区分；
 * - 记忆按骨架匹配（§ 剥离、大小写归一、空白压缩），同一句话在不同光影里会互相命中，
 *   这是特性，不是进度。
 *
 * 进度文件是**中间态**，只回答一个问题：这一版英文源里，哪些键已经有了可用译文。
 * 硬约束（见 tests/resume-progress.test.mjs）：
 * - 删掉进度文件最多导致重跑，**绝不能**导致错误产物；
 * - 英文源变了（同版本重传）→ 那几行旧译文失效；
 * - 文件损坏 / 版本不符 → 当作没有进度，不抛错。
 *
 * 「已成功」的判据**直接复用** `judgeLine`：空回话、回显英文原文、§ 数量不一致、
 * 占位符数量不一致都不算成功。不复制一套正则，避免两套判据漂移。
 * 注意整包落盘前仍会跑 `validatePair`（键集合 / 畸形 § / 占位符种类），那才是最终闸门。
 */
import { judgeLine } from './line-translator.mjs'
import { isUsableMemory, stripSkeleton } from './glossary.mjs'

/**
 * 进度文件名。放在 `sources/<id>/<version>/` 下（该目录本就按版本隔离且被 gitignore）。
 *
 * 为什么是 `sources/` 而不是 `site/public/lang/`：
 * - `site/public/lang/` 是**站点静态产物目录**，VitePress 会把 public 原样发布，
 *   放中间态进去等于公开；
 * - `sources/` 已在 .gitignore 里（版权原因不入库），进度同样不该入库；
 * - 目录结构与 `<id>/<version>/en_US.lang` 一一对应，天然按版本隔离。
 *
 * 为什么以 `.` 开头：任何会遍历 sources/ 的工具（pack-lang-sources.mjs 只认
 * `en_US.lang`、validate-lang 只认 `zh_CN.lang`）都不会误收它；同时它一眼就是「内部文件」。
 */
export const PROGRESS_FILE_NAME = '.progress.json'

/** 进度文件相对仓库根的路径（`<root>/sources/<id>/<version>/.progress.json`）。 */
export function progressRelativePath(id, version) {
  return `sources/${id}/${version}/${PROGRESS_FILE_NAME}`
}

/** 文件格式版本。改结构时必须 +1，旧文件会被当作「没有进度」。 */
export const PROGRESS_SCHEMA = 1

/**
 * 一行译文是否算「已成功」（与 `judgeLine` 同口径）。
 *
 * @param {string} source 英文原文（取自本次的 en_US.lang）
 * @param {string} value 候选译文
 */
export function isTranslatedLine(source, value) {
  return judgeLine(source, value).ok
}

/** 新建空进度对象。 */
export function createProgress({ id, version }) {
  return { schema: PROGRESS_SCHEMA, id, version, lines: new Map() }
}

/**
 * 解析进度文件文本。**任何**结构问题都返回 null（调用方据此当作没有进度）。
 *
 * 单条坏记录只丢这一条：整份文件因一行坏数据而作废，会让已经翻好的其它行白丢。
 *
 * @param {string} text
 * @returns {{schema:number, id:string, version:string, lines:Map<string,{src:string,value:string}>}|null}
 */
export function parseProgress(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.schema !== PROGRESS_SCHEMA) return null
  if (typeof raw.id !== 'string' || !raw.id) return null
  if (typeof raw.version !== 'string' || !raw.version) return null
  if (!raw.lines || typeof raw.lines !== 'object' || Array.isArray(raw.lines)) return null

  const lines = new Map()
  for (const [key, rec] of Object.entries(raw.lines)) {
    if (typeof key !== 'string' || !key) continue
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue
    if (typeof rec.src !== 'string' || typeof rec.value !== 'string') continue
    lines.set(key, { src: rec.src, value: rec.value })
  }
  return { schema: raw.schema, id: raw.id, version: raw.version, lines }
}

/**
 * 序列化为文件文本。键按字典序输出：分块是并发的，完成顺序不稳定，
 * 排序后「同样的进度」总是得到同样的字节，写盘比对（内容没变就不写）才有效。
 */
export function serializeProgress(progress) {
  const lines = {}
  for (const key of [...progress.lines.keys()].sort()) {
    const rec = progress.lines.get(key)
    lines[key] = { src: rec.src, value: rec.value }
  }
  return `${JSON.stringify({
    schema: PROGRESS_SCHEMA,
    id: progress.id,
    version: progress.version,
    lines,
  }, null, 2)}\n`
}

/**
 * 从进度里挑出「下次运行确实还能用」的行。
 *
 * 三条失效条件（任一命中即丢弃该行）：
 * 1. id / 版本不符 —— 整份进度作废；
 * 2. 该键的英文原文变了 —— 旧译文是上一版英文的翻译，套到新原文上就是错译；
 * 3. 译文按当前判据不合格 —— 历史污染物不能当真。
 * 进度里有、但本次英文源没有的键直接忽略（上游已删掉该键）。
 *
 * @returns {Map<string, string>} key → 可复用译文
 */
export function selectResumableEntries(progress, { id, version, pairs }) {
  const usable = new Map()
  if (!progress) return usable
  if (progress.id !== id || progress.version !== version) return usable
  for (const [key, source] of pairs) {
    const rec = progress.lines.get(key)
    if (!rec) continue
    if (rec.src !== source) continue
    if (!isTranslatedLine(source, rec.value)) continue
    usable.set(key, rec.value)
  }
  return usable
}

/**
 * 把读到的进度收敛到「本次英文源确实还有效」的部分，返回一个**新的**进度对象。
 *
 * 为什么必须收口：
 * - 进度文件的 id/version 可能与路径不符（复制/改名留下的旧文件）。若直接沿用，
 *   后续保存会按旧 id/version 写回，等于把 A 的进度写进 B 的位置；
 * - 上游删掉的键、英文原文改过的键会永远留在文件里，越积越多。
 *
 * 与 `selectResumableEntries` 的区别：后者的失效判据只在**读取时**生效，
 * 文件本身仍是一坨旧数据；这里直接把旧数据丢掉。
 */
export function pruneProgress(progress, { id, version, pairs }) {
  const fresh = createProgress({ id, version })
  if (!progress || progress.id !== id || progress.version !== version) return fresh
  const current = new Map(pairs)
  for (const [key, rec] of progress.lines) {
    if (current.get(key) !== rec.src) continue
    if (!isTranslatedLine(rec.src, rec.value)) continue
    fresh.lines.set(key, { src: rec.src, value: rec.value })
  }
  return fresh
}

/**
 * 记一行「已成功」。只记合格的译文；同一个键**先到先得**（与 glossary 的
 * 「已有则不覆盖」守卫同思路：重跑时不会因为模型这次翻得不同而改变进度文件）。
 *
 * @returns {boolean} 是否新记入
 */
export function recordProgress(progress, key, source, value) {
  if (progress.lines.has(key)) return false
  if (!isTranslatedLine(source, value)) return false
  progress.lines.set(key, { src: source, value })
  return true
}

/**
 * 决策：哪些行可以复用、哪些必须发给 LLM。
 *
 * 优先级与改造前**完全一致**：全局/本条翻译记忆优先，其次才是进度文件。
 * 这样「没有进度文件」时的行为逐字不变；有进度文件时，进度只补记忆没命中的那些键。
 *
 * @param {Array<[string,string]>} pairs 本次英文源的 键=值
 * @param {object} p
 * @param {(skeleton: string) => string|undefined} p.lookup 记忆查询（骨架 → 译文）
 * @param {object|null} [p.progress] parseProgress 的结果
 * @param {string} [p.id] 光影 id（校验进度是否属于本条）
 * @param {string} [p.version] 光影版本
 * @returns {{reuse: Map<string,{value:string, origin:'memory'|'progress'}>, pending: Array<[string,string]>, memoryHits: number, progressHits: number}}
 */
export function planLines(pairs, { lookup, progress = null, id, version }) {
  const reusable = selectResumableEntries(progress, { id, version, pairs })
  const reuse = new Map()
  const pending = []
  let memoryHits = 0
  let progressHits = 0

  for (const [key, source] of pairs) {
    const skeleton = stripSkeleton(source)
    const memory = skeleton ? lookup(skeleton) : undefined
    if (isUsableMemory(memory, source)) {
      reuse.set(key, { value: memory, origin: 'memory' })
      memoryHits++
      continue
    }
    const resumed = reusable.get(key)
    if (resumed !== undefined) {
      reuse.set(key, { value: resumed, origin: 'progress' })
      progressHits++
      continue
    }
    pending.push([key, source])
  }
  return { reuse, pending, memoryHits, progressHits }
}

/**
 * 可观测摘要：这一版翻到哪了。
 * `done` 只算「本次英文源下确实可用」的行，与真正会被复用的集合一致。
 */
export function progressSummary(progress, pairs) {
  const usable = selectResumableEntries(progress, {
    id: progress?.id,
    version: progress?.version,
    pairs,
  })
  return { done: usable.size, total: pairs.length, remaining: pairs.length - usable.size }
}
