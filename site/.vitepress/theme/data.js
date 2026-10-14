// 站点数据合并：全量目录（自动） + 人工映射（shaders.json）按 Modrinth projectId 关联。
// 目录条目覆盖绝大多数光影；shaders.json 提供汉化版本映射与精选元数据。
import catalog from '../../data/modrinth-catalog.json'
import hiresRaw from '../../data/gallery-hires.json'
import db from '../../data/shaders.json'
import cfCatalog from '../../data/curseforge-catalog.json'

// Top80 高清原图（raw_url），根治 _350 缩略图拉大必糊；缺失回退缩略图
const hiresMap = new Map(Object.entries(hiresRaw ?? {}))

const manualByProjectId = new Map(
  db.shaders.filter((s) => s.modrinth?.projectId).map((s) => [s.modrinth.projectId, s]),
)
const manualBySlug = new Map(db.shaders.map((s) => [s.id, s]))

function mergeManual(entry, manual) {
  return {
    // 目录字段（自动）
    id: entry.id,
    projectId: entry.projectId,
    title: manual?._meta?.modrinth?.title ?? entry.title,
    author: manual?._meta?.modrinth?.author ?? entry.author,
    downloads: manual?._meta?.modrinth?.downloads ?? entry.downloads,
    iconUrl: manual?._meta?.modrinth?.iconUrl ?? entry.iconUrl,
    description: manual?._meta?.modrinth?.description ?? entry.description,
    pageUrl: manual?._meta?.modrinth?.pageUrl ?? entry.pageUrl,
    gameVersions: entry.gameVersions ?? [],
    gallery: entry.gallery ?? [],
    // 高清原图：Top80 有 raw_url，其余回退缩略图；cover() 优先用它
    galleryHi: hiresMap.get(entry.id) ?? [],
    color: entry.color ?? '',
    categories: entry.categories ?? [],
    hasNativeZhCN: entry.hasNativeZhCN === true,
    missingSource: entry.noEnUsLang === true,
    checked: entry.hasNativeZhCN !== null && entry.hasNativeZhCN !== undefined,
    // 人工字段
    nameCN: manual?.nameCN ?? '',
    curseforge: manual?._meta?.curseforge ?? manual?.curseforge ?? null,
    langVersions: manual?.langVersions ?? [],
  }
}

// CurseForge 独占条目：Modrinth 目录里没有对应项目，因此没有 projectId（保持 undefined，
// 详情页不会输出 data-project-id，客户端也不会去请求 /project//version）。
// 上游链接一律指向 CF 项目页（entry.pageUrl）。
function mergeCfManual(entry, manual) {
  return {
    id: manual.id,
    projectId: undefined,
    source: 'curseforge',
    title: entry.name || manual.id,
    author: entry.author || '',
    downloads: entry.downloads ?? 0,
    iconUrl: entry.iconUrl ?? '',
    description: entry.description ?? '',
    pageUrl: entry.pageUrl ?? '',
    gameVersions: entry.gameVersions ?? [],
    gallery: entry.gallery ?? [],
    galleryHi: [],
    color: '',
    categories: entry.categories ?? [],
    hasNativeZhCN: manual.hasNativeZhCN === true,
    missingSource: false,
    checked: false,
    nameCN: manual.nameCN ?? '',
    curseforge: manual.curseforge ?? { slug: entry.slug, cfId: entry.cfId },
    langVersions: manual.langVersions ?? [],
  }
}

// 把 Modrinth 的游戏版本列表压缩成 "1.16.5 ~ 26.2" 这样的区间显示
export function versionRange(versions) {
  const parse = (v) => {
    const m = String(v).match(/^(\d+)\.(\d+)(?:\.(\d+))?$/)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null
  }
  let min = null, max = null, count = 0
  for (const v of versions ?? []) {
    const p = parse(v)
    if (!p) continue
    count++
    if (!min || p < min) min = p
    if (!max || p > max) max = p
  }
  if (!count) return null
  const fmt = (p) => `${p[0]}.${p[1]}${p[2] ? `.${p[2]}` : ''}`
  return { min: fmt(min), max: fmt(max), count }
}

// 首页与列表共用的展示状态，严格按业务优先级区分四种情况。
export function shaderStatus(shader) {
  if (!shader) {
    return {
      key: 'none',
      label: '暂无汉化',
      description: '暂未制作汉化文件。',
    }
  }
  if (shader.langVersions?.length) {
    return {
      key: 'translated',
      label: '已有汉化',
      description: '已有可下载的简体中文语言文件。',
    }
  }
  if (shader.hasNativeZhCN === true) {
    return {
      key: 'native',
      label: '自带中文',
      description: '该光影包已自带简体中文，无需额外安装汉化文件。',
    }
  }
  if (shader.missingSource === true) {
    return {
      key: 'missing',
      label: '无英文源',
      description: '上游没有 en_US.lang，无法翻译。',
    }
  }
  return {
    key: 'none',
    label: '暂无汉化',
    description: '暂未制作汉化文件。',
  }
}

export function shaderCover(shader) {
  return shader?.galleryHi?.[0] || shader?.gallery?.[0] || shader?.iconUrl || ''
}

export function shaderCoverSource(shader) {
  if (shader?.galleryHi?.[0]) return 'gallery-hires.json'
  const isCf = shader?.source === 'curseforge'
  if (shader?.gallery?.[0]) return isCf ? 'curseforge-catalog.json' : 'modrinth-catalog.json'
  if (shader?.iconUrl) return isCf ? 'CurseForge icon' : 'Modrinth icon'
  return '暂无图片'
}

export function shaderVersionRange(shader) {
  const range = versionRange(shader?.gameVersions)
  if (!range) return ''
  return range.min === range.max ? range.min : `${range.min} ~ ${range.max}`
}

// 全量目录（含自带中文的光影，UI 打"自带中文"标签）
const mergeSource = (e) => manualByProjectId.get(e.projectId) ?? manualBySlug.get(e.id)
// 与详情页生成一致：列表只取展示集合（已有本站汉化 或 自带中文）
const isDisplayable = (e) =>
  e.hasNativeZhCN === true || (mergeSource(e)?.langVersions?.length ?? 0) > 0

// 列表只来自 catalog（与 gen-shader-pages.mjs 的遍历源一致）：
// shaders.json 仅用于补充字段（nameCN/langVersions/quark/_meta 等），不允许它新增 id，
// 否则会出现「列表里有、详情页没有」的死链。
const modrinthShaders = catalog.shaders
  .filter(isDisplayable)
  .map((e) => mergeManual(e, mergeSource(e)))

const normSlug = (s) => String(s ?? '').trim().toLowerCase().replace(/[-_\s]+/g, '')

// CurseForge 独占条目：Modrinth 目录里没有同名项目（按归一化 slug 判定），
// 但 shaders.json 已有本站汉化（source=curseforge 且 langVersions 非空）或已检出自带中文
// （hasNativeZhCN===true，CF 分支的终态标记，同样没有 langVersions）。
// 这类条目会生成详情页，必须同时合入列表，否则是「详情页存在、列表查不到」的反向死链。
// 判据必须与 scripts/gen-shader-pages.mjs 保持一致。
const cfManualBySlug = new Map()
for (const s of db.shaders) {
  if (s.source !== 'curseforge' || !(s.langVersions?.length > 0 || s.hasNativeZhCN === true)) continue
  cfManualBySlug.set(normSlug(s.id), s)
  if (s.curseforge?.slug) cfManualBySlug.set(normSlug(s.curseforge.slug), s)
}
const modrinthIdSet = new Set(catalog.shaders.map((e) => normSlug(e.id)))
const cfOnlyShaders = (cfCatalog.mods ?? [])
  .map((entry) => ({ entry, manual: cfManualBySlug.get(normSlug(entry.slug)) }))
  .filter(({ entry, manual }) => manual && !modrinthIdSet.has(normSlug(entry.slug)))
  .map(({ entry, manual }) => mergeCfManual(entry, manual))

// 合并后统一按下载量排序（Array#sort 稳定：Modrinth 条目相对顺序与字段不变，CF 条目按下载量插入）
export const allShaders = [...modrinthShaders, ...cfOnlyShaders].sort(
  (a, b) => (b.downloads ?? 0) - (a.downloads ?? 0),
)

export const shaderById = Object.fromEntries(allShaders.map((s) => [s.id, s]))
