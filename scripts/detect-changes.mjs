#!/usr/bin/env node
/**
 * 检测 catalog 变化，自动写入腾讯文档智能表格。
 *
 * 在 sync.yml 中运行在 fetch-catalog 之后：
 * - 对比新旧 modrinth-catalog.json
 * - 新增的光影 → 写入智能表格（来源：自动检测）
 * - lang 文件结构变化的光影 → 写入智能表格（来源：自动检测）
 *
 * 用法：TENCENT_DOCS_TOKEN=xxx node scripts/detect-changes.mjs
 * 环境变量：TENCENT_DOCS_TOKEN（腾讯文档 API token）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG_FILE = join(ROOT, 'site/data/modrinth-catalog.json')
const PREV_CATALOG_FILE = join(ROOT, 'site/data/modrinth-catalog.prev.json')
const SHADERS_FILE = join(ROOT, 'site/data/shaders.json')
const TENCENT_MCP_URL = 'https://docs.qq.com/openapi/mcp';
const FILE_ID = 'BpuvvJhOQHbW'
const SHEET_ID = 't00i2h'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function writeToSmartTable(token, records) {
  if (!token) {
    console.log('⚠️  TENCENT_DOCS_TOKEN 未设置，跳过写入智能表格')
    return false
  }

  const res = await fetch(TENCENT_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'smartsheet.add_records',
      params: {
        file_id: FILE_ID,
        sheet_id: SHEET_ID,
        records: records.map(r => ({ field_values: r })),
      },
      id: 1,
    }),
  })

  const result = await res.json()
  if (result.error) {
    console.error('❌ 智能表格写入失败:', result.error)
    return false
  }
  console.log(`✅ 已写入 ${records.length} 条记录到智能表格`)
  return true
}

function buildRecord(entry, changeType) {
  return [
    { field: '光影名称', text_value: { items: [{ text: entry.title, type: 'text' }] } },
    { field: 'Modrinth 链接', url_value: { items: [{ text: entry.title, type: 'url', link: `https://modrinth.com/shader/${entry.slug}` }] } },
    { field: '来源', option_value: { items: [{ text: '自动检测' }] } },
    { field: '状态', option_value: { items: [{ text: '待翻译' }] } },
    { field: '提交时间', string_value: String(Date.now()) },
    { field: '备注', text_value: { items: [{ text: changeType, type: 'text' }] } },
  ]
}

async function main() {
  const token = process.env.TENCENT_DOCS_TOKEN

  // 读取当前 catalog
  if (!existsSync(CATALOG_FILE)) {
    console.log('❌ modrinth-catalog.json 不存在')
    process.exit(1)
  }
  const catalog = JSON.parse(readFileSync(CATALOG_FILE, 'utf8'))

  // 读取上一次 catalog（如果有的话）
  let prevCatalog = { shaders: [] }
  if (existsSync(PREV_CATALOG_FILE)) {
    prevCatalog = JSON.parse(readFileSync(PREV_CATALOG_FILE, 'utf8'))
  }

  // 构建上一次的 id 集合
  const prevIds = new Set(prevCatalog.shaders.map(s => s.id))

  // 读取 shaders.json 获取已有翻译的 id
  let hasTranslation = new Set()
  if (existsSync(SHADERS_FILE)) {
    const db = JSON.parse(readFileSync(SHADERS_FILE, 'utf8'))
    hasTranslation = new Set(db.shaders.filter(s => s.langVersions?.length > 0).map(s => s.id))
  }

  // 检测新增光影
  const newShaders = catalog.shaders.filter(s => !prevIds.has(s.id))
  // 检测有翻译但可能需要更新的（此处简单标记，实际需要对比 en_US.lang 结构）
  // 暂不处理版本更新检测，留给手动判断

  const recordsToWrite = []

  for (const s of newShaders) {
    // 跳过已有翻译的
    if (hasTranslation.has(s.id)) continue
    recordsToWrite.push(buildRecord(s, '新增光影'))
  }

  if (recordsToWrite.length === 0) {
    console.log('ℹ️  无需写入智能表格（无新增未翻译光影）')
  } else {
    console.log(`📝 检测到 ${recordsToWrite.length} 个新增未翻译光影`)
    await writeToSmartTable(token, recordsToWrite)
  }

  // 保存当前 catalog 为下次对比用
  writeFileSync(PREV_CATALOG_FILE, JSON.stringify(catalog, null, 2) + '\n')
  console.log('💾 已保存 catalog 快照用于下次对比')
}

main().catch(err => {
  console.error('❌ 检测脚本出错:', err)
  process.exit(1)
})
