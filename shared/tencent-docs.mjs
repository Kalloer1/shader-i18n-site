/**
 * 腾讯文档智能表格：共享常量与字段构造。
 *
 * 此前 worker/index.js 的 fieldValues 与 scripts/detect-changes.mjs 的 buildRecord()
 * 各写一份相同的字段结构，表格列一改就漂移（不足 M7）。此处收敛为唯一来源。
 *
 * 消费方：
 * - worker/index.js（Cloudflare Worker，经 wrangler/esbuild 打包）
 * - scripts/detect-changes.mjs（Node）
 */

export const TENCENT_MCP_URL = 'https://docs.qq.com/openapi/mcp'
export const TENCENT_FILE_ID = 'BpuvvJhOQHbW'
export const TENCENT_SHEET_ID = 't00i2h'

/** 智能表格访问链接（站点文案与文档引用共用） */
export const TENCENT_DOC_URL = 'https://docs.qq.com/smartsheet/DQnB1dnZKaE9RSGJX'

/** 状态枚举：与 KV 队列条目 status 保持一致 */
export const STATUS = {
  PENDING: '待翻译',
  TRANSLATING: '翻译中',
  DONE: '已完成',
  FAILED: '失败',
  DONE_UNMIRRORED: '已完成待镜像',
}

/** 来源枚举 */
export const SOURCE = {
  PLAYER: '玩家请求',
  AUTO: '自动检测',
}

/**
 * 构造一条智能表格记录的 field_values。
 * 字段名与顺序必须与智能表格实际列一致。
 *
 * @param {{ title: string, url: string, source: string, status?: string, note?: string, contact?: string, timestamp?: number }} input
 * @returns {Array<object>} field_values
 */
export function buildFieldValues(input) {
  const { title, url, source, status = STATUS.PENDING, note, contact, timestamp } = input

  const fields = [
    { field: '光影名称', text_value: { items: [{ text: title, type: 'text' }] } },
    { field: 'Modrinth 链接', url_value: { items: [{ text: title, type: 'url', link: url }] } },
    { field: '来源', option_value: { items: [{ text: source }] } },
    { field: '状态', option_value: { items: [{ text: status }] } },
    { field: '提交时间', string_value: String(timestamp ?? Date.now()) },
  ]

  if (contact) {
    fields.push({ field: '联系方式', text_value: { items: [{ text: contact, type: 'text' }] } })
  }
  if (note) {
    fields.push({ field: '备注', text_value: { items: [{ text: note, type: 'text' }] } })
  }

  return fields
}

/**
 * 从 Modrinth 页面链接中抽取 slug。
 * 支持 https://modrinth.com/shader/<slug>、/shaderpack/<slug>、/mod/<slug>、/project/<slug>
 * 以及带查询串/尾斜杠/子路径的形式。
 *
 * @param {string} url
 * @returns {string|null} slug，无法解析时返回 null
 */
export function parseModrinthSlug(url) {
  if (typeof url !== 'string') return null
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (parsed.hostname !== 'modrinth.com' && parsed.hostname !== 'www.modrinth.com') return null

  const m = parsed.pathname.match(/^\/(?:shader|shaderpack|mod|project|datapack|resourcepack)\/([^/]+)/i)
  if (!m) return null

  const slug = decodeURIComponent(m[1]).trim()
  if (!slug || !/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) return null
  return slug
}
