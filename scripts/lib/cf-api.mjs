#!/usr/bin/env node
/**
 * CurseForge API 网络原语（pipeline 的 CF 分支专用）。
 *
 * 只封装 CF 官方 v1 API 的四个只读调用，不含业务逻辑。
 * 统一错误处理：
 * - 缺 CURSEFORGE_API_KEY 时抛出清晰错误，绝不静默；
 * - 非 200 响应把状态码与响应体前 200 字符带进错误信息。
 *
 * 注意：部分网络（本机）会被 CloudFront WAF 拦截，只有 GitHub runner 能访问 CF；
 * 不要在本机直接调用本模块（会 403）。
 */

const CF_API_BASE = 'https://api.curseforge.com/v1'
const UA = 'shader-i18n-site/0.1.0'

function requireKey() {
  const key = process.env.CURSEFORGE_API_KEY
  if (!key) {
    throw new Error(
      '缺少 CURSEFORGE_API_KEY 环境变量：CurseForge API 需要 x-api-key 认证。' +
      '请在环境变量中提供（CI 通过 secrets.CURSEFORGE_API_KEY 注入）。',
    )
  }
  return key
}

// signal 由调用方显式传入（pipeline 传本条光影自己的 AbortController signal）：
// 不传时行为与改造前一致，传了就能被该条的超时真正中断（否则请求会挂到进程结束）。
async function cfGet(path, signal) {
  const key = requireKey()
  const res = await fetch(`${CF_API_BASE}${path}`, {
    signal,
    headers: {
      'x-api-key': key,
      'User-Agent': UA,
      Accept: 'application/json',
    },
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`CurseForge API HTTP ${res.status}（${path}）：${text.slice(0, 200)}`)
  }
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`CurseForge API 响应不是 JSON（${path}）：${text.slice(0, 200)}`)
  }
  return json
}

/** 取单个 CF 项目（mod）元数据。返回响应体的 data 字段（含 id / slug / name 等）。 */
export async function cfGetMod(cfIdOrSlug, signal) {
  const json = await cfGet(`/mods/${encodeURIComponent(cfIdOrSlug)}`, signal)
  return json.data
}

/**
 * 取项目的文件列表。返回文件数组（每个含 id / fileName / releaseType / fileDate 等）。
 * @param {number|string} cfId
 * @param {number} [pageSize=50] CF API 单页上限 50
 * @param {AbortSignal} [signal] 本条光影的中断信号（超时后立即中断该请求）
 */
export async function cfGetFiles(cfId, pageSize = 50, signal) {
  const qs = Number.isFinite(Number(pageSize)) && pageSize ? `?pageSize=${Number(pageSize)}` : ''
  const json = await cfGet(`/mods/${encodeURIComponent(cfId)}/files${qs}`, signal)
  return Array.isArray(json.data) ? json.data : []
}

/** 取某文件的一次性下载 URL。响应体的 data 字段就是下载 URL 字符串。 */
export async function cfGetDownloadUrl(cfId, fileId, signal) {
  const json = await cfGet(`/mods/${encodeURIComponent(cfId)}/files/${encodeURIComponent(fileId)}/download-url`, signal)
  return json.data
}

/**
 * 把 CF 的下载地址解析成**真正支持 Range 的最终 URL**。
 *
 * 实测（2026-10-21，Serv00 出口）：API 返回的地址主机是 `edge.forgecdn.net`，
 * 该主机在**请求头带 `Range` 时直接返回 404**（CloudFront "Error from cloudfront"，
 * content-length: 0），而不是先 302 让下游处理。后果是 `openZip` 的每次 Range
 * 都拿到 404 → 重试 → 回退整包，CF 侧的 Range 探测收益归零（359 个候选实测节省 0%）。
 *
 * 而同一文件解析后的 `mediafilez.forgecdn.net` 对 Range 正常返回 206。
 *
 * 这里用一次 **HEAD（跟随重定向）** 拿到最终 URL：HEAD 不下载正文，
 * 代价接近一次普通 API 调用。HEAD 失败时退回原始 URL —— 整包下载仍然可用，
 * 只是这一条拿不到 Range 收益，绝不让解析失败变成功能失败。
 *
 * @param {string} url cfGetDownloadUrl 的返回值
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>} 支持 Range 的最终 URL（解析失败时原样返回）
 */
export async function resolveCfDownloadUrl(url, signal) {
  if (!url) return url
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal })
    // 有些 CDN 对 HEAD 返回 405/403，此时不跟随重定向的 url 与响应里的 url 相同，没有收益。
    if (res.ok && res.url && res.url !== url) {
      if (res.body) await res.body.cancel().catch(() => {})
      return res.url
    }
    if (res.body) await res.body.cancel().catch(() => {})
  } catch (err) {
    if (signal?.aborted) throw err
    // 网络抖动/不支持 HEAD：保持原 URL，行为与改造前一致。
  }
  return url
}

/**
 * 按 slug 搜索 CF 光影项目（gameId=432=Minecraft，classId=6552=Shaders）。
 * 返回 { id, slug, name }，其中 id 是 CF 数字项目 id（即 cfId）。
 */
export async function cfFindBySlug(slug, signal) {
  const json = await cfGet(`/mods/search?gameId=432&classId=6552&slug=${encodeURIComponent(slug)}`, signal)
  const data = Array.isArray(json.data) ? json.data : []
  const hit =
    data.find((m) => String(m.slug).toLowerCase() === String(slug).toLowerCase()) ?? data[0]
  if (!hit) throw new Error(`CurseForge 找不到 slug: ${slug}`)
  return { id: hit.id, slug: hit.slug, name: hit.name }
}