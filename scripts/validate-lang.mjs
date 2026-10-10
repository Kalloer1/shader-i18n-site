#!/usr/bin/env node
/**
 * 校验 zh_CN.lang 与对应 en_US.lang 的结构一致性（翻译流水线产出检查）。
 *
 * 闸门分线（致命 vs 样式）—— 判失败 / 只警告：
 *
 *   【失败】会真的渲染错或崩溃：
 *   - 键名一一对应（无缺失、无多余）
 *   - 译文引入的畸形 § 序列（§ 后不是合法格式码字符）
 *   - 非 %% 占位符（%s / %1$s / %value% 等）的种类与数量不一致
 *   - UTF-8 无 BOM
 *   - 翻译**新增**的重复键（ZH 出现次数多于 EN；继承自上游的只警告）
 *   - 找不到英文源（否则完整比对会静默空转 —— 历史假绿灯的根因）
 *
 *   【警告】只是样式选择，不阻断：
 *   - § 格式码数量差异（丢了颜色码 / 多加颜色码）
 *   - %% 占位符差异
 *   - 上游 EN 原文自带的 \u00a7 转义与畸形序列
 *   - 继承自英文源的重复键（last-wins，与上游一致）
 *   - 值与英文完全相同（可能未翻译）
 *
 * 上游兼容处理：
 *   - \u00a7 字面转义先解码为 §（部分光影把 § 写成转义序列，不解码会产生假失败）
 *   - 比对 § 数量前，先按同一规则修复两端的畸形序列，避免把上游乱码算到译文头上
 *
 * 批量模式的英文源解析顺序：
 *   1. 与 zh_CN.lang 同目录的 en_US.lang
 *   2. sources/<id>/<version>/en_US.lang（本地开发常态）
 *   3. data/lang-sources.json.gz（CI 常态：sources/ 被 gitignore）
 *   三处都找不到直接判失败（不再退化为自检 —— 那会产生假绿灯）
 *
 * 删除人工质量确认后，本脚本是唯一的质量防线，因此由 CI 全量调用。
 *
 * 用法：
 *   node scripts/validate-lang.mjs <en_US.lang> <zh_CN.lang>   校验单个文件对
 *   node scripts/validate-lang.mjs                             批量扫描 site/public/lang/**
 *
 * 退出码：0 全部通过；1 有校验失败；2 用法错误。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { readBundle } from './pack-lang-sources.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LANG_DIR = join(ROOT, 'site/public/lang')
const SOURCES_DIR = join(ROOT, 'sources')

// ---------- 解析 ----------

export function parse(text) {
  const entries = new Map()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    entries.set(trimmed.slice(0, eq), trimmed.slice(eq + 1))
  }
  return entries
}

/**
 * 统计每个键在原文中出现的次数（与 parse 的切分口径完全一致）。
 * 用于区分「继承自英文源的重复键」与「翻译新增的重复键」。
 */
export function countKeys(text) {
  const counts = new Map()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/**
 * 抽取一段文本中的占位符，返回「占位符 → 出现次数」的计数表。
 *
 * 覆盖：
 *   %s %d %f %x          —— C 风格格式说明符
 *   %1$s %2$d            —— 带位置参数的格式说明符
 *   %value% %1%          —— 百分号包裹式（部分光影自定义）
 *   %%                   —— 转义的字面百分号
 *
 * 关键：先匹配 %% 与带位置/长度的形式，再匹配简单形式，避免把 %1$s 误拆成 %1 与 $s。
 */
export function extractPlaceholders(value) {
  const counts = new Map()
  const bump = (token) => counts.set(token, (counts.get(token) ?? 0) + 1)

  // 一次扫描，按优先级排列的候选模式
  const re = /%%|%\d+\$[sdfx]|%[sdfx]|%[A-Za-z_][A-Za-z0-9_]*%|%\d+%/g
  let m
  while ((m = re.exec(value)) !== null) bump(m[0])
  return counts
}

function compareCounts(enCounts, zhCounts) {
  const all = new Set([...enCounts.keys(), ...zhCounts.keys()])
  const diffs = []
  for (const token of [...all].sort()) {
    const a = enCounts.get(token) ?? 0
    const b = zhCounts.get(token) ?? 0
    if (a !== b) diffs.push(`${token}（en ${a} / zh ${b}）`)
  }
  return diffs
}

/**
 * 解码上游 lang 里的 \u00a7 字面转义（部分光影把 § 写成转义序列）。
 * 不解码会让 EN/ZH 的 § 计数天然对不上（aberration-shader 等 22 个键的假失败来源）。
 */
export function decodeEscapes(text) {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

/** Minecraft § 格式码的合法后继字符。 */
const VALID_SECTION_CODE = /[0-9a-fk-orx]/i

/**
 * 统计畸形 § 序列：§ 后不是合法格式码字符（或位于行尾）。
 * 用于区分「上游 EN 自带」与「译文引入」—— 只有后者判失败。
 */
export function countMalformedSections(value) {
  let n = 0
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '§') continue
    const next = value[i + 1]
    if (next === undefined || !VALID_SECTION_CODE.test(next)) n++
  }
  return n
}

/**
 * 修复畸形 § 序列：
 *   - 行尾孤立的 § 直接删除（不完整的格式码，渲染无意义）
 *   - 其余畸形 § 补成 §r（重置），保留作者原本的分段意图
 * @returns {{text: string, fixed: number}}
 */
export function repairMalformedSections(value) {
  let out = ''
  let fixed = 0
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch !== '§') {
      out += ch
      continue
    }
    const next = value[i + 1]
    if (next !== undefined && VALID_SECTION_CODE.test(next)) {
      out += ch + next
      i++
      continue
    }
    fixed++
    if (next === undefined) continue // 行尾孤立 §：删除
    out += '§r'
  }
  return { text: out, fixed }
}

// ---------- 单文件对校验 ----------

/**
 * 校验一对 lang 文件。
 * @returns {{problems: string[], warnings: string[], keyCount: number}}
 */
export function validatePair(enTextRaw, zhTextRaw, label = '') {
  const problems = []
  const warnings = []
  const prefix = label ? `${label}: ` : ''

  // 上游可能把 § 写成 \u00a7 转义；先统一解码，再比对，避免假失败。
  const enText = decodeEscapes(enTextRaw)
  const zhText = decodeEscapes(zhTextRaw)

  if (zhText.charCodeAt(0) === 0xfeff) problems.push(`${prefix}zh_CN.lang 含 BOM，必须为 UTF-8 无 BOM`)

  // 重复键：上游光影包常遗留同名键，游戏按 last-wins 取值。
  // 只在翻译新增重复（ZH 出现次数多于 EN）时判失败，继承的降为警告。
  const enKeyCounts = countKeys(enText)
  const zhKeyCounts = countKeys(zhText)
  const introducedDupes = [...zhKeyCounts]
    .filter(([k, n]) => n > (enKeyCounts.get(k) ?? 0))
    .map(([k, n]) => `${k}×${n}`)
  if (introducedDupes.length) {
    problems.push(
      `${prefix}翻译新增重复键 ${introducedDupes.length} 个: ${introducedDupes.slice(0, 10).join(', ')}`,
    )
  }
  const inheritedDupes = [...zhKeyCounts]
    .filter(([k, n]) => n > 1 && n <= (enKeyCounts.get(k) ?? 0))
    .map(([k, n]) => `${k}×${n}`)
  if (inheritedDupes.length) {
    warnings.push(
      `${prefix}继承自英文源的重复键 ${inheritedDupes.length} 个（last-wins，与上游一致）: ${inheritedDupes.slice(0, 10).join(', ')}`,
    )
  }

  const enEntries = parse(enText)
  const zhEntries = parse(zhText)

  const missing = [...enEntries.keys()].filter((k) => !zhEntries.has(k))
  const extra = [...zhEntries.keys()].filter((k) => !enEntries.has(k))
  if (missing.length) problems.push(`${prefix}缺少 ${missing.length} 个键: ${missing.slice(0, 10).join(', ')}`)
  if (extra.length) problems.push(`${prefix}多出 ${extra.length} 个键: ${extra.slice(0, 10).join(', ')}`)

  // § 格式码：数量差异只是样式选择（丢/加颜色码）→ 警告。
  // 真正的致命缺陷是「译文引入的畸形 § 序列」：§ 后不是合法格式码字符，游戏会渲染错。
  // 两端都先按同一规则修复畸形序列再计数，避免把上游 EN 自带的乱码算到译文头上。
  const sectionMismatch = []
  const zhIntroducedMalformed = []
  for (const [k, enVal] of enEntries) {
    if (!zhEntries.has(k)) continue
    const zhVal = zhEntries.get(k) ?? ''
    const enCount = (repairMalformedSections(enVal).text.match(/§/g) ?? []).length
    const zhCount = (repairMalformedSections(zhVal).text.match(/§/g) ?? []).length
    if (enCount !== zhCount) sectionMismatch.push(`${k}（en ${enCount} / zh ${zhCount}）`)
    const enMal = countMalformedSections(enVal)
    const zhMal = countMalformedSections(zhVal)
    if (zhMal > enMal) zhIntroducedMalformed.push(`${k}（en ${enMal} / zh ${zhMal}）`)
  }
  if (zhIntroducedMalformed.length) {
    problems.push(
      `${prefix}译文引入畸形 § 序列 ${zhIntroducedMalformed.length} 个键: ${zhIntroducedMalformed.slice(0, 10).join('; ')}`,
    )
  }
  if (sectionMismatch.length) {
    warnings.push(
      `${prefix}§ 格式码数量不一致 ${sectionMismatch.length} 个键（样式差异，不阻断）: ${sectionMismatch.slice(0, 10).join('; ')}`,
    )
  }

  // 占位符：非 %% 的种类与数量必须一致（否则游戏内显示错误变量值或崩溃）→ 失败。
  // %% 只是转义字面百分号，差异降为警告。
  const placeholderMismatch = []
  const percentMismatch = []
  for (const [k, v] of enEntries) {
    if (!zhEntries.has(k)) continue
    const diffs = compareCounts(extractPlaceholders(v), extractPlaceholders(zhEntries.get(k) ?? ''))
    const fatal = diffs.filter((d) => !d.startsWith('%%'))
    const percent = diffs.filter((d) => d.startsWith('%%'))
    if (fatal.length) placeholderMismatch.push(`${k} [${fatal.join(', ')}]`)
    if (percent.length) percentMismatch.push(`${k} [${percent.join(', ')}]`)
  }
  if (placeholderMismatch.length) {
    problems.push(
      `${prefix}占位符不一致 ${placeholderMismatch.length} 个键: ${placeholderMismatch.slice(0, 10).join('; ')}`,
    )
  }
  if (percentMismatch.length) {
    warnings.push(
      `${prefix}%% 占位符差异 ${percentMismatch.length} 个键（样式差异，不阻断）: ${percentMismatch.slice(0, 10).join('; ')}`,
    )
  }

  // 未翻译检测：值完全相同的提示（数值类如 "0.10"、"1.00" 允许相同）
  const untranslated = [...enEntries].filter(([k, v]) => {
    if (/^[\d.\-+%Kk#/ ]+$/.test(v)) return false
    return zhEntries.get(k) === v
  })
  if (untranslated.length) {
    warnings.push(
      `${prefix}有 ${untranslated.length} 个值与英文相同（可能未翻译）: ${untranslated.slice(0, 10).map(([k]) => k).join(', ')}`,
    )
  }

  return { problems, warnings, keyCount: enEntries.size }
}

// ---------- 批量模式 ----------

/**
 * 扫描 site/public/lang/**\/*.lang，逐个校验。
 *
 * 每个汉化文件旁边若有同目录的 en_US.lang（或 en_US 缓存）则做完整比对；
 * 否则退化为「自检」：仅检查 BOM、键不重复、占位符自身成对合理。
 */
function collectLangFiles(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...collectLangFiles(full))
    else if (/\.lang$/i.test(name)) out.push(full)
  }
  return out
}

/**
 * 为 site/public/lang/<id>/<version>/zh_CN.lang 找到对应的英文源文本。
 *
 * 顺序：
 *   1. 与 zh_CN.lang 同目录的 en_US.lang
 *   2. sources/<id>/<version>/en_US.lang（本地开发常态）
 *   3. data/lang-sources.json.gz（CI 常态：sources/ 被 gitignore，只有这个包）
 *
 * 三处都找不到返回 null，调用方必须判失败 —— 绝不允许静默退回自检。
 * @returns {string|null}
 */
export function resolveEnText(zhPath) {
  const sibling = join(dirname(zhPath), 'en_US.lang')
  if (existsSync(sibling)) return readFileSync(sibling, 'utf8')

  // site/public/lang/<id>/<version>/zh_CN.lang → <id>/<version>
  const rel = relative(LANG_DIR, zhPath).replace(/\\/g, '/')
  const parts = rel.split('/')
  if (parts.length < 3) return null
  const key = `${parts[0]}/${parts[1]}`

  const local = join(SOURCES_DIR, parts[0], parts[1], 'en_US.lang')
  if (existsSync(local)) return readFileSync(local, 'utf8')

  const bundle = readBundle()
  if (bundle && typeof bundle[key] === 'string') return bundle[key]
  return null
}

/**
 * 兼容旧调用：返回英文源的路径（找不到时 null）。
 * 仅覆盖同目录与 sources/ 两处；bundle 回退请用 resolveEnText()。
 */
export function resolveEnSource(zhPath) {
  const sibling = join(dirname(zhPath), 'en_US.lang')
  if (existsSync(sibling)) return sibling

  const rel = relative(LANG_DIR, zhPath).replace(/\\/g, '/')
  const parts = rel.split('/')
  if (parts.length >= 3) {
    const candidate = join(SOURCES_DIR, parts[0], parts[1], 'en_US.lang')
    if (existsSync(candidate)) return candidate
  }
  return null
}

function runBatch() {
  const files = collectLangFiles(LANG_DIR).filter((f) => /zh_CN\.lang$/i.test(f))
  if (!files.length) {
    console.log('ℹ️  site/public/lang 下没有 zh_CN.lang，跳过校验')
    return 0
  }

  let failed = 0
  let totalKeys = 0
  let warningCount = 0
  for (const zhPath of files) {
    const label = relative(ROOT, zhPath).replace(/\\/g, '/')
    const zhText = readFileSync(zhPath, 'utf8')
    const enText = resolveEnText(zhPath)

    // 找不到英文源必须判失败：否则缺键 / § / 占位符比对会全部空转（历史假绿灯的根因）。
    if (enText === null) {
      failed++
      console.error(`✘ ${label}`)
      console.error(
        `    - ${label}: 找不到英文源（同目录 en_US.lang / sources/<id>/<version>/en_US.lang / data/lang-sources.json.gz），无法做完整校验`,
      )
      continue
    }

    const result = validatePair(enText, zhText, label)
    totalKeys += result.keyCount
    for (const w of result.warnings) {
      warningCount++
      console.warn(`⚠ ${w}`)
    }
    if (result.problems.length) {
      failed++
      console.error(`✘ ${label}`)
      for (const p of result.problems) console.error(`    - ${p}`)
    }
  }

  if (failed) {
    console.error(`\n✘ 批量校验失败：${failed}/${files.length} 个文件有问题`)
    return 1
  }
  console.log(
    `✔ 批量校验通过：${files.length} 个文件，共 ${totalKeys} 个键${warningCount ? `（${warningCount} 条样式警告）` : ''}`,
  )
  return 0
}

// ---------- 入口 ----------

// 仅在被直接执行时跑 CLI（被 tests/ import 时不执行）
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const [enPath, zhPath] = process.argv.slice(2)

  if (!enPath) {
    process.exit(runBatch())
  }

  if (!zhPath) {
    console.error('用法: node scripts/validate-lang.mjs <en_US.lang> <zh_CN.lang>')
    console.error('      node scripts/validate-lang.mjs            （批量扫描 site/public/lang）')
    process.exit(2)
  }

  const result = validatePair(readFileSync(enPath, 'utf8'), readFileSync(zhPath, 'utf8'))
  for (const w of result.warnings) console.warn(`⚠ ${w}`)
  if (result.problems.length) {
    console.error(`✘ 校验失败：\n${result.problems.map((p) => `  - ${p}`).join('\n')}`)
    process.exit(1)
  }
  console.log(`✔ 校验通过：${result.keyCount} 个键全部对应，§ 格式码与占位符一致，UTF-8 无 BOM`)
}
