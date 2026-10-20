#!/usr/bin/env node
/**
 * scripts/lib/resume-progress.mjs 的离线单元测试：断点续翻进度文件的状态机。
 *
 * 进度文件是**中间态**：删掉它最多导致重跑，绝不能导致错误产物。因此这里重点验证：
 * - 「已成功」的判据与 judgeLine 同口径（空回话 / 回显英文 / § 数量 / 占位符数量）；
 * - 源码行变了（同版本重新上传）→ 旧进度必须失效，不能把上一版英文的译文当成新版用；
 * - 版本 / id 不匹配、JSON 损坏 → 一律当「没有进度」，绝不抛错、绝不污染产物。
 *
 * 不发任何网络请求、不写盘。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { judgeLine } from '../scripts/lib/line-translator.mjs'
import {
  PROGRESS_FILE_NAME,
  PROGRESS_SCHEMA,
  progressRelativePath,
  isTranslatedLine,
  createProgress,
  parseProgress,
  serializeProgress,
  selectResumableEntries,
  recordProgress,
  progressSummary,
  planLines,
  pruneProgress,
} from '../scripts/lib/resume-progress.mjs'
import { stripSkeleton } from '../scripts/lib/glossary.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const META = { id: 'demo-shader', version: '1.0.0' }

/** 构造一份「上一轮成功翻出若干行」的进度对象。 */
function progressWith(lines) {
  const state = createProgress(META)
  for (const [key, source, value] of lines) recordProgress(state, key, source, value)
  return state
}

describe('isTranslatedLine：哪些行算「已成功」', () => {
  it('正常译文算成功', () => {
    assert.equal(isTranslatedLine('Off', '关闭'), true)
    assert.equal(isTranslatedLine('§eRed', '§e红色'), true)
    assert.equal(isTranslatedLine('Speed: %s', '速度：%s'), true)
    assert.equal(isTranslatedLine('Value %1$s', '数值 %1$s'), true)
  })

  it('空 / 纯空白 / 回显英文原文 → 不算成功（与 judgeLine 同口径）', () => {
    assert.equal(isTranslatedLine('Off', ''), false)
    assert.equal(isTranslatedLine('Off', '   '), false)
    assert.equal(isTranslatedLine('Off', 'Off'), false)
    // 与 judgeLine 一致：只做逐字比较，大小写差异不误判成回退
    assert.equal(isTranslatedLine('Off', 'OFF'), true)
  })

  it('§ 格式码数量不一致 → 不算成功', () => {
    assert.equal(isTranslatedLine('§eRed', '红色'), false)
    assert.equal(isTranslatedLine('Red', '§e红色'), false)
  })

  it('占位符数量不一致 → 不算成功', () => {
    assert.equal(isTranslatedLine('Speed %s', '速度'), false)
    assert.equal(isTranslatedLine('Speed', '速度 %s'), false)
    assert.equal(isTranslatedLine('%s / %d', '%s'), false)
  })

  it('与 judgeLine 在同口径输入上结论一致（防两套判据漂移）', () => {
    const cases = [
      ['Off', '关闭'],
      ['Off', 'Off'],
      ['Off', ''],
      ['§eRed', '红色'],
      ['§eRed', '§e红色'],
      ['Speed %s', '速度'],
      ['Speed %s', '速度 %s'],
      ['§a[+]§c[-]', '§a[+]§c[-]'],
      ['§a[+]§c[-]', '§a[+]§c[-] 已启用'],
    ]
    for (const [source, value] of cases) {
      // judgeLine 会先 cleanLineReply（去引号/围栏）；这里的样本都不触发清洗，
      // 因此两者应当逐条一致。
      assert.equal(
        isTranslatedLine(source, value),
        judgeLine(source, value).ok,
        `口径不一致: ${JSON.stringify({ source, value })}`,
      )
    }
  })

  it('空英文源：非空译文算成功，空译文不算', () => {
    assert.equal(isTranslatedLine('', '译文'), true)
    assert.equal(isTranslatedLine('', ''), false)
  })
})

describe('parseProgress / serializeProgress：文件格式与容错', () => {
  it('进度文件名是进度文件的唯一约定（pipeline 与测试共用）', () => {
    assert.equal(PROGRESS_FILE_NAME, '.progress.json')
  })

  it('序列化 → 解析可以还原（键顺序、源码行、译文都保留）', () => {
    const state = progressWith([
      ['option.A', 'Red', '红色'],
      ['option.B', 'Blue %s', '蓝色 %s'],
    ])
    const text = serializeProgress(state, '2026-10-20T00:00:00.000Z')
    const parsed = parseProgress(text)
    assert.equal(parsed.schema, PROGRESS_SCHEMA)
    assert.equal(parsed.id, META.id)
    assert.equal(parsed.version, META.version)
    assert.deepEqual([...parsed.lines.keys()], ['option.A', 'option.B'])
    assert.deepEqual(parsed.lines.get('option.B'), { src: 'Blue %s', value: '蓝色 %s' })
  })

  it('损坏 / 结构不对的 JSON 一律返回 null（进度文件坏了只能退回重跑）', () => {
    assert.equal(parseProgress('not json'), null)
    assert.equal(parseProgress('[]'), null)
    assert.equal(parseProgress('null'), null)
    assert.equal(parseProgress(JSON.stringify({ id: 'x', version: '1', lines: {} })), null, '缺 schema 应拒绝')
    assert.equal(parseProgress(JSON.stringify({ schema: 99, id: 'x', version: '1', lines: {} })), null, '未知 schema 应拒绝')
    assert.equal(parseProgress(JSON.stringify({ schema: 1, id: 'x', lines: {} })), null, '缺 version 应拒绝')
    assert.equal(parseProgress(JSON.stringify({ schema: 1, id: 'x', version: '1', lines: [] })), null, 'lines 必须是对象')
  })

  it('单条坏记录只丢这一条，不丢整份进度', () => {
    const parsed = parseProgress(JSON.stringify({
      schema: 1,
      id: META.id,
      version: META.version,
      lines: {
        'option.A': { src: 'Red', value: '红色' },
        'option.B': '不是对象',
        'option.C': { src: 'Blue' },
      },
    }))
    assert.deepEqual([...parsed.lines.keys()], ['option.A'])
  })
})

describe('selectResumableEntries：下次运行只能用「确实还成立」的行', () => {
  const pairs = [['option.A', 'Red'], ['option.B', 'Blue'], ['option.C', 'Green']]

  it('命中当前英文源且译文合格 → 可复用', () => {
    const progress = progressWith([
      ['option.A', 'Red', '红色'],
      ['option.C', 'Green', '绿色'],
    ])
    const resume = selectResumableEntries(progress, { ...META, pairs })
    assert.deepEqual([...resume], [['option.A', '红色'], ['option.C', '绿色']])
  })

  it('同一版本里英文源被改过 → 该行旧译文失效（不能拿旧版英文的译文）', () => {
    const progress = progressWith([['option.A', 'Red', '红色']])
    const resume = selectResumableEntries(progress, {
      ...META,
      pairs: [['option.A', 'Crimson']],
    })
    assert.equal(resume.size, 0)
  })

  it('进度里多出当前英文源没有的键 → 忽略（对应行已被上游删除）', () => {
    const progress = progressWith([['option.Z', 'Gone', '已删除']])
    const resume = selectResumableEntries(progress, { ...META, pairs })
    assert.equal(resume.size, 0)
  })

  it('进度文件里的译文按当前判据不合格 → 不复用（历史污染不能当真）', () => {
    const progress = progressWith([
      ['option.A', 'Red', 'Red'],       // 回显英文
      ['option.B', 'Blue', ''],          // 空译文
    ])
    const resume = selectResumableEntries(progress, { ...META, pairs })
    assert.equal(resume.size, 0)
  })

  it('id / 版本不匹配 → 整份进度失效', () => {
    const progress = progressWith([['option.A', 'Red', '红色']])
    assert.equal(selectResumableEntries(progress, { id: 'other', version: META.version, pairs }).size, 0)
    assert.equal(selectResumableEntries(progress, { id: META.id, version: '2.0.0', pairs }).size, 0)
  })

  it('没有进度（null）→ 空 Map，不抛错', () => {
    assert.equal(selectResumableEntries(null, { ...META, pairs }).size, 0)
  })
})

describe('recordProgress：只记成功的行，先到先得', () => {
  it('成功译文记入；回显 / 空格 / 格式码不一致不记', () => {
    const state = createProgress(META)
    assert.equal(recordProgress(state, 'a', 'Red', '红色'), true)
    assert.equal(recordProgress(state, 'b', 'Blue', 'Blue'), false)
    assert.equal(recordProgress(state, 'c', 'Green', '  '), false)
    assert.equal(recordProgress(state, 'd', '§eGold', '金色'), false)
    assert.deepEqual([...state.lines.keys()], ['a'])
  })

  it('已有记录不覆盖（与 glossary 的「已有则不写」守卫一致，保证重跑可复现）', () => {
    const state = createProgress(META)
    recordProgress(state, 'a', 'Red', '红色')
    assert.equal(recordProgress(state, 'a', 'Red', '赤色'), false)
    assert.equal(state.lines.get('a').value, '红色')
  })
})

describe('planLines：记忆优先，其次进度，其余才发 LLM', () => {
  const pairs = [['option.A', 'Red'], ['option.B', 'Blue'], ['option.C', 'Green'], ['option.D', 'Gold']]
  /** 用普通对象模拟全局 + 本条记忆的查询。 */
  const lookupFrom = (obj) => (skel) => obj[skel]

  it('没有进度时行为与改造前一致：只查记忆，其余全部待翻', () => {
    const plan = planLines(pairs, {
      lookup: lookupFrom({ [stripSkeleton('Blue')]: '蓝色' }),
      progress: null,
      ...META,
    })
    assert.deepEqual([...plan.reuse.keys()], ['option.B'])
    assert.equal(plan.reuse.get('option.B').origin, 'memory')
    assert.deepEqual(plan.pending, [['option.A', 'Red'], ['option.C', 'Green'], ['option.D', 'Gold']])
    assert.equal(plan.memoryHits, 1)
    assert.equal(plan.progressHits, 0)
  })

  it('记忆优先于进度（同一键两边都有时用记忆，与改造前一致）', () => {
    const progress = progressWith([['option.A', 'Red', '进度红色']])
    const plan = planLines(pairs, {
      lookup: lookupFrom({ [stripSkeleton('Red')]: '记忆红色' }),
      progress,
      ...META,
    })
    assert.equal(plan.reuse.get('option.A').value, '记忆红色')
    assert.equal(plan.reuse.get('option.A').origin, 'memory')
    assert.equal(plan.progressHits, 0)
  })

  it('进度补上记忆没命中的行；只剩真正没翻过的行待翻', () => {
    const progress = progressWith([
      ['option.A', 'Red', '红色'],
      ['option.C', 'Green', '绿色'],
    ])
    const plan = planLines(pairs, { lookup: lookupFrom({}), progress, ...META })
    assert.deepEqual([...plan.reuse.entries()], [
      ['option.A', { value: '红色', origin: 'progress' }],
      ['option.C', { value: '绿色', origin: 'progress' }],
    ])
    assert.deepEqual(plan.pending, [['option.B', 'Blue'], ['option.D', 'Gold']])
    assert.equal(plan.progressHits, 2)
  })

  it('进度属于别的版本 → 全部当没翻过', () => {
    const progress = progressWith([['option.A', 'Red', '红色']])
    const plan = planLines(pairs, { lookup: lookupFrom({}), progress, id: META.id, version: '2.0.0' })
    assert.equal(plan.reuse.size, 0)
    assert.equal(plan.pending.length, pairs.length)
  })

  it('复用集合 + 待翻集合恰好覆盖全部键，不重不漏（产物完整的必要条件）', () => {
    const progress = progressWith([['option.A', 'Red', '红色'], ['option.C', 'Green', '绿色']])
    const plan = planLines(pairs, { lookup: lookupFrom({ [stripSkeleton('Blue')]: '蓝色' }), progress, ...META })
    const covered = [...plan.reuse.keys(), ...plan.pending.map(([k]) => k)].sort()
    assert.deepEqual(covered, pairs.map(([k]) => k).sort())
  })
})

describe('pruneProgress：读到的进度先收敛到本次英文源', () => {
  const pairs = [['option.A', 'Red'], ['option.B', 'Blue'], ['option.C', 'Green']]

  it('只保留「键还在 + 英文源没变 + 译文合格」的行', () => {
    const old = progressWith([
      ['option.A', 'Red', '红色'],
      ['option.B', 'Blue', 'Blue'],   // 回显，本就不该被记
      ['option.C', 'Green', '绿色'],
      ['option.Z', 'Gone', '已删键'],
    ])
    const pruned = pruneProgress(old, { ...META, pairs })
    assert.deepEqual([...pruned.lines.keys()], ['option.A', 'option.C'])
  })

  it('英文源变了 → 丢掉该行（不能留着旧译文下次误用）', () => {
    const old = progressWith([['option.A', 'Red', '红色']])
    const pruned = pruneProgress(old, {
      ...META,
      pairs: [['option.A', 'Crimson']],
    })
    assert.equal(pruned.lines.size, 0)
  })

  it('id / 版本不符 → 返回**本次**的空进度（防止按旧 id 写回错误路径）', () => {
    const old = progressWith([['option.A', 'Red', '红色']])
    const pruned = pruneProgress(old, { id: 'other', version: META.version, pairs })
    assert.equal(pruned.id, 'other')
    assert.equal(pruned.version, META.version)
    assert.equal(pruned.lines.size, 0)
  })

  it('没有进度 → 返回本次的空进度对象', () => {
    const pruned = pruneProgress(null, { ...META, pairs })
    assert.equal(pruned.id, META.id)
    assert.equal(pruned.lines.size, 0)
  })

  it('不修改传入对象（纯函数）', () => {
    const old = progressWith([['option.A', 'Red', '红色'], ['option.Z', 'Gone', '删']])
    const before = [...old.lines.keys()]
    pruneProgress(old, { ...META, pairs })
    assert.deepEqual([...old.lines.keys()], before)
  })
})

describe('进度文件位置：不能进仓库，也不能进站点产物目录', () => {
  it('路径固定在 sources/<id>/<version>/ 下', () => {
    assert.equal(progressRelativePath('demo', '1.0.0'), 'sources/demo/1.0.0/.progress.json')
  })

  it('用 .gitignore 真值判定：sources/ 下的进度文件必须被忽略', () => {
    // 用 git check-ignore 而不是自己解析 .gitignore——后者容易和 git 的真实语义不一致。
    const r = spawnSync('git', ['check-ignore', '-q', progressRelativePath('demo', '1.0.0')], { cwd: ROOT })
    if (r.error) return // 没装 git 的环境跳过（CI 里一定有）
    assert.equal(r.status, 0, 'sources/ 必须被 .gitignore 排除，否则进度会进仓库')
  })

  it('绝不能落在 site/public/lang 下（那是站点静态产物，会公开发布）', () => {
    assert.doesNotMatch(progressRelativePath('demo', '1.0.0'), /^site\//)
  })

  it('文件名以 . 开头：不会被只认 *.lang 的工具误收', () => {
    assert.match(PROGRESS_FILE_NAME, /^\./)
    assert.doesNotMatch(PROGRESS_FILE_NAME, /\.lang$/)
  })

  it('pipeline 不在 site/public/lang 下写任何进度文件（源码级断言）', () => {
    // pipeline.mjs 无法 import，只能读源码。断言「写进度的路径来自 progressRelativePath」
    // 并且没有在 LANG_DIR 下拼 .progress.json。
    const src = readFileSync(join(ROOT, 'scripts/pipeline.mjs'), 'utf8')
    assert.match(src, /progressRelativePath\(/, 'pipeline 必须通过 lib 的路径构造器定位进度文件')
    assert.doesNotMatch(src, /join\(LANG_DIR[^)]*PROGRESS_FILE_NAME/, 'LANG_DIR 下不许放进度文件')
  })
})

describe('progressSummary：可观测的「翻到哪了」', () => {
  it('统计已成功 / 总数', () => {
    const state = progressWith([
      ['option.A', 'Red', '红色'],
      ['option.C', 'Green', '绿色'],
    ])
    const pairs = [['option.A', 'Red'], ['option.B', 'Blue'], ['option.C', 'Green']]
    assert.deepEqual(progressSummary(state, pairs), { done: 2, total: 3, remaining: 1 })
  })

  it('空进度 → 0 / 总数', () => {
    assert.deepEqual(progressSummary(createProgress(META), [['a', 'A']]), { done: 0, total: 1, remaining: 1 })
  })
})
