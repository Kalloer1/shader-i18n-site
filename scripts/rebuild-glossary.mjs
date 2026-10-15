#!/usr/bin/env node
/**
 * 一次性重建翻译记忆（site/data/glossary.json）。
 *
 * 背景（实测）：`stripSkeleton` 的正则多了一个 `+`（`§[0-9a-fk-or]+`），会把骨架后面所有落在
 * 字符集里的字符一路吞掉（`§cOFF` → `""`），185,837 个英文值里有 4,731 个骨架为空、17,593 个
 * 骨架与正确写法不同；同时写入端把「模型回显原文」当成译文永久缓存，记忆里混入英文原文。
 * 修好两端之后，本脚本按**跑在线上的同一套骨架规则**（import scripts/lib/glossary.mjs，
 * 不复制实现）从站上真实的 zh_CN.lang 重算一遍记忆。
 *
 * 输入：
 *   data/lang-sources.json.gz            entries["<id>/<ver>"] = en_US.lang 全文（630 条）
 *   site/public/lang/<id>/<ver>/zh_CN.lang  站上已有的中文（601 条；缺 29 条，见报告）
 * 规则：
 *   - 骨架 = stripSkeleton(英文值)；中文值取站上同一 key 的值；
 *   - 排除「中文值 === 英文原文」（回退污染）与「中文值完全不含中文」（英文原文/纯符号）；
 *   - 保留旧记忆里骨架没变（不在 staleOldSkeletons 中）且值含中文的条目 —— 那 29 条没有中文源的
 *     光影只能这样保留，否则会把它们整批弄丢。
 * 用法：
 *   node scripts/rebuild-glossary.mjs            重写 site/data/glossary.json 并打印报告
 *   node scripts/rebuild-glossary.mjs --dry-run  只打印报告，不写盘
 *   node scripts/rebuild-glossary.mjs --sample 20 报告里附「重建前/后命中率」抽样表（默认 20 条光影）
 *   node scripts/rebuild-glossary.mjs --baseline <旧记忆.json>
 *       「重建前」基线。默认就是 site/data/glossary.json，但重建已经写过一次之后，
 *       它就不再是「前」了（before/after 会退化成自己跟自己比），要复现本次报告请显式传：
 *       git show HEAD:site/data/glossary.json > /tmp/old-glossary.json
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { stripSkeleton } from './lib/glossary.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GLOSSARY_FILE = join(ROOT, 'site/data/glossary.json')
const LANG_SOURCES = join(ROOT, 'data/lang-sources.json.gz')
const LANG_DIR = join(ROOT, 'site/public/lang')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const sampleArg = args.indexOf('--sample')
const SAMPLE = sampleArg >= 0 ? Number(args[sampleArg + 1]) : 20
const baselineArg = args.indexOf('--baseline')
const BASELINE_FILE = baselineArg >= 0 ? args[baselineArg + 1] : GLOSSARY_FILE

// 旧（有 bug）的骨架写法，只用于报告「骨架变化 / 旧口径撞车」的对比数字。
const OLD_SKELETON_RE = /§[0-9a-fk-or]+/gi
const stripSkeletonOld = (value) => value.replace(OLD_SKELETON_RE, '').toLowerCase().replace(/\s+/g, ' ').trim()

// 「含中文」：CJK 统一表意文字（实测与调研口径一致：旧记忆里 1,625 条不含中文）
const HAS_CHINESE = /[\u4e00-\u9fff]/

function parsePairs(text) {
  const pairs = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    pairs.push([t.slice(0, eq), t.slice(eq + 1)])
  }
  return pairs
}

const before = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
const sources = JSON.parse(gunzipSync(readFileSync(LANG_SOURCES)))
const entryKeys = Object.keys(sources.entries).sort()

// ---------- 1. 从 601 条有中文的光影重算 ----------
const after = {}
const stats = { zhMissing: [], noZhValue: 0, echo: 0, noChinese: 0, written: 0, kept: 0, droppedStale: 0, droppedNoChinese: 0, droppedCarryEcho: 0 }
const oldSkeletonOfEn = new Set()   // 旧记忆里可能存在的骨架（全部英文值）
const staleOldSkeletons = new Set() // 旧骨架 != 新骨架：这些旧键必须丢掉（内容已迁到新键）
const enBySkeleton = new Map()      // 新骨架 -> Set(英文原文)：用来查旧条目是不是「英文原文当译文」
let enValues = 0, oldEmpty = 0, newEmpty = 0, skeletonChanged = 0

const parsedSources = []
for (const key of entryKeys) {
  const [id, ver] = key.split('/')
  const enPairs = parsePairs(sources.entries[key])
  let zhPairs = null
  try {
    zhPairs = parsePairs(readFileSync(join(LANG_DIR, id, ver, 'zh_CN.lang'), 'utf8'))
  } catch {
    stats.zhMissing.push(key)
  }
  parsedSources.push({ key, enPairs, zhPairs })
  for (const [, en] of enPairs) {
    enValues++
    const oldSkel = stripSkeletonOld(en)
    const newSkel = stripSkeleton(en)
    if (!oldSkel) oldEmpty++
    if (!newSkel) newEmpty++
    if (oldSkel !== newSkel) skeletonChanged++
    if (oldSkel) oldSkeletonOfEn.add(oldSkel)
    if (oldSkel && oldSkel !== newSkel) staleOldSkeletons.add(oldSkel)
    if (newSkel) {
      if (!enBySkeleton.has(newSkel)) enBySkeleton.set(newSkel, new Set())
      enBySkeleton.get(newSkel).add(en)
    }
  }
}

for (const { enPairs, zhPairs } of parsedSources) {
  if (!zhPairs) continue
  const zhMap = new Map(zhPairs)
  for (const [k, en] of enPairs) {
    const skeleton = stripSkeleton(en)
    if (!skeleton) continue
    const zh = zhMap.get(k)
    if (zh === undefined || zh === '') { stats.noZhValue++; continue }
    if (zh === en) { stats.echo++; continue }        // 回退污染：英文原文被当成译文
    if (!HAS_CHINESE.test(zh)) { stats.noChinese++; continue }
    if (skeleton in after) continue // 同一骨架取先出现的（与 pipeline 合并记忆的「已有则不覆盖」一致）
    after[skeleton] = zh
    stats.written++
  }
}

// ---------- 2. 保留旧记忆里骨架没变且值含中文的条目 ----------
for (const [k, v] of Object.entries(before)) {
  if (k in after) continue
  if (typeof v !== 'string' || !v) { stats.droppedNoChinese++; continue }
  if (!HAS_CHINESE.test(v)) { stats.droppedNoChinese++; continue } // 英文原文/纯符号：排除
  if (staleOldSkeletons.has(k)) { stats.droppedStale++; continue }  // 旧骨架是 bug 造成的：内容已迁到新骨架
  // 那 29 条缺中文源的光影只是没有 zh_CN.lang，英文原文仍在 lang-sources 里，
  // 所以「值 === 英文原文」的回退污染同样查得出来（否则会漏 29 条）。
  if (enBySkeleton.get(k)?.has(v)) { stats.droppedCarryEcho++; continue }
  after[k] = v
  stats.kept++
}

// ---------- 3. 报告 ----------
const count = (obj) => Object.keys(obj).length
const noChinese = (obj) => Object.values(obj).filter((v) => !HAS_CHINESE.test(v)).length
const valueEqualsKey = (obj) => Object.entries(obj).filter(([k, v]) => k === v).length

console.log('=== 重建翻译记忆 ===')
console.log(`重建前基线：${BASELINE_FILE}`)
console.log(`英文源 ${entryKeys.length} 条，其中站上有 zh_CN.lang 的 ${entryKeys.length - stats.zhMissing.length} 条`)
console.log(`缺中文源（无法重算，只能靠旧记忆保留）：${stats.zhMissing.length} 条`)
console.log(`  ${stats.zhMissing.join(', ')}`)
console.log(`英文值 ${enValues} 个：旧骨架为空 ${oldEmpty}，新骨架为空 ${newEmpty}，骨架变化 ${skeletonChanged}`)
console.log(`记忆条数：${count(before)} -> ${count(after)}（重算写入 ${stats.written}，旧条目保留 ${stats.kept}）`)
console.log(`排除：站上无该 key 的取值 ${stats.noZhValue}，中文值===英文原文（回退污染）${stats.echo}，中文值不含中文 ${stats.noChinese}`)
console.log(`旧记忆淘汰：值不含中文 ${stats.droppedNoChinese}，旧骨架已被 bug 污染（内容已迁到新骨架）${stats.droppedStale}，值===英文原文 ${stats.droppedCarryEcho}`)
console.log(`值不含中文的条目：${noChinese(before)} -> ${noChinese(after)}`)
console.log(`值===键的条目：${valueEqualsKey(before)} -> ${valueEqualsKey(after)}`)

// 撞车骨架：同一骨架被 ≥2 个不同英文串共用。
// 注意：这个口径本身包含无害变体（大小写 / § 颜色码 / 首尾空白差异），所以**不是**修复效果的指标；
// 真正被 bug 合并出来的是下面的 split（旧口径合并、新口径分开）——它们必然是「两段语义不同的英文共用一骨架」。
function sharedSkeletons(skeletonOf, glossary) {
  const bySkeleton = new Map()
  for (const { enPairs } of parsedSources) {
    for (const [, en] of enPairs) {
      const skel = skeletonOf(en)
      if (!skel || !(skel in glossary)) continue
      if (!bySkeleton.has(skel)) bySkeleton.set(skel, new Set())
      bySkeleton.get(skel).add(en)
    }
  }
  const shared = [...bySkeleton.entries()].filter(([, ens]) => ens.size >= 2)
  const split = shared.filter(([, ens]) => new Set([...ens].map((en) => stripSkeleton(en))).size >= 2)
  return {
    keys: shared.length,
    entries: shared.reduce((a, [, ens]) => a + ens.size, 0),
    split: split.length,
    splitEntries: split.reduce((a, [, ens]) => a + ens.size, 0),
    splitExamples: split.slice(0, 5).map(([skel, ens]) => [skel, [...ens]]),
  }
}
const sharedBefore = sharedSkeletons(stripSkeletonOld, before)
const sharedAfter = sharedSkeletons(stripSkeleton, after)
console.log(`\n① 撞车骨架（同一骨架被 ≥2 个不同英文串共用，仅统计记忆里存在的骨架）`)
console.log(`   共用骨架（含大小写/颜色码/空白这类无害变体）：${sharedBefore.keys} 个 / ${sharedBefore.entries} 条英文 -> ${sharedAfter.keys} 个 / ${sharedAfter.entries} 条英文`)
console.log(`   **被 bug 合并出来的**（旧口径合并、新口径分开）：${sharedBefore.split} 个 / ${sharedBefore.splitEntries} 条英文 -> ${sharedAfter.split} 个 / ${sharedAfter.splitEntries} 条英文`)
for (const [skel, ens] of sharedBefore.splitExamples) console.log(`     例 ${JSON.stringify(skel)} <- ${ens.map((x) => JSON.stringify(x)).join(' | ')}`)
const equalsKey = Object.entries(after).filter(([k, v]) => k === v)
console.log(`   重建后仍有「值===键」的条目 ${equalsKey.length} 条（均来自 29 条缺中文源的旧条目保留）：${equalsKey.slice(0, 5).map(([k]) => JSON.stringify(k)).join(', ')}`)

// ---------- 4. 抽样：重建前 / 重建后命中率（与调研同一方法：stripSkeleton + lookup） ----------
// 重建前 = 旧骨架 + 旧记忆（复现调研基线）；重建后 = 新骨架 + 新记忆 + 读取端回退守卫（= pipeline 真实行为）。
function hitRate(key, skeletonOf, glossary, guardEcho) {
  const en = parsePairs(sources.entries[key])
  let hit = 0, empty = 0, echo = 0
  for (const [, v] of en) {
    const skel = skeletonOf(v)
    if (!skel) { empty++; continue }
    const got = glossary[skel]
    if (!got) continue
    if (guardEcho && got === v) { echo++; continue }
    hit++
  }
  return { total: en.length, hit, empty, echo }
}
const sampleKeys = entryKeys.filter((k) => !stats.zhMissing.includes(k)).slice(0, SAMPLE)
console.log(`\n② 抽样命中率（按 id 排序取前 ${sampleKeys.length} 条有中文源的光影）`)
console.log('   ' + 'id/ver'.padEnd(37) + '重建前'.padEnd(20) + '重建后（含回退守卫）')
let sumB = 0, sumBT = 0, sumA = 0, sumAT = 0
for (const key of sampleKeys) {
  const b = hitRate(key, stripSkeletonOld, before, false)
  const a = hitRate(key, stripSkeleton, after, true)
  sumB += b.hit; sumBT += b.total; sumA += a.hit; sumAT += a.total
  console.log(`   ${key.padEnd(34)}${`${b.hit}/${b.total}（空骨架 ${b.empty}）`.padEnd(20)}${a.hit}/${a.total}（空骨架 ${a.empty}，回退命中被挡 ${a.echo}）`)
}
console.log(`   合计：${sumB}/${sumBT}（${(sumB / sumBT * 100).toFixed(1)}%）-> ${sumA}/${sumAT}（${(sumA / sumAT * 100).toFixed(1)}%）`)
for (const key of ['noble/1.9.9', 'fs-shaders/1.8', 'paintbound/3.1']) {
  const b = hitRate(key, stripSkeletonOld, before, false)
  const a = hitRate(key, stripSkeleton, after, true)
  console.log(`   指定复核 ${key}：${b.hit}/${b.total}（空骨架 ${b.empty}）-> ${a.hit}/${a.total}（空骨架 ${a.empty}，回退命中被挡 ${a.echo}）`)
}

if (dryRun) {
  console.log('\n--dry-run：未写盘')
} else {
  writeFileSync(GLOSSARY_FILE, JSON.stringify(after, null, 2) + '\n')
  console.log(`\n已写入 ${GLOSSARY_FILE}（${count(after)} 条）`)
}
