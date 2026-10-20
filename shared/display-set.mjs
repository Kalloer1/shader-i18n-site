/**
 * 站点「展示集合」判据的**唯一来源**（纯函数，无 IO）。
 *
 * 消费方：
 * - `site/.vitepress/theme/data.js`（列表 allShaders）
 * - `scripts/gen-shader-pages.mjs`（详情页遍历源）
 *
 * 两边**必须调用同一个函数**：只要判据分叉，就会出现「列表里有、详情页没有」
 * （或反向）的死链。历史教训见 data.js / gen-shader-pages.mjs 的注释。
 *
 * 展示三类光影：
 * 1. 已有本站汉化（shaders.json 里 langVersions 非空）；
 * 2. 自带中文（catalog 的 hasNativeZhCN === true）；
 * 3. **无英文源**（catalog 的 noEnUsLang === true）—— 这类条目同样要进列表与详情页，
 *    否则用户搜不到，也就看不到「为什么这个光影没有汉化」。
 *
 * 优先级（谁先命中谁算）由 shaderStatus() 决定，与本函数无关：
 * 已有汉化 > 自带中文 > 无英文源 > 暂无汉化。
 * 例如 noEnUsLang 与 langVersions 同时存在时显示「已有汉化」，这是正确的。
 */

/**
 * 按 id / projectId 找到对应的 shaders.json 人工条目。
 *
 * 顺序与 gen-shader-pages.mjs 历史实现一致（id 优先、projectId 兜底、最后拿 projectId 当 id 再试一次），
 * 这是两者的**并集**，能覆盖「Modrinth 改名后 catalog id 与 shaders.json id 不一致」的情况。
 * 任何一边少一步兜底，都会让一边多出条目 → 死链。
 *
 * @param {{id?: string, projectId?: string}|null|undefined} entry catalog 条目
 * @param {{byId?: Map<string, object>, byProjectId?: Map<string, object>}} maps
 * @returns {object|undefined}
 */
export function resolveManual(entry, { byId, byProjectId } = {}) {
  if (!entry) return undefined
  const projectId = entry.projectId
  return (
    byId?.get(entry.id) ??
    (projectId != null ? byProjectId?.get(projectId) : undefined) ??
    (projectId != null ? byId?.get(projectId) : undefined)
  )
}

/**
 * 这条 catalog 条目是否应该出现在站点上（列表 + 详情页）。
 *
 * @param {{hasNativeZhCN?: boolean, noEnUsLang?: boolean}|null|undefined} entry
 * @param {{langVersions?: Array<object>}|undefined} manual shaders.json 条目（可为空）
 * @returns {boolean}
 */
export function isDisplayableEntry(entry, manual) {
  if (!entry) return false
  if (entry.hasNativeZhCN === true) return true
  if (entry.noEnUsLang === true) return true
  return (manual?.langVersions?.length ?? 0) > 0
}
