#!/usr/bin/env node
/**
 * 跨平台「同一个光影」识别（纯函数，无 IO/网络）。
 *
 * 背景：同一个光影常同时在 CurseForge 与 Modrinth 上架，两边 slug 往往不同
 * （例：CF `noble-shaders` 与 Modrinth `noble` 都是 Noble Shaders）。
 * pipeline 原本只按 id（= CF slug）比对「是否已翻过」，这类条目永远不命中，会白翻一遍。
 *
 * 判据（全部满足才算同一个光影）：
 *   1. 标题归一化后完全相等（CF 的 name 与 Modrinth 的 title）；
 *   2. Modrinth 侧同名条目唯一（0 个或多个同名一律放弃）；
 *   3. 旁证至少一条：slug 归一化后相等（强证据），
 *      或作者名归一化后互相包含（跨平台账号名常带后缀，如 Belmu / BelmuTM），
 *      或描述归一化后完全相同。
 *
 * 宁漏勿错：任何一条不满足都当作「不是同一个」，退回正常翻译流程（多翻一次不会出错，
 * 误判成「已翻过」才会让该翻的没翻）。
 */

// 归一化后短于该长度的标题不参与匹配：'Osh'/'DMS'/'Mist' 这类通用短词容易碰撞，
// 而这类条目要么两边 slug 相同（现有 id 判据已覆盖），要么 Modrinth 侧本来就没翻译。
export const MIN_MATCH_NAME_LEN = 4
// 作者名归一化后短于该长度时不参与「互相包含」判定（避免 'a' ⊂ 'ac' 这类噪声）。
export const MIN_AUTHOR_LEN = 3

/**
 * 文本归一化：小写 + 去掉所有非 ASCII 字母数字（空格、'-'、'_'、标点、emoji 都去掉）。
 * 非 ASCII 字符（如中文标题）会被去掉；归一化后过短即不参与匹配（保守）。
 */
export function normText(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * slug 归一化：trim + 小写 + 去掉 `-`/`_`/空白。
 * 必须与站点侧（site/.vitepress/theme/data.js、scripts/gen-shader-pages.mjs）的 normSlug 规则一致。
 */
export function normSlug(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[-_\s]+/g, '')
}

/**
 * 建立「归一化标题 → 条目数组」索引。
 * @param {Array<object>} entries
 * @param {(entry: object) => string|undefined} pickTitle
 * @returns {Map<string, Array<object>>}
 */
export function buildTitleIndex(entries, pickTitle) {
  const index = new Map()
  for (const entry of entries ?? []) {
    const key = normText(pickTitle(entry))
    if (key.length < MIN_MATCH_NAME_LEN) continue
    if (!index.has(key)) index.set(key, [])
    index.get(key).push(entry)
  }
  return index
}

/**
 * 旁证判定：CF 条目与 Modrinth 条目能否判定为同一个光影。
 * @param {{slug?: string, author?: string, description?: string}} cf
 * @param {{id?: string, author?: string, description?: string}} mr
 */
export function isSameShader(cf, mr) {
  if (!cf || !mr) return false
  const cfSlug = normSlug(cf.slug)
  if (cfSlug && cfSlug === normSlug(mr.id)) return true
  const a = normText(cf.author)
  const b = normText(mr.author)
  if (a.length >= MIN_AUTHOR_LEN && b.length >= MIN_AUTHOR_LEN && (a.includes(b) || b.includes(a))) return true
  const d = normText(cf.description)
  return d.length > 0 && d === normText(mr.description)
}

/**
 * 在 Modrinth 目录里找出与 CF 条目「同一个光影」的条目。
 * @param {{slug?: string, title?: string, author?: string, description?: string}} cf
 *   CF 侧信息；缺 author/description（如 CF 目录里没有这条）时只剩 slug 强证据，名称匹配不会生效。
 * @param {Map<string, Array<object>>} titleIndex buildTitleIndex(modrinthCatalog.shaders, e => e.title) 的结果
 * @returns {object|null} Modrinth 目录条目；无法判定时 null
 */
export function findModrinthTwin(cf, titleIndex) {
  const key = normText(cf?.title)
  if (key.length < MIN_MATCH_NAME_LEN) return null
  const candidates = titleIndex.get(key) ?? []
  if (candidates.length !== 1) return null
  return isSameShader(cf, candidates[0]) ? candidates[0] : null
}

/**
 * 同上，但只返回「Modrinth 侧已有汉化」的条目。
 * @param {Array<{id: string, modrinth?: {slug?: string, projectId?: string}, langVersions?: Array<{shaderVersion?: string}>}>} shaders
 *   shaders.json 的 shaders
 * @returns {{id: string, title: string, shaderVersion: string}|null}
 */
export function findTranslatedTwin(cf, titleIndex, shaders) {
  const twin = findModrinthTwin(cf, titleIndex)
  if (!twin) return null
  const shader = (shaders ?? []).find(
    (s) =>
      s.id === twin.id ||
      s.modrinth?.slug === twin.id ||
      (twin.projectId != null && s.modrinth?.projectId === twin.projectId),
  )
  const latest = (shader?.langVersions ?? [])[0]
  if (!shader || !latest?.shaderVersion) return null
  return { id: shader.id, title: twin.title, shaderVersion: latest.shaderVersion }
}
