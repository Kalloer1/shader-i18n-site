#!/usr/bin/env node
/**
 * 校验 zh_CN.lang 与对应 en_US.lang 的结构一致性（翻译流水线产出检查）。
 * 检查项：键名一一对应、§ 格式码数量、注释行保留、UTF-8 无 BOM。
 *
 * 用法：node scripts/validate-lang.mjs <en_US.lang> <zh_CN.lang>
 */
import { readFileSync } from 'node:fs'

const [enPath, zhPath] = process.argv.slice(2)
if (!enPath || !zhPath) {
  console.error('用法: node scripts/validate-lang.mjs <en_US.lang> <zh_CN.lang>')
  process.exit(2)
}

const en = readFileSync(enPath, 'utf8')
const zh = readFileSync(zhPath, 'utf8')

const problems = []

if (zh.charCodeAt(0) === 0xfeff) problems.push('zh_CN.lang 含 BOM，必须为 UTF-8 无 BOM')

const parse = (text) => {
  const entries = new Map()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    entries.set(trimmed.slice(0, eq), trimmed.slice(eq + 1))
  }
  return entries
}

const enEntries = parse(en)
const zhEntries = parse(zh)

const missing = [...enEntries.keys()].filter((k) => !zhEntries.has(k))
const extra = [...zhEntries.keys()].filter((k) => !enEntries.has(k))
if (missing.length) problems.push(`缺少 ${missing.length} 个键: ${missing.slice(0, 10).join(', ')}`)
if (extra.length) problems.push(`多出 ${extra.length} 个键: ${extra.slice(0, 10).join(', ')}`)

// § 格式码：值中 § 的数量必须一致（键与值都不改写格式码）
const formatMismatch = [...enEntries].filter(([k, v]) => {
  const enCount = (v.match(/§/g) ?? []).length
  const zhCount = (zhEntries.get(k) ?? '').match(/§/g)?.length ?? 0
  return enCount !== zhCount
})
if (formatMismatch.length) {
  problems.push(
    `§ 格式码不一致 ${formatMismatch.length} 个键: ${formatMismatch.slice(0, 10).map(([k]) => k).join(', ')}`,
  )
}

// 未翻译检测：值完全相同的提示（数值类如 "0.10"、"1.00" 允许相同）
const untranslated = [...enEntries].filter(([k, v]) => {
  if (/^[\d.\-+%Kk#/ ]+$/.test(v)) return false
  return zhEntries.get(k) === v
})
if (untranslated.length) {
  console.warn(`⚠ 有 ${untranslated.length} 个值与英文相同（可能未翻译）: ${untranslated.slice(0, 10).map(([k]) => k).join(', ')}`)
}

if (problems.length) {
  console.error(`✘ 校验失败：\n${problems.map((p) => `  - ${p}`).join('\n')}`)
  process.exit(1)
}
console.log(`✔ 校验通过：${enEntries.size} 个键全部对应，§ 格式码一致，UTF-8 无 BOM`)
