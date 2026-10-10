#!/usr/bin/env node
/**
 * validate-lang 的单元测试。
 *
 * 删掉人工质量确认后，validate-lang.mjs 是唯一的质量防线，
 * 因此它必须自己有测试 —— 尤其是「缺占位符必须被拦截」这条负例。
 *
 * 运行：npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  parse,
  extractPlaceholders,
  validatePair,
  decodeEscapes,
  countMalformedSections,
  repairMalformedSections,
  resolveEnText,
} from '../scripts/validate-lang.mjs'

const EN = [
  '#shaders/lang/en_US.lang',
  'option.AO=Ambient Occlusion',
  'option.bloom=Bloom Strength: %s',
  'option.shadow=Shadow Map %1$s at %s',
  'option.percent=Intensity %d%%',
  'option.custom=Profile %value% loaded',
  'option.color=§eWarning§r: §c%s',
  'option.num=0.50',
].join('\n')

test('parse 忽略注释与空行，按 = 切分键值', () => {
  const m = parse(EN)
  assert.equal(m.size, 7)
  assert.equal(m.get('option.AO'), 'Ambient Occlusion')
  assert.equal(m.get('option.num'), '0.50')
})

test('extractPlaceholders 正确识别各类占位符', () => {
  assert.deepEqual([...extractPlaceholders('Bloom Strength: %s')], [['%s', 1]])
  assert.deepEqual([...extractPlaceholders('Map %1$s at %s')], [['%1$s', 1], ['%s', 1]])
  assert.deepEqual([...extractPlaceholders('Intensity %d%%')], [['%d', 1], ['%%', 1]])
  assert.deepEqual([...extractPlaceholders('Profile %value% loaded')], [['%value%', 1]])
  assert.deepEqual([...extractPlaceholders('nothing here')], [])
})

test('extractPlaceholders 不把 %1$s 误拆成 %1 与 $s', () => {
  const counts = extractPlaceholders('%1$s')
  assert.equal(counts.get('%1$s'), 1)
  assert.equal(counts.get('%s'), undefined)
  assert.equal(counts.get('%1%'), undefined)
})

test('完全对应的翻译通过校验', () => {
  const ZH = [
    '#shaders/lang/zh_CN.lang',
    'option.AO=环境光遮蔽',
    'option.bloom=泛光强度：%s',
    'option.shadow=阴影贴图 %1$s 位于 %s',
    'option.percent=强度 %d%%',
    'option.custom=已加载配置档 %value%',
    'option.color=§e警告§r：§c%s',
    'option.num=0.50',
  ].join('\n')

  const r = validatePair(EN, ZH)
  assert.deepEqual(r.problems, [])
  assert.equal(r.keyCount, 7)
})

test('负例：丢掉 %s 必须被拦截（真实构造，不是拼写错误）', () => {
  const ZH = [
    'option.AO=环境光遮蔽',
    'option.bloom=泛光强度',              // 原本有 %s，被丢掉
    'option.shadow=阴影贴图 %1$s 位于 %s',
    'option.percent=强度 %d%%',
    'option.custom=已加载配置档 %value%',
    'option.color=§e警告§r：§c%s',
    'option.num=0.50',
  ].join('\n')

  const r = validatePair(EN, ZH)
  assert.equal(r.problems.length, 1)
  assert.match(r.problems[0], /占位符不一致/)
  assert.match(r.problems[0], /option\.bloom/)
})

test('负例：占位符数量变化必须被拦截', () => {
  const ZH = 'option.bloom=泛光强度 %s %s'
  const r = validatePair('option.bloom=Bloom Strength: %s', ZH)
  assert.match(r.problems.join('\n'), /占位符不一致/)
})

test('样式：§ 格式码数量不一致降为警告（不再拦截）', () => {
  const r = validatePair('option.color=§eWarning§r', 'option.color=§e警告')
  assert.deepEqual(r.problems, [])
  assert.match(r.warnings.join('\n'), /§ 格式码数量不一致/)
})

test('负例：缺键与多键都必须被拦截', () => {
  const r = validatePair('a=1\nb=2', 'a=1\nc=3')
  const joined = r.problems.join('\n')
  assert.match(joined, /缺少 1 个键: b/)
  assert.match(joined, /多出 1 个键: c/)
})

test('负例：BOM 必须被拦截', () => {
  const r = validatePair('a=1', '\uFEFFa=1')
  assert.match(r.problems.join('\n'), /BOM/)
})

test('值与英文相同只警告不拦截（数值类除外）', () => {
  const r = validatePair('a=Hello\nb=0.50', 'a=Hello\nb=0.50')
  assert.deepEqual(r.problems, [])
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0], /值与英文相同/)
})

// ---------- 闸门分线：致命 vs 样式 ----------

test('样式：§ 颜色码数量差异只警告不拦截', () => {
  const r = validatePair('option.c=§eWarning§r', 'option.c=警告')
  assert.deepEqual(r.problems, [])
  assert.match(r.warnings.join('\n'), /§ 格式码数量不一致/)
})

test('致命：译文引入畸形 § 序列必须拦截', () => {
  // EN 干净，ZH 多了 §e§ 这种非法序列
  const r = validatePair('option.c=Requires §eFog§r.', 'option.c=需要§e§ 雾§r。')
  assert.match(r.problems.join('\n'), /译文引入畸形 § 序列/)
  assert.match(r.problems.join('\n'), /option\.c/)
})

test('上游 EN 自带的畸形 § 序列不归咎译文', () => {
  // EN 与 ZH 同样畸形 → 不算译文引入
  const r = validatePair('option.c=§gBad', 'option.c=§g坏')
  assert.deepEqual(r.problems, [])
})

test('致命：非 %% 占位符差异拦截，%% 差异只警告', () => {
  const fatal = validatePair('option.a=Speed %s', 'option.a=速度')
  assert.match(fatal.problems.join('\n'), /占位符不一致/)

  const style = validatePair('option.b=Gain 30%%', 'option.b=提升30%')
  assert.deepEqual(style.problems, [])
  assert.match(style.warnings.join('\n'), /%% 占位符差异/)
})

test('致命：找不到英文源必须判失败（不得静默退回自检）', () => {
  assert.equal(resolveEnText(join('site/public/lang/__nonexistent__/v1/zh_CN.lang')), null)
})

// ---------- \u00a7 转义解码与畸形修复 ----------

test('decodeEscapes 把 \\u00a7 解码为 §', () => {
  assert.equal(decodeEscapes('\\u00a70\\u00a7lColored'), '§0§lColored')
  assert.equal(decodeEscapes('plain'), 'plain')
})

test('转义写法不再产生假失败（aberration-shader 回归）', () => {
  // EN 用转义，ZH 用真字符 —— 解码后必须视为一致
  const en = 'value.M.2=\\u00a70\\u00a7lColored Void'
  const zh = 'value.M.2=§0§l彩色虚空'
  const r = validatePair(en, zh)
  assert.deepEqual(r.problems, [])
  assert.deepEqual(r.warnings, [])
})

test('countMalformedSections 只统计非法序列', () => {
  assert.equal(countMalformedSections('§eok§r'), 0)
  assert.equal(countMalformedSections('§e§ bad'), 1)
  assert.equal(countMalformedSections('§§x'), 1)
  assert.equal(countMalformedSections('trailing§'), 1)
})

test('repairMalformedSections 删尾部孤立 §、把其余畸形补成 §r', () => {
  assert.deepEqual(repairMalformedSections('光§'), { text: '光', fixed: 1 })
  assert.deepEqual(repairMalformedSections('§e§ x'), { text: '§e§r x', fixed: 1 })
  assert.deepEqual(repairMalformedSections('§eok§r'), { text: '§eok§r', fixed: 0 })
})

test('修复后的值能通过闸门（自愈闭环）', () => {
  const zh = 'option.c=需要§e§ 雾§r。'
  const { text: fixed } = repairMalformedSections(zh.split('=')[1])
  const r = validatePair('option.c=Requires §eFog§r.', `option.c=${fixed}`)
  assert.deepEqual(r.problems, [])
})
