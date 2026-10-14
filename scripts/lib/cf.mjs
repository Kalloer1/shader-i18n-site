#!/usr/bin/env node
/**
 * CurseForge 接入约定的纯函数（无 IO/网络）。
 *
 * 约定（见任务背景）：
 * - CF 版本号 = cf-<清洗后的文件名去扩展名>，清洗保证是安全目录名；
 * - CF 条目 id 用 CF slug 原样，并带 source: 'curseforge'；
 * - CF 候选池不与其他平台混排，按 downloads 降序取 Top N。
 */

export const CF_VERSION_MAX_LEN = 80

// 允许集：ASCII 安全字符 + 中文字符（按约定保留中文，仍保证是安全目录名）。
// 其余字符（空格、/、\、控制字符等）一律替换为 '-'
// 注意：'-' 必须放在字符类**末尾**。放在中间会被解析成区间运算符
// （如 '._-\u4e00' 会变成 0x5F-0x4E00 的区间），把中文误判为不允许字符。
const CF_DISALLOWED = /[^A-Za-z0-9._\u4e00-\u9fff-]/g

export function cfVersionFromFileName(fileName, fileId) {
  let base = String(fileName ?? '')
  // 只去掉结尾一层 .zip（大小写不敏感）
  if (/\.zip$/i.test(base)) base = base.slice(0, -4)

  let cleaned = base
    .replace(CF_DISALLOWED, '-') // 不允许的字符 -> '-'
    .replace(/-+/g, '-') // 连续 '-' 合并
    .replace(/\.{2,}/g, '.') // 连续 '.' 合并，避免出现 '..'
    .replace(/^[.\-\s]+|[.\-\s]+$/g, '') // 去掉首尾的 '.'/'-'/空格

  // 清洗后为空 -> 回退 cf-file-<fileId>
  if (!cleaned) return `cf-file-${fileId}`

  const prefix = 'cf-'
  // 整个版本号长度上限 80；超出截断，且截断后不得以 '.'/'-' 结尾
  if (cleaned.length > CF_VERSION_MAX_LEN - prefix.length) {
    cleaned = cleaned
      .slice(0, CF_VERSION_MAX_LEN - prefix.length)
      .replace(/\.{2,}/g, '.')
      .replace(/[.\-]+$/g, '')
  }
  return `${prefix}${cleaned}`
}

export function cfShaderId(entry) {
  const slug = entry?.slug
  if (!slug) throw new Error('CurseForge 条目缺少 slug，无法派生 shader id')
  return slug
}

/**
 * 作者是否禁止 API 分发。
 * allowModDistribution 是 CF 项目级永久属性：为 false 时下载接口一律返回 403，重试无意义。
 * 只有**明确为 false** 才算禁止；字段缺失（undefined）表示尚未采集，不能据此排除。
 */
export function isApiDownloadBlocked(entry) {
  return entry?.allowModDistribution === false
}

export function pickCfCandidates(cfCatalog, manualEntries, limit) {
  const manualSlugs = new Set()
  const manualCfIds = new Set()
  for (const m of manualEntries ?? []) {
    if (m?.id) manualSlugs.add(m.id)
    if (m?.curseforge?.slug) manualSlugs.add(m.curseforge.slug)
    if (m?.curseforge?.cfId != null) manualCfIds.add(String(m.curseforge.cfId))
  }
  return (cfCatalog ?? [])
    .filter((e) => {
      if (e.downloads == null || e.downloads === 0) return false
      if (isApiDownloadBlocked(e)) return false
      if (e.slug && manualSlugs.has(e.slug)) return false
      if (e.cfId != null && manualCfIds.has(String(e.cfId))) return false
      return true
    })
    .sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0))
    .slice(0, limit)
}

export function buildShaderEntry({ source, slug, cfId, modrinth }) {
  if (source === 'curseforge') {
    if (!slug) throw new Error('CurseForge 条目骨架需要 slug')
    return {
      id: slug,
      source: 'curseforge',
      curseforge: { slug, cfId },
      langVersions: [],
    }
  }
  if (!modrinth?.slug) throw new Error('Modrinth 条目骨架需要 modrinth.slug')
  return {
    id: modrinth.slug,
    modrinth: { slug: modrinth.slug, projectId: modrinth.projectId },
    langVersions: [],
  }
}

export function isCurseforgeEntry(entry) {
  return entry?.source === 'curseforge'
}