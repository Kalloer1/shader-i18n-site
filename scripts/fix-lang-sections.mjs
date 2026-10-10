#!/usr/bin/env node
/**
 * 修复译文里「畸形 § 序列」—— 唯一会真的渲染错、需要自动纠正的格式问题。
 *
 * 畸形定义（与 validate-lang.mjs 完全一致）：§ 后不是合法格式码字符（0-9a-fk-orx），
 * 或 § 位于值末尾。典型来源：
 *   - 上游作者笔误（`§g`、`§ `、`§§`）
 *   - 机翻把格式码切断（`§e§ underwater` 这种 § 后跟空格）
 *   - 尾部残留的孤立 `§`
 *
 * 修复策略：
 *   - 行尾孤立 § 直接删除（不完整的格式码，渲染无意义）
 *   - 其余畸形 § 补成 §r（重置），保留作者原本的分段意图
 *
 * 只改「译文引入」的畸形（ZH 畸形数 > EN 畸形数）；上游 EN 自带的乱码不动，
 * 否则会把作者的原文缺陷当成我们的问题改掉。
 *
 * 用法：
 *   node scripts/fix-lang-sections.mjs --dry-run    只报告，不落盘
 *   node scripts/fix-lang-sections.mjs              实际修复
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { parse, countMalformedSections, repairMalformedSections } from './validate-lang.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LANG_DIR = join(ROOT, 'site/public/lang')
const SOURCES_DIR = join(ROOT, 'sources')

const dryRun = process.argv.includes('--dry-run')

function resolveEn(zhPath) {
  const sibling = join(dirname(zhPath), 'en_US.lang')
  if (existsSync(sibling)) return sibling
  const rel = relative(LANG_DIR, zhPath).replace(/\\/g, '/').split('/')
  if (rel.length >= 3) {
    const c = join(SOURCES_DIR, rel[0], rel[1], 'en_US.lang')
    if (existsSync(c)) return c
  }
  return null
}

/** 收集所有 zh_CN.lang（按 <id>/<version> 结构遍历）。 */
function collectZh(dir = LANG_DIR, acc = []) {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name)
    if (name.isDirectory()) collectZh(full, acc)
    else if (/zh_CN\.lang$/i.test(name.name)) acc.push(full)
  }
  return acc
}

const files = collectZh()
let changedFiles = 0
let changedKeys = 0
let skippedNoEn = 0

for (const zhPath of files) {
  const label = relative(ROOT, zhPath).replace(/\\/g, '/')
  const enPath = resolveEn(zhPath)
  if (!enPath) {
    skippedNoEn++
    continue
  }

  const enEntries = parse(readFileSync(enPath, 'utf8'))
  const zhText = readFileSync(zhPath, 'utf8')
  const lines = zhText.split('\n')
  const edits = []

  lines.forEach((line, idx) => {
    const t = line.trim()
    if (!t || t.startsWith('#')) return
    const eq = t.indexOf('=')
    if (eq <= 0) return
    const key = t.slice(0, eq)
    const value = t.slice(eq + 1)
    const zhMal = countMalformedSections(value)
    if (zhMal === 0) return
    const enMal = countMalformedSections(enEntries.get(key) ?? '')
    // 只修译文「多出来」的畸形；上游自带的乱码原样保留。
    if (zhMal <= enMal) return
    const { text: fixed } = repairMalformedSections(value)
    if (fixed === value) return
    edits.push({ idx, key, before: value, after: fixed })
  })

  if (!edits.length) continue
  changedFiles++
  changedKeys += edits.length
  console.log(`\n${dryRun ? '[dry-run] ' : ''}${label}`)
  for (const e of edits) {
    console.log(`  ${e.key}`)
    console.log(`    - ${JSON.stringify(e.before)}`)
    console.log(`    + ${JSON.stringify(e.after)}`)
  }

  if (dryRun) continue
  for (const e of edits) {
    const line = lines[e.idx]
    const indent = line.slice(0, line.length - line.trimStart().length)
    lines[e.idx] = `${indent}${e.key}=${e.after}`
  }
  // 保留原文件的行尾换行风格（没有就不加，有就维持）
  writeFileSync(zhPath, lines.join('\n'))
}

console.log(
  `\n${dryRun ? '[dry-run] ' : ''}修复 ${changedKeys} 个键 / ${changedFiles} 个文件` +
    (skippedNoEn ? `；${skippedNoEn} 个文件缺英文源，跳过` : ''),
)
