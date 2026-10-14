// 站点数据合并：全量目录（自动） + 人工映射（shaders.json）按 Modrinth projectId 关联。
// 目录条目覆盖绝大多数光影；shaders.json 提供汉化版本映射与精选元数据。
import catalog from '../../data/modrinth-catalog.json'
import hiresRaw from '../../data/gallery-hires.json'
import db from '../../data/shaders.json'

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
  if (shader?.gallery?.[0]) return 'modrinth-catalog.json'
  if (shader?.iconUrl) return 'Modrinth icon'
  return '暂无图片'
}

export function shaderVersionRange(shader) {
  const range = versionRange(shader?.gameVersions)
  if (!range) return ''
  return range.min === range.max ? range.min : `${range.min} ~ ${range.max}`
}

// 全量目录（含自带中文的光影，UI 打"自带中文"标签）
export const allShaders = catalog.shaders
  .map((e) => mergeManual(e, manualByProjectId.get(e.projectId) ?? manualBySlug.get(e.id)))

// 精选人工条目但不在目录/已被原生中文排除的（例如刚加入还没跑 catalog），保证不丢失
const knownIds = new Set(allShaders.map((s) => s.id))
for (const s of db.shaders) {
  if (knownIds.has(s.id)) continue
  allShaders.push(
    mergeManual(
      {
        id: s.id,
        projectId: s.modrinth?.projectId ?? '',
        title: s._meta?.modrinth?.title ?? s.id,
        author: s._meta?.modrinth?.author ?? '',
        downloads: s._meta?.modrinth?.downloads ?? 0,
        iconUrl: s._meta?.modrinth?.iconUrl ?? '',
        description: s._meta?.modrinth?.description ?? '',
        pageUrl: s._meta?.modrinth?.pageUrl ?? '',
        hasNativeZhCN: false,
        lastSync: '',
      },
      s,
    ),
  )
}

allShaders.sort((a, b) => b.downloads - a.downloads)

export const shaderById = Object.fromEntries(allShaders.map((s) => [s.id, s]))
