/**
 * 目录快照差异检测：找出"从 Modrinth 目录消失"的光影（被隐藏/下架/改名）。
 *
 * 纯函数：无网络、无 IO，可直接被测试 import。
 * 只做报告，绝不自动删除任何数据。
 */

/**
 * 对比新旧两版 Modrinth 目录，找出旧目录里有、新目录里没有的条目。
 * 匹配同时按 id 与 projectId 两个键（双向），避免把"改 slug"误判为消失。
 *
 * @param {Array<{id?: string, projectId?: string}>} oldEntries 旧目录条目（modrinth-catalog.json 的 shaders）
 * @param {Array<{id?: string, projectId?: string}>} newEntries 新拉取的目录条目
 * @param {Array<{id?: string, modrinth?: {projectId?: string}, langVersions?: Array<unknown>}>} manualEntries shaders.json 的 shaders
 * @returns {{ vanished: string[], vanishedWithTranslations: string[] }}
 *   - vanished：旧目录有、新目录没有的 id（按 id/projectId 双向匹配，避免误报）
 *   - vanishedWithTranslations：其中在 shaders.json 里登记了 langVersions 的（真正需要人工处理）
 */
export function diffVanished(oldEntries, newEntries, manualEntries) {
  const newIds = new Set(newEntries.map((e) => e.id))
  const newProjectIds = new Set(newEntries.map((e) => e.projectId))

  const vanished = []
  for (const old of oldEntries) {
    const stillThere =
      newIds.has(old.id) ||
      newIds.has(old.projectId) ||
      newProjectIds.has(old.id) ||
      newProjectIds.has(old.projectId)
    if (!stillThere) vanished.push(old.id)
  }

  const vanishedWithTranslations = vanished.filter((id) => {
    const manual = manualEntries.find(
      (m) => m.id === id || m.modrinth?.projectId === id,
    )
    return !!manual && (manual.langVersions ?? []).length > 0
  })

  return { vanished, vanishedWithTranslations }
}