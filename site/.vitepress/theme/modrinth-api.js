/**
 * 客户端 Modrinth API 加载器（带 localStorage 缓存）
 *
 * 用户点击「介绍」或「下载」标签时，从 Modrinth API 实时获取数据
 * 缓存到 localStorage，1 小时有效
 */

const MODRINTH_API = 'https://api.modrinth.com/v2'
const CACHE_TTL = 60 * 60 * 1000 // 1 小时（毫秒）

/**
 * 从缓存获取数据，过期返回 null
 */
function getCache(key) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const { data, timestamp } = JSON.parse(raw)
    if (Date.now() - timestamp > CACHE_TTL) {
      localStorage.removeItem(key)
      return null
    }
    return data
  } catch {
    return null
  }
}

/**
 * 写入缓存
 */
function setCache(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() }))
  } catch {
    // localStorage 满了或其他错误，忽略
  }
}

/**
 * 获取光影项目详情（包含介绍正文）
 * @param {string} projectId - Modrinth 项目 ID
 * @returns {Promise<object>} 项目详情
 */
export async function fetchProject(projectId) {
  const cacheKey = `modrinth_project_${projectId}`
  const cached = getCache(cacheKey)
  if (cached) return cached

  const res = await fetch(`${MODRINTH_API}/project/${projectId}`, {
    headers: { 'User-Agent': 'shader-i18n-site/0.1.0 (client)' }
  })
  if (!res.ok) throw new Error(`Modrinth API 错误: ${res.status}`)
  const data = await res.json()
  setCache(cacheKey, data)
  return data
}

/**
 * 获取光影版本列表（包含下载链接）
 * @param {string} projectId - Modrinth 项目 ID
 * @returns {Promise<Array>} 版本列表
 */
export async function fetchVersions(projectId) {
  const cacheKey = `modrinth_versions_${projectId}`
  const cached = getCache(cacheKey)
  if (cached) return cached

  const res = await fetch(`${MODRINTH_API}/project/${projectId}/version`, {
    headers: { 'User-Agent': 'shader-i18n-site/0.1.0 (client)' }
  })
  if (!res.ok) throw new Error(`Modrinth API 错误: ${res.status}`)
  const data = await res.json()
  setCache(cacheKey, data)
  return data
}

/**
 * 渲染介绍正文到指定容器
 * @param {string} projectId - Modrinth 项目 ID
 * @param {HTMLElement} container - 目标容器
 */
export async function renderDescription(projectId, container) {
  try {
    container.innerHTML = '<p class="loading">加载中...</p>'
    const project = await fetchProject(projectId)
    // 简单 Markdown 转 HTML（基本格式）
    let html = project.body || '<p>暂无介绍</p>'
    // 转换基本 Markdown
    html = html
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy" />')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>')
    container.innerHTML = `<div class="sp-body"><blockquote>本节内容来自 Modrinth 官方介绍页，版权归原作者所有。</blockquote><p>${html}</p></div>`
  } catch (err) {
    container.innerHTML = `<p class="error">加载失败：${err.message}</p>`
  }
}

/**
 * 渲染版本下载列表到指定容器
 * @param {string} projectId - Modrinth 项目 ID
 * @param {HTMLElement} container - 目标容器
 */
export async function renderVersions(projectId, container) {
  try {
    container.innerHTML = '<p class="loading">加载中...</p>'
    const versions = await fetchVersions(projectId)

    // 按发布时间倒序
    const sorted = versions.sort((a, b) =>
      new Date(b.date_published) - new Date(a.date_published)
    )

    let html = '<div class="sp-shader-downloads">'
    html += '<h2 class="sp-section-title">光影本体下载</h2>'
    html += '<p class="sp-shader-downloads__hint">直接下载光影本体（.zip），放入 <code>.minecraft/shaderpacks/</code> 目录</p>'

    // 最新版本
    const latest = sorted[0]
    if (latest) {
      const file = latest.files?.find(f => f.primary) ?? latest.files?.[0]
      if (file) {
        const size = file.size ? `(${(file.size / 1024 / 1024).toFixed(1)} MB)` : ''
        const date = new Date(latest.date_published).toLocaleDateString('zh-CN')
        html += `<div class="sp-latest-shader">`
        html += `<div class="sp-latest-shader__info">`
        html += `<span class="sp-latest-shader__ver">${latest.name || latest.version_number}</span>`
        html += `<span class="sp-latest-shader__mc">MC ${(latest.game_versions ?? []).join(', ')}</span>`
        html += `<span class="sp-latest-shader__date">${date}</span>`
        html += `<span class="sp-latest-shader__size">${size}</span>`
        html += `</div>`
        html += `<a class="sp-btn sp-btn--primary sp-btn--dl" href="${file.url}" target="_blank" rel="noopener">下载最新版 .zip</a>`
        html += `</div>`
      }
    }

    // 历史版本
    if (sorted.length > 1) {
      html += `<details class="sp-version-list">`
      html += `<summary>查看全部 ${sorted.length} 个历史版本</summary>`
      html += `<div class="sp-version-list__body">`
      for (const v of sorted.slice(1, 20)) {
        const file = v.files?.find(f => f.primary) ?? v.files?.[0]
        if (!file) continue
        const size = file.size ? `(${(file.size / 1024 / 1024).toFixed(1)} MB)` : ''
        const date = new Date(v.date_published).toLocaleDateString('zh-CN')
        html += `<div class="sp-version-item">`
        html += `<div class="sp-version-item__info">`
        html += `<span class="sp-version-item__name">${v.name || v.version_number}</span>`
        html += `<span class="sp-version-item__mc">MC ${(v.game_versions ?? []).join(', ')}</span>`
        html += `<span class="sp-version-item__date">${date}</span>`
        html += `<span class="sp-version-item__size">${size}</span>`
        html += `</div>`
        html += `<a class="sp-btn sp-btn--ghost sp-btn--sm" href="${file.url}" target="_blank" rel="noopener">下载 .zip</a>`
        html += `</div>`
      }
      html += `</div></details>`
    }

    html += '</div>'
    container.innerHTML = html
  } catch (err) {
    container.innerHTML = `<p class="error">加载失败：${err.message}</p>`
  }
}
