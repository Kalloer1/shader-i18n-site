#!/usr/bin/env node
/**
 * scripts/lib/translate-entries.mjs 的离线单元测试：记忆 → 进度 → LLM 的编排。
 *
 * 这是断点续翻的**行为证据**：不靠读代码推断，而是真的跑两轮，
 * 断言第二轮只把「第一轮没翻成的行」发给模型，且两轮合并结果一致。
 *
 * 全部离线：`translateChunk` 是假的，按行查表产出译文（或在指定行「失败」回显英文）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createTranslateEntries } from '../scripts/lib/translate-entries.mjs'
import { createProgress, parseProgress, serializeProgress, pruneProgress } from '../scripts/lib/resume-progress.mjs'
import { stripSkeleton } from '../scripts/lib/glossary.mjs'

const META = { id: 'demo', version: '1.0.0' }

/**
 * 假的分块翻译器：按 `answers` 查表；查不到（或列在 `failKeys` 里）就回显英文，
 * 与真实实现判回退后的行为一致（`evaluateOutput` 也把回退行放回 map）。
 */
function fakeTranslator({ answers, failKeys = new Set(), chunks = [] }) {
  return async (chunk) => {
    chunks.push(chunk.map(([k]) => k))
    const map = new Map()
    let fallback = 0
    for (const [k, v] of chunk) {
      if (failKeys.has(k) || !answers.has(k)) {
        map.set(k, v)
        fallback++
      } else {
        map.set(k, answers.get(k))
      }
    }
    return { map, fallback, providerIds: ['fake-provider'] }
  }
}

function makeRunner(overrides = {}) {
  return createTranslateEntries({
    translateChunk: overrides.translateChunk,
    nextProviderOrder: (list) => list,
    everythingUnusable: () => false,
    providerUnusableMessage: () => '全部提供方不可用',
    chunkLines: 60,
    chunkConcurrency: 1,
    log: () => {},
    ...overrides,
  })
}

const PAIRS = [
  ['option.A', 'Red'],
  ['option.B', 'Blue'],
  ['option.C', 'Green'],
  ['option.D', 'Gold'],
]
const ANSWERS = new Map([
  ['option.A', '红色'],
  ['option.B', '蓝色'],
  ['option.C', '绿色'],
  ['option.D', '金色'],
])
/** 记忆查询：这里用普通对象模拟「全局记忆」，默认空。 */
const lookupFrom = (obj = {}) => (skel) => obj[skel]

describe('第一轮失败 → 第二轮只补没翻成的行', () => {
  it('第二轮发给模型的行严格等于第一轮回退的行', async () => {
    const progress = createProgress(META)

    // 第一轮：B、D 失败（回显英文）
    const firstChunks = []
    const first = await makeRunner({
      translateChunk: fakeTranslator({ answers: ANSWERS, failKeys: new Set(['option.B', 'option.D']), chunks: firstChunks }),
    })(PAIRS, [{ id: 'p1' }], undefined, new Map(), {
      lookup: lookupFrom(),
      progress,
      ...META,
    })

    assert.equal(first.totalFallback, 2)
    // 进度只记成功的两行
    assert.deepEqual([...progress.lines.keys()], ['option.A', 'option.C'])

    // 第二轮：从序列化后的进度恢复（模拟读写文件），这次全部成功
    const restored = parseProgress(serializeProgress(progress))
    const secondChunks = []
    const second = await makeRunner({
      translateChunk: fakeTranslator({ answers: ANSWERS, chunks: secondChunks }),
    })(PAIRS, [{ id: 'p1' }], undefined, new Map(), {
      lookup: lookupFrom(),
      progress: pruneProgress(restored, { ...META, pairs: PAIRS }),
      ...META,
    })

    assert.deepEqual(secondChunks, [['option.B', 'option.D']], '第二轮只该翻第一轮失败的两行')
    assert.equal(second.progressHit, 2, '成功的两行由进度复用')
    assert.equal(second.totalFallback, 0)
    // 最终译文表覆盖全部键，且值全部正确（顺序无关：复用的行先入表，新翻的按块序追加）
    assert.deepEqual(
      [...second.map].sort(),
      PAIRS.map(([k]) => [k, ANSWERS.get(k)]).sort(),
    )
  })

  it('第二轮的回退数按全量口径统计（进度复用的行不算回退）', async () => {
    const progress = createProgress(META)
    const answers = new Map([['option.A', '红色'], ['option.C', '绿色']])
    await makeRunner({
      translateChunk: fakeTranslator({ answers, failKeys: new Set(['option.B', 'option.D']) }),
    })(PAIRS, [{ id: 'p1' }], undefined, new Map(), { lookup: lookupFrom(), progress, ...META })

    // 第二轮全部成功
    const second = await makeRunner({
      translateChunk: fakeTranslator({ answers: ANSWERS }),
    })(PAIRS, [{ id: 'p1' }], undefined, new Map(), { lookup: lookupFrom(), progress, ...META })
    assert.equal(second.totalFallback, 0)
    // 关键：分母仍是全部行 —— 30% 回退率闸门的口径不能被进度悄悄改变
    assert.equal(second.map.size, PAIRS.length)
  })

  it('全部成功时进度文件里的键 = 全部键（下次可安全删除）', async () => {
    const progress = createProgress(META)
    const r = await makeRunner({ translateChunk: fakeTranslator({ answers: ANSWERS }) })(
      PAIRS, [{ id: 'p1' }], undefined, new Map(), { lookup: lookupFrom(), progress, ...META },
    )
    assert.equal(r.totalFallback, 0)
    assert.deepEqual([...progress.lines.keys()].sort(), PAIRS.map(([k]) => k).sort())
  })
})

describe('进度文件如实反映「这一版翻到哪了」', () => {
  it('记忆命中的行也记进进度（否则日志/进度会低估完成度）', async () => {
    const progress = createProgress(META)
    await makeRunner({ translateChunk: fakeTranslator({ answers: ANSWERS, failKeys: new Set(['option.B', 'option.D']) }) })(
      PAIRS, [{ id: 'p1' }], undefined, new Map(), {
        lookup: lookupFrom({ [stripSkeleton('Red')]: '记忆红' }),
        progress,
        ...META,
      },
    )
    // A 来自记忆，C 来自 LLM，B/D 回退 —— 进度里应有 A、C 两行
    assert.deepEqual([...progress.lines.keys()].sort(), ['option.A', 'option.C'])
    assert.equal(progress.lines.get('option.A').value, '记忆红')
  })

  it('记忆全覆盖时，进度记录全部行并触发一次落盘', async () => {
    const progress = createProgress(META)
    const memory = Object.fromEntries(PAIRS.map(([, v]) => [stripSkeleton(v), `${v}-zh`]))
    let flushes = 0
    await makeRunner({ translateChunk: fakeTranslator({ answers: ANSWERS }) })(
      PAIRS, [{ id: 'p1' }], undefined, new Map(), {
        lookup: lookupFrom(memory),
        progress,
        ...META,
        onChunkDone: () => { flushes++ },
      },
    )
    assert.equal(progress.lines.size, PAIRS.length)
    assert.equal(flushes, 1, '记忆全覆盖也应有落盘回调，否则进度文件永远写不出去')
  })
})

describe('优先级与守卫保持不变', () => {
  it('翻译记忆优先于进度（同一键两边都有时用记忆）', async () => {
    const progress = createProgress(META)
    progress.lines.set('option.A', { src: 'Red', value: '进度里的红' })
    const chunks = []
    const r = await makeRunner({ translateChunk: fakeTranslator({ answers: ANSWERS, chunks }) })(
      PAIRS, [{ id: 'p1' }], undefined, new Map(), {
        lookup: lookupFrom({ [stripSkeleton('Red')]: '记忆里的红' }),
        progress,
        ...META,
      },
    )
    assert.equal(r.map.get('option.A'), '记忆里的红')
    assert.equal(r.glossaryHit, 1)
    assert.equal(r.progressHit, 0)
    // 剩余的三行按原顺序进同一块（chunkLines=60 足够装下）。
    // fakeTranslator 记录的是每块的键列表（不是键值对）。
    assert.deepEqual(chunks, [['option.B', 'option.C', 'option.D']])
  })

  it('记忆全覆盖时一次模型调用都不发（与改造前一致）', async () => {
    const chunks = []
    const memory = Object.fromEntries(PAIRS.map(([, v]) => [stripSkeleton(v), `${v}-zh`]))
    const r = await makeRunner({ translateChunk: fakeTranslator({ answers: ANSWERS, chunks }) })(
      PAIRS, [{ id: 'p1' }], undefined, new Map(), { lookup: lookupFrom(memory), progress: createProgress(META), ...META },
    )
    assert.deepEqual(chunks, [])
    assert.equal(r.llmCalls, 0)
    assert.equal(r.map.size, PAIRS.length)
  })

  it('回退行不进记忆（与改造前的 shouldRememberMemory 守卫一致）', async () => {
    const localGlossary = new Map()
    await makeRunner({
      translateChunk: fakeTranslator({ answers: ANSWERS, failKeys: new Set(['option.B']) }),
    })(PAIRS, [{ id: 'p1' }], undefined, localGlossary, { lookup: lookupFrom(), progress: createProgress(META), ...META })
    assert.ok(!localGlossary.has(stripSkeleton('Blue')), '回退行不能进记忆')
    assert.equal(localGlossary.get(stripSkeleton('Red')), '红色')
  })

  it('进度里的污染（回显英文）不会被当成译文复用', async () => {
    const progress = createProgress(META)
    progress.lines.set('option.A', { src: 'Red', value: 'Red' })
    const chunks = []
    const r = await makeRunner({ translateChunk: fakeTranslator({ answers: ANSWERS, chunks }) })(
      PAIRS, [{ id: 'p1' }], undefined, new Map(), {
        lookup: lookupFrom(),
        progress: pruneProgress(progress, { ...META, pairs: PAIRS }),
        ...META,
      },
    )
    assert.equal(r.map.get('option.A'), '红色', '应重新翻译而不是复用回显')
    assert.ok(chunks.flat().includes('option.A'))
  })
})

describe('块级行为', () => {
  it('每块完成即触发 onChunkDone（超时前已翻好的块才能落盘）', async () => {
    const progress = createProgress(META)
    let flushes = 0
    const pairs = Array.from({ length: 3 }, (_, i) => [`k${i}`, `V${i}`])
    const answers = new Map(pairs.map(([k, v]) => [k, `${v}-zh`]))
    await makeRunner({ translateChunk: fakeTranslator({ answers }), chunkLines: 1, chunkConcurrency: 1 })(
      pairs, [{ id: 'p1' }], undefined, new Map(), {
        lookup: lookupFrom(),
        progress,
        ...META,
        onChunkDone: () => { flushes++ },
      },
    )
    assert.equal(flushes, 3, '3 块应有 3 次落盘回调')
  })

  it('某块抛错时，已完成块的进度仍然留下（finally 语义由调用方保证，这里验证写入时机）', async () => {
    const progress = createProgress(META)
    const pairs = [['k0', 'V0'], ['k1', 'V1']]
    let calls = 0
    const runner = makeRunner({
      translateChunk: async (chunk) => {
        calls++
        if (calls === 2) throw new Error('boom')
        const map = new Map(chunk.map(([k, v]) => [k, `${v}-zh`]))
        return { map, fallback: 0, providerIds: ['p'] }
      },
      chunkLines: 1,
      chunkConcurrency: 1,
    })
    await assert.rejects(
      runner(pairs, [{ id: 'p1' }], undefined, new Map(), { lookup: lookupFrom(), progress, ...META }),
      /boom/,
    )
    assert.deepEqual([...progress.lines.keys()], ['k0'], '第一块的成果必须已经写进进度对象')
  })

  it('所有提供方不可用 → 抛错，且不发任何请求', async () => {
    const chunks = []
    await assert.rejects(
      makeRunner({
        translateChunk: fakeTranslator({ answers: ANSWERS, chunks }),
        everythingUnusable: () => true,
      })(PAIRS, [{ id: 'p1' }], undefined, new Map(), {
        lookup: lookupFrom(), progress: createProgress(META), ...META,
      }),
      /全部提供方不可用/,
    )
    assert.deepEqual(chunks, [])
  })
})
