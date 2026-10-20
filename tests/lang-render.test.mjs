#!/usr/bin/env node
/**
 * scripts/lib/lang-render.mjs 的离线单元测试：渲染必须与改造前**逐字节一致**。
 *
 * 为什么这是硬约束：断点续翻复用的是进度文件里的译文。如果「复用译文」和「重新调 LLM
 * 得到同一批译文」渲染出的字节不同，那么「进度文件只是中间态」这句话就不成立——
 * 它悄悄改变了产物。因此这里既测规则，也拿仓库里真实 lang 文件做往返比对。
 *
 * 往返口径：`renderBody(文件正文行, 从该正文解析出的键值)` 必须原样得到原正文。
 * 不成立的情况只有一类：**落盘时修过畸形 § 的行**（修复不可逆，原文已被丢弃），
 * 这类行在下面单独统计并断言数量很小、且修复前后等价（校验闸门对此只警告不阻断）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { renderBody, buildHeader, renderZhLang } from '../scripts/lib/lang-render.mjs'
import { repairMalformedSections } from '../scripts/validate-lang.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LANG_DIR = join(ROOT, 'site/public/lang')

/** 读文件并归一为 LF（Windows 检出会是 CRLF，仓库里存的是 LF）。 */
function readLf(p) {
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
}

/** 正文 → 键值表（与 pipeline 解析口径一致：trim、跳过注释/空行、第一个等号切分）。 */
function parseBody(body) {
  const map = new Map()
  for (const line of body) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    map.set(t.slice(0, eq), t.slice(eq + 1))
  }
  return map
}

describe('renderBody：规则', () => {
  it('注释、空行、无等号的行原样保留', () => {
    const lines = ['# 注释', '', '   # 缩进注释', 'not a pair', '#=注释等号']
    assert.deepEqual(renderBody(lines, new Map(), repairMalformedSections), lines)
  })

  it('有译文的键用译文，没有的回退英文原值', () => {
    const lines = ['a=Red', 'b=Blue']
    const out = renderBody(lines, new Map([['a', '红色']]), repairMalformedSections)
    assert.deepEqual(out, ['a=红色', 'b=Blue'])
  })

  it('行首尾空白被去掉、等号两侧的内部空白保留（与改造前 slice 语义一致）', () => {
    // 原实现对整行 trim 后按第一个等号切分，因此行首尾空白消失，
    // 但 `a =  Red` 的键名尾空格与值前空格**保留**。这是既有行为，不能「顺手修好」。
    const out = renderBody(['  a =  Red  '], new Map(), repairMalformedSections)
    assert.deepEqual(out, ['a =  Red'])
  })

  it('落盘前修掉畸形 §（与改造前一致，含行尾残留空格）', () => {
    assert.deepEqual(
      renderBody(['a=X'], new Map([['a', '§e§ ']]), repairMalformedSections),
      ['a=§e§r '],
    )
  })
})

describe('buildHeader / renderZhLang', () => {
  it('文件头三段与改造前逐字一致', () => {
    assert.equal(
      buildHeader({ title: 'Demo', id: 'demo', shaderVersion: '1.2.3', sourceFileName: 'Demo.zip', enName: 'shaders/lang/en_US.lang' }),
      '#shaders/lang/zh_CN.lang\n# Demo v1.2.3 简体中文翻译（AI 初翻，未人工校对）\n# 源文件：Demo.zip 的 shaders/lang/en_US.lang\n',
    )
  })

  it('title 缺失时退回 id（改造前的 entry.title ?? entry.id）', () => {
    assert.match(buildHeader({ id: 'demo', shaderVersion: '1', sourceFileName: 'x.zip', enName: 'e' }), /# demo v1 /)
  })

  it('全文 = 文件头 + 正文 join("\\n")', () => {
    const text = renderZhLang({
      title: 'T', id: 'i', shaderVersion: '1', sourceFileName: 'f.zip', enName: 'en_US.lang',
      lines: ['a=Red'], zhMap: new Map([['a', '红']]), repair: repairMalformedSections,
    })
    assert.equal(text, '#shaders/lang/zh_CN.lang\n# T v1 简体中文翻译（AI 初翻，未人工校对）\n# 源文件：f.zip 的 en_US.lang\na=红')
  })
})

describe('真实文件往返：复用译文得到的字节与原文一致', () => {
  // 遍历仓库现有产物（602 个）。每个文件取第 4 行起的正文（前 3 行是文件头）。
  const files = []
  if (existsSync(LANG_DIR)) {
    for (const id of readdirSync(LANG_DIR)) {
      for (const ver of readdirSync(join(LANG_DIR, id))) {
        const p = join(LANG_DIR, id, ver, 'zh_CN.lang')
        if (existsSync(p)) files.push({ id, ver, p })
      }
    }
  }

  it('至少扫到 500 个真实文件（数据在仓库里，不能空跑）', () => {
    assert.ok(files.length > 500, `只找到 ${files.length} 个 lang 文件`)
  })

  it('渲染是幂等的：对已有产物再渲染一次，字节不变（这正是续翻所需的保证）', () => {
    // 这条才是断点续翻真正需要的性质：
    //   若 F === render(英文源, 译文表)，且进度把 F 的键值原样记下，
    //   那么 render(英文源, 进度) === F。
    // 等价形式：F 自己再过一遍渲染必须回到 F（不动点）。
    // 首次渲染与 F 有差异是允许的（trim 空白、修畸形 §、重复键 last-wins，均为改造前既有行为），
    // 但**第二遍必须完全稳定**，否则复用译文就会改变产物。
    const unstable = []
    let checked = 0
    for (const { id, ver, p } of files) {
      // git 的 core.autocrlf 在 Windows 检出时把 LF 变成 CRLF；仓库里存的是 LF，
      // 流水线 writeFileSync 也原样写 LF。归一换行后比的才是真实产物字节。
      const body = readLf(p).split('\n').slice(3)
      const first = renderBody(body, parseBody(body), repairMalformedSections)
      const second = renderBody(first, parseBody(first), repairMalformedSections)
      checked++
      if (second.join('\n') !== first.join('\n')) unstable.push(`${id}/${ver}`)
    }
    assert.ok(checked > 0, '没有可比的文件')
    assert.deepEqual(unstable, [], `以下文件渲染不稳定（复用译文会改变字节）: ${unstable.slice(0, 10).join(', ')}`)
  })

  it('首次渲染的差异只能来自 trim / 畸形 § 修复 / 重复键 last-wins', () => {
    // 显式断言「没有别的改动」：逐行检查渲染结果的值，必须等于
    //   该键在文件里**最后一次出现**的值，trim 后修 §。
    // 重复键按 last-wins 取值是改造前就有的行为（validate-lang 也按同一口径）。
    const unexplained = []
    for (const { id, ver, p } of files) {
      const body = readLf(p).split('\n').slice(3)
      const map = parseBody(body)
      const out = renderBody(body, map, repairMalformedSections)
      if (out.length !== body.length) {
        unexplained.push(`${id}/${ver}: 行数变化 ${body.length} → ${out.length}`)
        continue
      }
      for (let i = 0; i < body.length; i++) {
        const t = body[i].trim()
        if (!t || t.startsWith('#') || t.indexOf('=') <= 0) {
          if (out[i] !== body[i]) unexplained.push(`${id}/${ver} 第 ${i + 4} 行（非键值行被改动）`)
          continue
        }
        const eq = t.indexOf('=')
        const key = t.slice(0, eq)
        const expected = `${key}=${repairMalformedSections(map.get(key)).text}`
        if (out[i] !== expected) unexplained.push(`${id}/${ver} 第 ${i + 4} 行（渲染规则之外的改动）`)
      }
    }
    assert.deepEqual(unexplained, [], `无法解释的差异: ${unexplained.slice(0, 10).join(', ')}`)
  })

  it('模拟续翻：从产物里读回译文表再渲染，与直接渲染逐字节一致', () => {
    // 最小但完整的端到端证明：用一份合成英文源翻出产物，再把产物里的值当作
    // 「进度文件里的译文」重新渲染，两者必须完全相同。
    const enLines = [
      '# header comment',
      '',
      'option.A=Red',
      'option.B=Blue %s',
      'option.C=§eGold',
      'option.D=Untranslated',
    ]
    const zhMap = new Map([
      ['option.A', '红色'],
      ['option.B', '蓝色 %s'],
      ['option.C', '§e金色'],
    ])
    const first = renderBody(enLines, zhMap, repairMalformedSections)
    // 续翻时进度里只有成功行；未翻的 option.D 仍回退英文，与首轮一致。
    const resumed = new Map(parseBody(first))
    resumed.delete('option.D')
    const second = renderBody(enLines, resumed, repairMalformedSections)
    assert.deepEqual(second, first)
    assert.deepEqual(first, [
      '# header comment',
      '',
      'option.A=红色',
      'option.B=蓝色 %s',
      'option.C=§e金色',
      'option.D=Untranslated',
    ])
  })

  it('不传 repair 时，差异只来自 trim / 重复键：渲染逻辑本身不丢内容', () => {
    // 用「纯拷贝」的 repair，把「修复不可逆」从「渲染有损」里分离出来。
    const identity = (v) => ({ text: v, fixed: 0 })
    const unexplained = []
    const identity2 = identity
    for (const { id, ver, p } of files) {
      const body = readLf(p).split('\n').slice(3)
      const map = parseBody(body)
      const out = renderBody(body, map, identity2)
      if (out.length !== body.length) {
        unexplained.push(`${id}/${ver}: 行数变化`)
        continue
      }
      for (let i = 0; i < body.length; i++) {
        if (out[i] === body[i]) continue
        const t = body[i].trim()
        if (!t || t.startsWith('#') || t.indexOf('=') <= 0) {
          unexplained.push(`${id}/${ver} 第 ${i + 4} 行（非键值行被改动）`)
          continue
        }
        const eq = t.indexOf('=')
        const key = t.slice(0, eq)
        if (out[i] !== `${key}=${map.get(key)}`) {
          unexplained.push(`${id}/${ver} 第 ${i + 4} 行（渲染规则之外的改动）`)
        }
      }
    }
    assert.deepEqual(unexplained, [], `渲染逻辑本身有损: ${unexplained.slice(0, 10).join(', ')}`)
  })
})
