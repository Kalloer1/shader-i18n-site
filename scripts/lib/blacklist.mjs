/**
 * 「无英文源」黑名单的纯函数（无 IO/网络）。
 *
 * 背景：catalog 条目里只有 `noEnUsLang: true` 时，结论是**永久**的 —— 上游后来补了
 * `en_US.lang`、发了新版本，流水线也不会再看它一眼（439 个条目永远跳过）。
 *
 * 约定（用户明确要求）：黑名单**只存光影 id（条目本身）+ 版本号**，不加别的字段。
 * - `noEnUsLang: true`        曾经判定过（保留这个标记，兼容既有站点/脚本）
 * - `noEnUsLangVersion: "x"`  在哪个**光影版本**上判定的
 *
 * 判据：记录的版本 === 当前最新版本 → 结论仍然成立，跳过；
 *       版本不同（或旧数据没有版本号）→ 重新探测。
 *
 * 旧数据迁移：历史条目只有 `noEnUsLang: true`、没有版本号。我们**不猜**版本
 * （`lastSync` 是同步日期，不是光影版本，拿它比对必然误判），一律当作「判定版本未知」
 * → 下次遇到时重新探测一次，探测后写入当时的版本号。代价是每个旧条目多一次版本接口
 * 请求 + 一次 Range 探测（命中终态时不下载整包），一次性成本。
 */

export const NO_EN_US_FIELD = 'noEnUsLang'
export const NO_EN_US_VERSION_FIELD = 'noEnUsLangVersion'

/**
 * 打上黑名单标记，并记录判定时的光影版本。
 * 版本号为空时只打标记（与旧数据同形），下次遇到会重新探测。
 *
 * @param {object} entry catalog 条目（原地修改）
 * @param {string} [shaderVersion] 判定时的光影版本（Modrinth version_number / CF 派生版本）
 * @returns {object} 同一个 entry
 */
export function markNoEnUsLang(entry, shaderVersion) {
  if (!entry) return entry
  entry[NO_EN_US_FIELD] = true
  if (shaderVersion != null && shaderVersion !== '') {
    entry[NO_EN_US_VERSION_FIELD] = String(shaderVersion)
  }
  return entry
}

/**
 * 清除黑名单（重新探测后发现包里有 en_US.lang / 自带中文时调用）。
 * 留着过期标记会让站点与数据自相矛盾。
 *
 * @param {object} entry
 * @returns {object} 同一个 entry
 */
export function clearNoEnUsLang(entry) {
  if (!entry) return entry
  delete entry[NO_EN_US_FIELD]
  delete entry[NO_EN_US_VERSION_FIELD]
  return entry
}

/**
 * 黑名单结论对 `shaderVersion` 是否仍然成立（成立 = 可以跳过）。
 *
 * - 没标记 → false
 * - 有标记、无版本号（旧数据）→ **false**：判定版本未知，不能假定仍成立
 * - 版本号相同 → true
 * - 版本号不同 → false（上游发了新版本，可能补了 en_US.lang）
 *
 * @param {object|undefined|null} entry
 * @param {string|undefined|null} shaderVersion 当前最新光影版本
 * @returns {boolean}
 */
export function isBlacklistedForVersion(entry, shaderVersion) {
  if (entry?.[NO_EN_US_FIELD] !== true) return false
  const recorded = entry[NO_EN_US_VERSION_FIELD]
  if (recorded == null || recorded === '') return false
  if (shaderVersion == null || shaderVersion === '') return false
  return String(recorded) === String(shaderVersion)
}

/**
 * 每日同步目录时，把旧条目的黑名单字段原样带到新条目上（**两个字段都要保留**）。
 * 只带 `noEnUsLang` 不带版本号，等于把「版本判定」重新退化成永久跳过。
 *
 * @param {object|undefined|null} oldEntry 旧 catalog 里的同 id 条目
 * @returns {object} 可直接展开进新条目的字段（未标记时为空对象）
 */
export function carryOverBlacklist(oldEntry) {
  if (oldEntry?.[NO_EN_US_FIELD] !== true) return {}
  const fields = { [NO_EN_US_FIELD]: true }
  const version = oldEntry[NO_EN_US_VERSION_FIELD]
  if (version != null && version !== '') fields[NO_EN_US_VERSION_FIELD] = version
  return fields
}
