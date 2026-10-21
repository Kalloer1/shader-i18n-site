#!/usr/bin/env node
/**
 * 免费层接入（issue #2 / #3 / #5）：免费层优先，失败落回退池。
 *
 * 这组测试的核心是**三条硬判据**（issue #2 的验收标准）：
 * 1. 免费层成功时**完全不碰**网关；
 * 2. 免费层失败时**确实落到**网关，且产出与只用网关时一致；
 * 3. 免费层的熔断是**连续 2 次**才触发（单次抖动只降级当前分块）。
 *
 * 全部离线：网络调用由 `call` 注入，不碰任何真实接口。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseLangLines,
  parseLangResponse,
  evaluateOutput,
  fallbackThreshold,
  tryFreeTier,
  translateChunkTwoLayer,
  nextProviderOrder,
  resetProviderOrderCursor,
  createChunkTranslator,
} from '../scripts/lib/provider-chain.mjs'
import {
  createFreeTierProvider,
  createGatewayProvider,
  buildInstTransPrompt,
  buildGatewayPrompt,
  buildContributorLine,
  INST_TRANS_TERMS,
  SYSTEM_PROMPT,
  FREE_TIER_MAX_TOKENS,
  FREE_TIER_TEMPERATURE,
  GATEWAY_MAX_TOKENS,
} from '../scripts/lib/providers.mjs'

const CHUNK = [
  ['option.SHADOWS', 'Shadows'],
  ['option.BLOOM', 'Bloom'],
  ['option.AO', 'Ambient Occlusion'],
]
const input = CHUNK.map(([k, v]) => `${k}=${v}`).join('\n')

/** 造一个会按脚本回话的假调用；记录每次调用了哪个 provider。 */
function makeCall(script) {
  const calls = []
  const call = async (provider) => {
    calls.push(provider.id)
    const reply = script(provider, calls.length - 1)
    if (reply instanceof Error) throw reply
    return reply
  }
  return { call, calls }
}

const zh = (pairs) => pairs.map(([k, v]) => `${k}=${v}`).join('\n')
const GOOD = zh([['option.SHADOWS', '阴影'], ['option.BLOOM', '泛光'], ['option.AO', '环境光遮蔽']])

/**
 * 造一个免费层 provider。`model` 可指定模型名（多模型池测试需要不同 id）；
 * 不传则用默认的主模型。**id 由模型名决定，测试里靠它区分不同模型。**
 */
const freeProvider = (model = 'Index-Translate-35B-A3B') =>
  createFreeTierProvider({ model, url: () => 'https://free.invalid/v1', label: model })
const poolProvider = (id = 'opencode-zen-free/beam-free') =>
  createGatewayProvider({ model: id, url: () => 'https://gw.invalid/v1', key: () => 'k', label: id })

// ---------- 1. 免费层成功时不碰网关 ----------

test('免费层成功且回退率合格 → 完全不调用网关', async () => {
  const free = freeProvider()
  const pool = poolProvider()
  const { call, calls } = makeCall((p) => (p.id === free.id ? GOOD : zh([['option.SHADOWS', '网关译文']])))

  const r = await translateChunkTwoLayer({
    chunk: CHUNK, input, freeTier: free, poolProviders: [pool], call, signal: undefined,
  })

  assert.deepEqual(calls, [free.id], '只应调用免费层')
  assert.equal(r.fallback, 0)
  assert.deepEqual(r.providerIds, [free.id], '署名只该有免费层')
  assert.equal(r.map.get('option.SHADOWS'), '阴影')
})

test('免费层成功时若回退率合格，网关一次也不试（多模型也一样）', async () => {
  const free = freeProvider()
  const pools = [poolProvider('a'), poolProvider('b'), poolProvider('c')]
  const { call, calls } = makeCall((p) => (p.id === free.id ? GOOD : GOOD))

  await translateChunkTwoLayer({ chunk: CHUNK, input, freeTier: free, poolProviders: pools, call })

  assert.equal(calls.filter((id) => id !== free.id).length, 0, '网关调用次数应为 0')
})

// ---------- 2b. 多模型池（用户 2026-10-21：所有免费模型都要试，分担压力） ----------

const LAZY = zh([['option.SHADOWS', 'Shadows'], ['option.BLOOM', 'Bloom'], ['option.AO', '环境光遮蔽']]) // 回退 2/3
test('多模型池：第一个免费模型翻得差 → 试下一个免费模型，仍然不碰网关', async () => {
  // 这是 2026-10-21 实测催出来的行为：同一块 index-mt-2b 只出 74/228 条译文，
  // 而 index-mt-9b 出 220/228。「换模型」常常就是质量差异，不必动网关预算。
  resetProviderOrderCursor() // 固定起手顺序为 [bad, good]，否则轮换会让 good 先上并提前返回
  const bad = freeProvider()
  const good = freeProvider('index-mt-9b')
  const pool = poolProvider()
  const { call, calls } = makeCall((p) => (p.id === bad.id ? LAZY : GOOD))
  const misses = []

  const r = await translateChunkTwoLayer({
    chunk: CHUNK, input, freeTier: [bad, good], poolProviders: [pool], call,
    onFreeTierQualityMiss: (id) => misses.push(id),
  })

  assert.equal(r.fallback, 0, '应由第二个免费模型拿下全部三键')
  // 差模型也记进署名：它确实产出了部分译文（这一块里 环境光遮蔽 是它翻的），
  // 与单模型时的既有语义一致——不谎报来源，也不抹掉它的贡献。
  assert.deepEqual([...r.providerIds].sort(), [bad.id, good.id].sort(), '两边都记账')
  assert.ok(!calls.includes(pool.id), '网关一次都不该被调用')
  assert.deepEqual(misses, [bad.id], '翻得差要上报质量失手（供降级）')
})

test('多模型池：单模型时行为不变（回退率偏高仍直接转交网关）', async () => {
  // 向后兼容：只配一个免费模型时，池内没有「下一个」可试，行为必须和改造前逐字一致。
  const free = freeProvider()
  const pool = poolProvider()
  const { call, calls } = makeCall((p) => (p.id === free.id ? LAZY : GOOD))

  const r = await translateChunkTwoLayer({ chunk: CHUNK, input, freeTier: free, poolProviders: [pool], call })

  assert.deepEqual(calls, [free.id, pool.id], '单模型：偏高就直接转交网关')
  assert.equal(r.fallback, 0)
})

test('多模型池：所有免费模型都翻得差 → 才转交网关（保留最好的那份）', async () => {
  // 两个都用**整块**模型：逐句模型（-syllable）在单测里会让假 call 的「一次回整块」
  // 语义不成立（那条路径一行一个请求），测不出想测的东西。
  resetProviderOrderCursor()
  const m1 = freeProvider()
  const m2 = freeProvider('index-mt-9b')
  const pool = poolProvider()
  const { call, calls } = makeCall((p) => (p.id === pool.id ? GOOD : LAZY))

  const r = await translateChunkTwoLayer({ chunk: CHUNK, input, freeTier: [m1, m2], poolProviders: [pool], call })

  assert.deepEqual(calls.slice().sort(), [m1.id, m2.id, pool.id].sort(), '两个免费模型都试过才动网关')
  assert.equal(r.fallback, 0)
  assert.deepEqual([...r.providerIds].sort(), [m1.id, m2.id, pool.id].sort(), '署名两边都记账')
})

test('多模型池：被熔断的模型不再进入轮换（isUsable 逐模型判定）', async () => {
  resetProviderOrderCursor()
  const broken = freeProvider()
  const alive = freeProvider('index-mt-9b')
  const pool = poolProvider()
  const { call, calls } = makeCall((p) => (p.id === broken.id ? new Error('boom') : GOOD))

  const r = await translateChunkTwoLayer({
    chunk: CHUNK, input, freeTier: [broken, alive], poolProviders: [pool], call,
    isUsable: (p) => p.id !== broken.id,
  })

  assert.ok(!calls.includes(broken.id), '已熔断的模型不该再被调用')
  assert.equal(r.fallback, 0)
  assert.deepEqual(r.providerIds, [alive.id])
})

test('多模型池：质量失手上报带模型 id，成功则清零（好模型不会因历史被拖累）', async () => {
  // 池内模型轮换会让「哪一个模型起手」逐块变化，所以降级必须按模型分别计连续次数；
  // 成功一次就清零，否则好模型偶尔撞上一个难分块就被永久降级。
  const calls0 = []
  const misses = new Map()
  const ok = (id) => { misses.set(id, 0) }
  const miss = (id) => { misses.set(id, (misses.get(id) ?? 0) + 1) }

  const bad = freeProvider()
  const good = freeProvider('index-mt-9b')
  // 第一块：bad 先起手且翻得差 → 记一次失手；good 拿下并清零自己
  resetProviderOrderCursor()
  await translateChunkTwoLayer({
    chunk: CHUNK, input, freeTier: [bad, good], poolProviders: [],
    call: makeCall((p) => (p.id === bad.id ? LAZY : GOOD)).call,
    onFreeTierSuccess: ok, onFreeTierQualityMiss: miss,
  })
  assert.equal(misses.get(bad.id), 1, '翻得差记一次失手')

  // 第二块：good 直接成功 → 不动 bad 的计数，也不误伤 good 自己
  miss(bad.id)
  ok(good.id)
  assert.equal(misses.get(bad.id), 2, '失手按模型累计')
  assert.equal(misses.get(good.id), 0, '成功的模型计数被清零')
})

test('nextProviderOrder：轮换起点逐次后移，且不修改入参', () => {
  // 模块级游标跨用例累加，先归零才能断言绝对顺序。
  resetProviderOrderCursor()
  const list = ['a', 'b', 'c']
  const seen = []
  for (let i = 0; i < 4; i++) seen.push(nextProviderOrder(list).join(','))
  assert.deepEqual(seen, ['a,b,c', 'b,c,a', 'c,a,b', 'a,b,c'], '起点应逐次后移并循环')
  assert.deepEqual(list, ['a', 'b', 'c'], '不得修改入参')
  assert.deepEqual(nextProviderOrder([]), [], '空列表原样返回')
})

// ---------- 2. 免费层失败时确实落到网关 ----------

for (const [label, boom] of [
  ['超时', Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })],
  ['非 2xx', new Error('HTTP 503: upstream unavailable')],
  ['空正文', Object.assign(new Error('返回为空'), { name: 'EmptyResponseError' })],
]) {
  test(`免费层${label} → 落到网关，且产出与只用网关时一致`, async () => {
    const free = freeProvider()
    const pool = poolProvider()
    // 两次运行各自一份调用记录，否则 calls 会串在一起。
    const withFreeCall = makeCall((p) => (p.id === free.id ? boom : GOOD))
    const poolOnlyCall = makeCall(() => GOOD)

    const withFree = await translateChunkTwoLayer({ chunk: CHUNK, input, freeTier: free, poolProviders: [pool], call: withFreeCall.call })
    const poolOnly = await translateChunkTwoLayer({ chunk: CHUNK, input, freeTier: null, poolProviders: [pool], call: poolOnlyCall.call })

    assert.deepEqual(withFreeCall.calls, [free.id, pool.id], '应先试免费层，失败后落到网关')
    assert.equal(withFree.fallback, 0)
    assert.deepEqual([...withFree.map], [...poolOnly.map], '产出应与只用网关时一致')
    assert.deepEqual(withFree.providerIds, [pool.id], '署名只该有网关')
  })
}

test('免费层漏掉个别键 → **按行回退**，其余译文照用（不整块丢弃）', async () => {
  // 20 行丢 4 个 = 20% > 10% 阈值 → 应转交回退池；但**关键是没把 16 条好译文扔掉**
  const chunk = Array.from({ length: 20 }, (_, i) => [`option.K${i}`, `Setting number ${i}`])
  const input20 = chunk.map(([k, v]) => `${k}=${v}`).join('\n')
  const free = freeProvider()
  const pool = poolProvider()
  // 免费层只给出前 16 行（漏掉 K16..K19）
  const partial = chunk.slice(0, 16).map(([k]) => `${k}=译${k.replace('option.', '')}`).join('\n')
  // 让回退池也失败：这样最终结果就是免费层的部分产出，直接证明「16 条好译文没被扔掉」
  const { call, calls } = makeCall((p) => (p.id === free.id ? partial : new Error('HTTP 503')))

  const r = await translateChunkTwoLayer({ chunk, input: input20, freeTier: free, poolProviders: [pool], call })

  // 关键：20 行里 16 行拿到译文，只回退 4 行（旧行为会整块丢弃 → 回退 20）
  assert.equal(r.fallback, 4, '只回退漏掉的 4 行，而不是整块 20 行')
  assert.equal(r.map.get('option.K0'), '译K0')
  assert.equal(r.map.get('option.K15'), '译K15')
  assert.equal(r.map.get('option.K16'), 'Setting number 16', '漏掉的键保留英文原值')
  // 回退率 20% > 10% → 仍转交回退池再试（由阈值把关，而不是「键不全就全丢」）
  assert.equal(calls[0], free.id, '先试免费层')
  assert.equal(calls[1], pool.id, '回退率超标应交回退池再试')
})

test('免费层漏键但不超阈值 → 直接采纳部分译文，不惊动网关', async () => {
  const chunk = Array.from({ length: 20 }, (_, i) => [`option.K${i}`, `Setting number ${i}`])
  const free = freeProvider()
  const pool = poolProvider()
  const text = chunk.slice(0, 19).map(([k]) => `${k}=译${k.replace('option.', '')}`).join('\n') // 漏最后 1 个 = 5%
  const { call, calls } = makeCall((p) => (p.id === free.id ? text : 'SHOULD_NOT_BE_CALLED'))

  const r = await translateChunkTwoLayer({ chunk, input: chunk.map(([k, v]) => `${k}=${v}`).join('\n'), freeTier: free, poolProviders: [pool], call })

  assert.deepEqual(calls, [free.id], '漏 1/20 不该惊动网关')
  assert.equal(r.fallback, 1)
  assert.deepEqual(r.providerIds, [free.id])
})

test('免费层回话里有重复键 → 该键按回退处理（防静默污染）', async () => {
  const free = freeProvider()
  const pool = poolProvider()
  // 键名重命名撞车：option.SHADOWS.comment 被写成 option.SHADOWS
  const collided = [
    'option.SHADOWS=阴影',
    'option.SHADOWS=§e[+]§r 切换阴影渲染的长句说明', // 撞车
    'option.BLOOM=泛光',
    'option.AO=环境光遮蔽',
  ].join('\n')
  const { call } = makeCall((p) => (p.id === free.id ? collided : GOOD))

  const r = await translateChunkTwoLayer({ chunk: CHUNK, input, freeTier: free, poolProviders: [pool], call })

  // 重复键不可信 → 回退成英文，绝不把长句写进 option.SHADOWS
  assert.equal(r.map.get('option.SHADOWS'), 'Shadows', '重复键必须回退，不能采信任何一行')
  assert.ok(r.fallback >= 1)
})

test('免费层回话完整但回退率偏高 → 仍转交网关，但**不**算失败', async () => {
  const free = freeProvider()
  const pool = poolProvider()
  // 键都在，但有两个回显英文（回退 2/3 > 10%）
  const lazy = zh([['option.SHADOWS', 'Shadows'], ['option.BLOOM', 'Bloom'], ['option.AO', '环境光遮蔽']])
  const { call, calls } = makeCall((p) => (p.id === free.id ? lazy : GOOD))
  let failures = 0

  const r = await translateChunkTwoLayer({
    chunk: CHUNK, input, freeTier: free, poolProviders: [pool], call,
    onFreeTierFailure: () => { failures++ },
  })

  assert.deepEqual(calls, [free.id, pool.id], '应转交网关再试')
  assert.equal(failures, 0, '回话完整就不该记失败（它不是挂了，只是翻得差）')
  assert.equal(r.fallback, 0)
  // 网关更好，采用网关结果；署名两边都算上（免费层确实产出了部分译文）
  assert.deepEqual([...r.providerIds].sort(), [free.id, pool.id].sort())
})

test('免费层更差时不会覆盖它已拿到的好结果', async () => {
  const free = freeProvider()
  const pool = poolProvider()
  const lazy = zh([['option.SHADOWS', 'Shadows'], ['option.BLOOM', 'Bloom'], ['option.AO', '环境光遮蔽']]) // 回退 2/3
  const worse = zh([['option.SHADOWS', 'Shadows'], ['option.BLOOM', 'Bloom'], ['option.AO', 'Ambient Occlusion']]) // 回退 3/3
  const { call } = makeCall((p) => (p.id === free.id ? lazy : worse))

  const r = await translateChunkTwoLayer({ chunk: CHUNK, input, freeTier: free, poolProviders: [pool], call })

  assert.equal(r.fallback, 2, '应保留免费层的 2/3，而不是被更差的 3/3 覆盖')
  assert.equal(r.map.get('option.AO'), '环境光遮蔽')
})

// ---------- 3. 熔断是「连续 2 次」 ----------

test('免费层单次失败不熔断：下一分块仍会尝试免费层', async () => {
  const free = freeProvider()
  const pool = poolProvider()
  const unusable = new Set()
  let failures = 0
  let consecutive = 0
  const onFailure = () => { failures++; consecutive++; if (consecutive >= 2) unusable.add(free.id) }
  const onSuccess = () => { consecutive = 0 }
  const { call, calls } = makeCall((p, i) => (p.id === free.id && i === 0 ? new Error('HTTP 500') : GOOD))

  // 第一次：免费层失败 → 网关
  await translateChunkTwoLayer({
    chunk: CHUNK, input, freeTier: free, poolProviders: [pool], call,
    onFreeTierFailure: onFailure, onFreeTierSuccess: onSuccess, isUsable: (p) => !unusable.has(p.id),
  })
  assert.equal(failures, 1)
  assert.ok(!unusable.has(free.id), '单次失败不该熔断')

  // 第二次：仍应尝试免费层
  const before = calls.length
  await translateChunkTwoLayer({
    chunk: CHUNK, input, freeTier: unusable.has(free.id) ? null : free, poolProviders: [pool], call,
    onFreeTierFailure: onFailure, onFreeTierSuccess: onSuccess, isUsable: (p) => !unusable.has(p.id),
  })
  assert.equal(calls[before], free.id, '第二次仍应先试免费层')
})

test('免费层连续 2 次失败后熔断：后续分块不再调用免费层', async () => {
  const free = freeProvider()
  const pool = poolProvider()
  const unusable = new Set()
  let consecutive = 0
  const onFailure = () => { consecutive++; if (consecutive >= 2) unusable.add(free.id) }
  const onSuccess = () => { consecutive = 0 }
  const { call, calls } = makeCall(() => new Error('HTTP 503'))

  for (let i = 0; i < 3; i++) {
    await translateChunkTwoLayer({
      chunk: CHUNK, input,
      freeTier: unusable.has(free.id) ? null : free,
      poolProviders: [pool], call,
      onFreeTierFailure: onFailure, onFreeTierSuccess: onSuccess, isUsable: (p) => !unusable.has(p.id),
    })
  }

  assert.ok(unusable.has(free.id), '连续 2 次后应熔断')
  const freeCalls = calls.filter((id) => id === free.id).length
  assert.equal(freeCalls, 2, '熔断后不该再调用免费层（总调用恰好 2 次）')
})

test('免费层成功会重置连续失败计数', async () => {
  const free = freeProvider()
  const pool = poolProvider()
  const unusable = new Set()
  let consecutive = 0
  const onFailure = () => { consecutive++; if (consecutive >= 2) unusable.add(free.id) }
  const onSuccess = () => { consecutive = 0 }
  // 交替：免费层失败、成功、失败、成功 → 连续计数每次都被成功重置，永不熔断。
  // 注意不能用全局调用序号：网关的调用也会把序号推高。
  let freeTierCalls = 0
  const { call } = makeCall((p) => {
    if (p.id !== free.id) return GOOD
    const n = freeTierCalls++
    return n % 2 === 0 ? new Error('HTTP 500') : GOOD
  })

  for (let i = 0; i < 4; i++) {
    await translateChunkTwoLayer({
      chunk: CHUNK, input, freeTier: free, poolProviders: [pool], call,
      onFreeTierFailure: onFailure, onFreeTierSuccess: onSuccess, isUsable: (p) => !unusable.has(p.id),
    })
  }
  assert.equal(freeTierCalls, 4, '每轮都应尝试免费层')
  assert.ok(!unusable.has(free.id), '被成功重置后不该熔断')
})

// ---------- 回退池行为不许变 ----------

test('回退池：空池 + 免费层失败 → 全回退，不抛异常', async () => {
  const free = freeProvider()
  const { call } = makeCall(() => new Error('HTTP 500'))

  const r = await translateChunkTwoLayer({ chunk: CHUNK, input, freeTier: free, poolProviders: [], call })

  assert.equal(r.fallback, CHUNK.length, '无任何提供方可用时全回退')
  assert.deepEqual(r.providerIds, [])
})

test('回退池：完全无提供方（免费层关掉、池为空）→ 全回退', async () => {
  const r = await translateChunkTwoLayer({ chunk: CHUNK, input, freeTier: null, poolProviders: [], call: async () => { throw new Error('不该被调用') } })
  assert.equal(r.fallback, CHUNK.length)
})

// Bug 修复的端到端证据：数值密集的分块不该被「回退率过高」判死。
// 实测 alphalook 4697 键里 3152 行是纯数字/百分比（`-95`、`5%`），旧判据把它们
// 全算成回退（67%），整条正常光影被判失败。这里用 60 行里 52 行无字母的分块复现。
test('回退池：无字母行不计回退、也不进阈值分母（数值密集分块不再被误判）', async () => {
  const chunk = [
    ...Array.from({ length: 8 }, (_, i) => [`option.K${i}`, `Setting number ${i}`]),
    ...Array.from({ length: 52 }, (_, i) => [`value.NUM.${i}`, i % 2 ? `${i}%` : `-${i}`]),
  ]
  assert.equal(chunk.length, 60)
  const free = freeProvider()
  const pool = poolProvider()
  // 免费层把 8 行可翻行全翻好，数值行原样返回（模型的正常行为）
  const reply = [
    ...chunk.slice(0, 8).map(([k]) => `${k}=译${k.replace('option.', '')}`),
    ...chunk.slice(8).map(([k, v]) => `${k}=${v}`),
  ].join('\n')
  const { call, calls } = makeCall((p) => (p.id === free.id ? reply : new Error('不该走到回退池')))

  const r = await translateChunkTwoLayer({
    chunk, input: chunk.map(([k, v]) => `${k}=${v}`).join('\n'),
    freeTier: free, poolProviders: [pool], call,
  })

  assert.equal(r.fallback, 0, '数值行保留原值不是回退')
  assert.deepEqual(calls, [free.id], '回退率 0/8 合格，不该转交回退池')
  assert.deepEqual(r.providerIds, [free.id])
  assert.equal(r.map.get('option.K0'), '译K0')
  assert.equal(r.map.get('value.NUM.1'), '1%', '数值行原值保留')
})

test('回退池：阈值分母是可翻译行数（52 行无字母时 2 行回退仍合格）', async () => {
  const chunk = [
    ...Array.from({ length: 8 }, (_, i) => [`option.K${i}`, `Setting number ${i}`]),
    ...Array.from({ length: 52 }, (_, i) => [`value.NUM.${i}`, `-${i}`]),
  ]
  const free = freeProvider()
  const pool = poolProvider()
  // 8 行里漏 2 行 = 25% > 10% → 应转交回退池（说明阈值确实按 8 行算，而不是按 60 行）
  const reply = chunk.slice(0, 6).map(([k]) => `${k}=译${k.replace('option.', '')}`).join('\n')
  const { call, calls } = makeCall((p) => (p.id === free.id ? reply : GOOD))

  await translateChunkTwoLayer({
    chunk, input: chunk.map(([k, v]) => `${k}=${v}`).join('\n'),
    freeTier: free, poolProviders: [pool], call,
  })

  assert.equal(calls[1], pool.id, '2/8=25% 超阈值，应转交回退池（若按 60 行算只有 3.3% 就不会转交）')
})

// ---------- 熔断：连续零产出才弃用（实测 CI run 39520489773） ----------
// 当时只有「首块 + 空正文」才 markUnusable，超时的模型永远不会被标记：
// 三个网关模型各自挂满超时 × 3 次尝试，每个走回退池的分块都要重挂一遍，
// 一条光影的候选预算（8 分钟）就这么烧光。下面锁住新语义。

test('熔断：连续 2 块零产出 → markUnusable，且不再被调用', async () => {
  const free = freeProvider()
  const pool = poolProvider('a')
  const unusable = new Set()
  const streaks = new Map()
  const onProviderOutcome = (id, zeroOutput) => {
    const n = zeroOutput ? (streaks.get(id) ?? 0) + 1 : 0
    if (zeroOutput) streaks.set(id, n); else streaks.delete(id)
    return n
  }
  // 免费层失败 → 走回退池；回退池每次都超时
  const { call, calls } = makeCall((p) => (p.id === free.id ? new Error('HTTP 500') : Object.assign(new Error('timeout'), { name: 'TimeoutError' })))

  const run = () => translateChunkTwoLayer({
    chunk: CHUNK, input, freeTier: free, poolProviders: unusable.has('a') ? [] : [pool], call,
    markUnusable: (id) => unusable.add(id),
    onProviderOutcome,
    isNoOutput: () => false,
  })

  await run()
  assert.ok(!unusable.has('a'), '第 1 块零产出不该立刻熔断（可能是抖动）')
  await run()
  assert.ok(unusable.has('a'), '连续 2 块零产出应熔断')

  const before = calls.filter((id) => id === 'a').length
  await run()
  assert.equal(calls.filter((id) => id === 'a').length, before, '熔断后不该再调用它')
})

test('熔断：只要产出过一行译文就不计零产出（偶发失败不该熔断能用的模型）', async () => {
  const free = freeProvider()
  const pool = poolProvider('a')
  const streaks = new Map()
  const onProviderOutcome = (id, zeroOutput) => {
    const n = zeroOutput ? (streaks.get(id) ?? 0) + 1 : 0
    if (zeroOutput) streaks.set(id, n); else streaks.delete(id)
    return n
  }
  const marked = []
  // 免费层失败；回退池「翻得差但确实产出了」：3 行里 2 行有译文
  const partial = zh([['option.SHADOWS', '阴影'], ['option.BLOOM', 'Bloom'], ['option.AO', 'Ambient Occlusion']])
  const { call } = makeCall((p) => (p.id === free.id ? new Error('HTTP 500') : partial))

  for (let i = 0; i < 4; i++) {
    await translateChunkTwoLayer({
      chunk: CHUNK, input, freeTier: free, poolProviders: [pool], call,
      markUnusable: (id) => marked.push(id),
      onProviderOutcome,
      isNoOutput: () => false,
    })
  }

  assert.deepEqual(marked, [], '有产出就不是「产不出译文」，不该熔断')
  assert.equal(streaks.get('a') ?? 0, 0, '有产出应清零连续零产出计数')
})

test('回退池：首块零译文时弃用该模型（早停判据仍生效）', async () => {
  const free = freeProvider()
  const a = poolProvider('a')
  const b = poolProvider('b')
  const unusable = new Set()
  const noOutput = zh([['option.SHADOWS', 'Shadows'], ['option.BLOOM', 'Bloom'], ['option.AO', 'Ambient Occlusion']])
  const { call, calls } = makeCall((p) => (p.id === free.id ? new Error('HTTP 500') : p.id === 'a' ? noOutput : GOOD))
  const marked = []

  const r = await translateChunkTwoLayer({
    chunk: CHUNK, input, freeTier: free, poolProviders: [a, b], call,
    isFirstChunk: true,
    markUnusable: (id) => { marked.push(id); unusable.add(id) },
    isNoOutput: ({ fallback, chunkLength, translatableLines }) =>
      chunkLength >= 10 ? fallback === chunkLength && translatableLines > 0 : false,
  })

  assert.equal(r.fallback, 0)
  assert.deepEqual(r.providerIds, ['b'], 'a 零译文被弃用后应用 b 的结果')
})

// ---------- 提示词 / 请求体隔离 ----------

test('免费层提示词：单条 user 消息、含【源文】与【约束要求】、术语用 A→B', () => {
  const msgs = buildInstTransPrompt('option.A=Apple')
  assert.equal(msgs.length, 1, 'instTrans 形态是单条消息')
  assert.equal(msgs[0].role, 'user', '不带 system 角色')
  assert.ok(msgs[0].content.includes('【源文】'))
  assert.ok(msgs[0].content.includes('【约束要求】'))
  assert.ok(msgs[0].content.includes('option.A=Apple'))
  assert.ok(msgs[0].content.includes('chunk→区块'), '术语应以 A→B 形式出现')
  assert.ok(msgs[0].content.includes('键名一字不改'), '必须有键名不改的显式约束')
})

test('两种提示词形态互不混用', () => {
  const gw = buildGatewayPrompt('x')
  assert.equal(gw[0].role, 'system')
  assert.equal(gw[0].content, SYSTEM_PROMPT)
  assert.ok(!gw[0].content.includes('【源文】'))

  const inst = buildInstTransPrompt('x')
  assert.equal(inst[0].role, 'user')
  assert.ok(!inst[0].content.includes(SYSTEM_PROMPT))
})

test('免费层请求体：固定字段，**不含** LLM_EXTRA_BODY', () => {
  const free = createFreeTierProvider({ model: 'm', url: () => 'u', label: 'x' })
  const body = free.body([{ role: 'user', content: 'hi' }])
  assert.deepEqual(body, {
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: FREE_TIER_TEMPERATURE,
    max_tokens: FREE_TIER_MAX_TOKENS,
    // 官方 call_api.py 的默认：不关 thinking，CoT 会顶掉译文。
    chat_template_kwargs: { enable_thinking: false },
  })
  // 关键隔离：网关的 LLM_EXTRA_BODY 之类不能泄漏到免费层
  assert.ok(!('extra_body' in body))
  assert.deepEqual(
    Object.keys(body).sort(),
    ['chat_template_kwargs', 'max_tokens', 'messages', 'model', 'temperature'],
  )
})

test('免费层必须显式关闭 thinking（官方 call_api.py 的硬性前提）', () => {
  // 漏掉它不会报错，只会静默产出思维链或空正文 —— 必须有测试锁住。
  const free = createFreeTierProvider({ model: 'm', url: () => 'u', label: 'x' })
  const body = free.body([{ role: 'user', content: 'hi' }])
  assert.equal(body.chat_template_kwargs.enable_thinking, false)
})

test('免费层 max_tokens 对齐官方默认 1024，不再沿用网关的 8192', () => {
  // 官方 call_api.py 默认 max_tokens=1024，是配合 enable_thinking=false 给的预算；
  // 沿用 8192 会让推理型模型在超时前一直生成。两者刻意不同口径。
  assert.equal(FREE_TIER_MAX_TOKENS, 1024)
  assert.notEqual(FREE_TIER_MAX_TOKENS, GATEWAY_MAX_TOKENS)
})

test('免费层 provider 自带快速降级策略（无退避、60 秒超时、无需 key）', () => {
  const free = createFreeTierProvider({ model: 'm', url: () => 'u', label: 'x' })
  assert.equal(free.maxAttempts, 1, '单次尝试，无退避重试')
  assert.equal(free.requestTimeoutMs, 60000, '单请求 60 秒超时')
  assert.equal(free.key(), undefined, '免费层不需要 key')
  // 刻意没有 requiresCompleteKeys：漏键按行回退，由回退率阈值把关
  assert.equal(free.requiresCompleteKeys, undefined)
})

// 语义变更（Bug 修复，实测 CI run 39520489773）：网关以前**没有** requestTimeoutMs，
// 于是挂住的请求只能等外层候选 signal 中止（8 分钟）——免费层 12 秒翻完的光影，
// 被 3 个卡在网关上的分块拖到整条超时。现在网关自带 90 秒单请求超时。
test('网关 provider 没有免费层专属字段，但有单请求超时', () => {
  const gw = createGatewayProvider({ model: 'm', url: () => 'u', key: () => 'k', label: 'x' })
  assert.equal(gw.maxAttempts, undefined, '网关仍走 MAX_RETRIES')
  assert.equal(gw.requestTimeoutMs, 90000, '网关必须有单请求超时，否则挂住的请求会拖满候选预算')
  // 免费层专属字段仍然不该出现在网关上
  assert.equal(gw.perLine, undefined)
  assert.equal(gw.lineConcurrency, undefined)
})

test('术语表两边不漂移：SYSTEM_PROMPT 的术语都在 INST_TRANS_TERMS 里', () => {
  // SYSTEM_PROMPT 必须逐字不变，所以术语单独列了一份；这里防止两份漂移。
  const mustHave = ['区块', '群系', '原版', '光影包', '资源包', '环境光遮蔽', '泛光', '体积光', '景深', '焦散', '高光', '法线贴图', '视差', '自发光', '抗锯齿', '色调映射', '饱和度', '自然饱和度', '配置档', '阴影贴图', '天空盒', '半透明', '运动模糊', '暗角', '色差', '镜头光晕', '折射']
  const targets = INST_TRANS_TERMS.map(([, b]) => b)
  for (const t of mustHave) {
    assert.ok(targets.includes(t), `INST_TRANS_TERMS 缺少「${t}」`)
    assert.ok(SYSTEM_PROMPT.includes(t), `SYSTEM_PROMPT 缺少「${t}」`)
  }
})

// ---------- 署名 ----------

test('署名：只走免费层时写明免费层，且不谎报网关模型', () => {
  const line = buildContributorLine(['Index-Translate-35B-A3B'], 'Index-Translate-35B-A3B')
  assert.ok(line.includes('免费层'))
  assert.ok(!line.includes('回退池'))
  assert.ok(line.includes('未人工校对'))
})

test('署名：只走网关时写明回退池，且不含免费层标识', () => {
  const line = buildContributorLine(['opencode-zen-free/beam-free'], 'Index-Translate-35B-A3B')
  assert.ok(line.includes('回退池'))
  assert.ok(line.includes('opencode-zen-free/beam-free'))
  assert.ok(!line.includes('免费层'))
})

test('署名：混合产出时两边都写，不谎报单一来源', () => {
  const line = buildContributorLine(['Index-Translate-35B-A3B', 'opencode-zen-free/beam-free'], 'Index-Translate-35B-A3B')
  assert.ok(line.includes('免费层'))
  assert.ok(line.includes('回退池'))
})

test('署名：完全没调 LLM（记忆全覆盖）时不谎报来源', () => {
  const line = buildContributorLine([], 'Index-Translate-35B-A3B')
  assert.ok(line.includes('翻译记忆复用'))
  assert.ok(!line.includes('免费层'))
  assert.ok(!line.includes('回退池'))
})

test('署名：同一提供方出现多次不重复列出', () => {
  const line = buildContributorLine(['gw', 'gw', 'gw'], 'free')
  assert.equal(line.match(/gw/g).length, 1)
})

test('署名：不把 provider id 重复列在「来源」之外', () => {
  // 只走免费层时，署名里不该再出现一次裸 id（旧实现会把 id 列两遍）。
  const line = buildContributorLine(['Index-Translate-35B-A3B'], 'Index-Translate-35B-A3B')
  assert.equal(line.match(/Index-Translate-35B-A3B/g).length, 1)
})

// ---------- 纯解析 / 纯计算 ----------

test('parseLangLines：容忍代码块围栏与前后杂讯', () => {
  const got = parseLangLines('```\noption.A=苹果\noption.B=香蕉\n```\n以上。')
  assert.equal(got.get('option.A'), '苹果')
  assert.equal(got.get('option.B'), '香蕉')
  assert.equal(got.size, 2)
})

test('parseLangLines：空键与无等号行被忽略', () => {
  const got = parseLangLines('=值\n没有等号\noption.A=苹果')
  assert.equal(got.size, 1)
  assert.equal(got.get('option.A'), '苹果')
})

test('evaluateOutput：译文等于原文算回退（模型回显英文不是译文）', () => {
  const got = parseLangLines('option.SHADOWS=Shadows\noption.BLOOM=泛光')
  const r = evaluateOutput(CHUNK, got)
  assert.equal(r.fallback, 2, 'SHADOWS 回显 + AO 缺失 = 2')
  assert.deepEqual(r.missingKeys, ['option.AO'])
  assert.equal(r.untranslatable, 0, 'CHUNK 全是可翻译行')
})

// Bug 修复的整块路径证据：模型对 `-95` / `5%` 这类行通常原样返回，
// 旧判据（zh !== v）会把它们计成回退，数值密集的光影因此被判死。
test('evaluateOutput：无字母行原样返回**不算回退**（单独记 untranslatable）', () => {
  const chunk = [
    ['option.SHADOWS', 'Shadows'],
    ['value.BRIGHTNESS.-95', '-95'],
    ['value.WATER_DETAIL.0.05', '5%'],
    ['value.SEP', '---'],
    ['value.EMPTY', ''],
  ]
  // 模型把数值行原样返回，只翻了 Shadows
  const got = parseLangLines([
    'option.SHADOWS=阴影',
    'value.BRIGHTNESS.-95=-95',
    'value.WATER_DETAIL.0.05=5%',
    'value.SEP=---',
    'value.EMPTY=',
  ].join('\n'))
  const r = evaluateOutput(chunk, got)
  assert.equal(r.fallback, 0, '无字母行保留原值是正确行为，不是回退')
  assert.equal(r.untranslatable, 4)
  assert.deepEqual(r.missingKeys, [], '无字母行也不该进 missingKeys（它们本来就不发去翻）')
  assert.equal(r.map.get('option.SHADOWS'), '阴影')
  assert.equal(r.map.get('value.BRIGHTNESS.-95'), '-95')
})

test('fallbackThreshold：60 行分块阈值为 6（基准是可翻译行数）', () => {
  assert.equal(fallbackThreshold(60), 6)
  assert.equal(fallbackThreshold(3), 1)
  // 数值密集的块：100 行里只有 10 行可翻 → 阈值按 10 算（1），不是按 100 算（10）。
  // 旧口径会把这种块的回退率放大 10 倍，实测 alphalook 4697 键里 3152 行是纯数字。
  assert.equal(fallbackThreshold(10), 1)
  assert.equal(fallbackThreshold(0), 0)
})

test('tryFreeTier：provider 为 null 时不调用、返回 null', async () => {
  let called = false
  const r = await tryFreeTier({ chunk: CHUNK, provider: null, call: async () => { called = true } })
  assert.equal(r, null)
  assert.equal(called, false)
})

// ---------- 装配层（createChunkTranslator）----------
// 这一节堵的是**真实覆盖盲区**：装配逻辑原先内联在 pipeline.mjs 里，
// 而 pipeline.mjs 顶层会跑整个流水线、无法被单测 import，于是这段胶水层从没被跑过。
// 结果是重构时接连踩到 `timestamp is not defined` 与 `log is not defined`。

test('装配层：把环境状态注入纯逻辑，免费层优先且日志带 label 前缀', async () => {
  const free = freeProvider()
  const pool = poolProvider()
  const unusable = new Set()
  const lines = []
  const { call, calls } = makeCall((p) => (p.id === free.id ? GOOD : GOOD))

  const translate = createChunkTranslator({
    freeTierProvider: free,
    isFreeTierUsable: () => !unusable.has(free.id),
    onFreeTierFailure: () => unusable.add(free.id),
    onFreeTierSuccess: () => unusable.delete(free.id),
    isUnusable: (id) => unusable.has(id),
    markUnusable: (id) => unusable.add(id),
    callProvider: (p, messages, sig) => call(p, sig),
    isNoOutput: () => false,
    log: (m) => lines.push(m),
  })

  const r = await translate(CHUNK, [pool], undefined, { label: '分块 1/1 ' })

  assert.deepEqual(calls, [free.id], '免费层优先，成功就不碰网关')
  assert.equal(r.fallback, 0)
  assert.deepEqual(r.providerIds, [free.id])
})

test('装配层：日志统一带 label 前缀（调用方拼，lib 只给消息）', async () => {
  const free = freeProvider()
  const lines = []
  const { call } = makeCall(() => new Error('HTTP 500'))
  const translate = createChunkTranslator({
    freeTierProvider: free,
    isFreeTierUsable: () => true,
    onFreeTierFailure: () => {},
    onFreeTierSuccess: () => {},
    isUnusable: () => false,
    markUnusable: () => {},
    callProvider: (p, messages, sig) => call(p, sig),
    isNoOutput: () => false,
    log: (m) => lines.push(m),
  })

  await translate(CHUNK, [], undefined, { label: '分块 2/5 ' })

  assert.ok(lines.length > 0, '免费层失败应产出日志')
  assert.ok(lines.every((l) => l.startsWith('    分块 2/5 ')), `每行都该带 label 前缀，实际：${JSON.stringify(lines)}`)
})

test('装配层：免费层失败后落到回退池（端到端装配路径）', async () => {
  const free = freeProvider()
  const pool = poolProvider()
  const unusable = new Set()
  const { call, calls } = makeCall((p) => (p.id === free.id ? new Error('HTTP 503') : GOOD))

  const translate = createChunkTranslator({
    freeTierProvider: free,
    isFreeTierUsable: () => !unusable.has(free.id),
    onFreeTierFailure: () => unusable.add(free.id),
    onFreeTierSuccess: () => {},
    isUnusable: (id) => unusable.has(id),
    markUnusable: (id) => unusable.add(id),
    callProvider: (p, messages, sig) => call(p, sig),
    isNoOutput: () => false,
  })

  const r = await translate(CHUNK, [pool], undefined, {})

  assert.deepEqual(calls, [free.id, pool.id])
  assert.equal(r.fallback, 0)
  assert.deepEqual(r.providerIds, [pool.id])
})

test('装配层：已熔断的提供方被过滤掉，不会再被调用', async () => {
  const free = freeProvider()
  const a = poolProvider('a')
  const b = poolProvider('b')
  const unusable = new Set(['a'])
  const { call, calls } = makeCall((p) => (p.id === free.id ? new Error('HTTP 503') : GOOD))

  const translate = createChunkTranslator({
    freeTierProvider: free,
    isFreeTierUsable: () => true,
    onFreeTierFailure: () => {},
    onFreeTierSuccess: () => {},
    isUnusable: (id) => unusable.has(id),
    markUnusable: (id) => unusable.add(id),
    callProvider: (p, messages, sig) => call(p, sig),
    isNoOutput: () => false,
  })

  const r = await translate(CHUNK, [a, b], undefined, {})

  assert.ok(!calls.includes('a'), 'a 已熔断，不该被调用')
  assert.ok(calls.includes('b'))
  assert.deepEqual(r.providerIds, ['b'])
})

test('装配层：免费层关闭（null）时直接走回退池', async () => {
  const pool = poolProvider()
  const { call, calls } = makeCall(() => GOOD)
  const translate = createChunkTranslator({
    freeTierProvider: null,
    isFreeTierUsable: () => false,
    onFreeTierFailure: () => {},
    onFreeTierSuccess: () => {},
    isUnusable: () => false,
    markUnusable: () => {},
    callProvider: (p, messages, sig) => call(p, sig),
    isNoOutput: () => false,
  })

  const r = await translate(CHUNK, [pool], undefined, {})

  assert.deepEqual(calls, [pool.id])
  assert.equal(r.fallback, 0)
})

test('装配层：把 provider 的 buildPrompt 结果交给 callProvider（提示词来自 provider）', async () => {
  const free = freeProvider()
  let seenMessages = null
  const translate = createChunkTranslator({
    freeTierProvider: free,
    isFreeTierUsable: () => true,
    onFreeTierFailure: () => {},
    onFreeTierSuccess: () => {},
    isUnusable: () => false,
    markUnusable: () => {},
    callProvider: (p, messages) => { seenMessages = messages; return GOOD },
    isNoOutput: () => false,
  })

  await translate(CHUNK, [], undefined, {})

  assert.ok(Array.isArray(seenMessages))
  assert.equal(seenMessages[0].role, 'user', '免费层走 instTrans 形态')
  assert.ok(seenMessages[0].content.includes('【源文】'))
  assert.ok(seenMessages[0].content.includes('option.SHADOWS=Shadows'), '输入应含待译文本')
})

test('装配层：信号透传给 callProvider（超时/中止能真正断开）', async () => {
  const free = freeProvider()
  const ac = new AbortController()
  let seenSignal = null
  const translate = createChunkTranslator({
    freeTierProvider: free,
    isFreeTierUsable: () => true,
    onFreeTierFailure: () => {},
    onFreeTierSuccess: () => {},
    isUnusable: () => false,
    markUnusable: () => {},
    callProvider: (p, messages, sig) => { seenSignal = sig; return GOOD },
    isNoOutput: () => false,
  })

  await translate(CHUNK, [], ac.signal, {})

  assert.equal(seenSignal, ac.signal, '应把调用方的 signal 传下去')
})

// ---------- 逐句模型（syllable）分流 ----------

test('逐句模型：走 line-translator，一行一个请求，且不把 key 发给模型', async () => {
  const perLine = createFreeTierProvider({
    model: 'index-mt-9b-syllable',
    url: () => 'https://free.invalid/v1',
    label: 'free',
  })
  assert.equal(perLine.perLine, true, 'syllable 模型必须被识别为逐句')

  const sent = []
  const translate = createChunkTranslator({
    freeTierProvider: perLine,
    isFreeTierUsable: () => true,
    onFreeTierFailure: () => {},
    onFreeTierSuccess: () => {},
    isUnusable: () => false,
    markUnusable: () => {},
    // 逐句路径会传三参（provider, 单行文本, signal）
    callProvider: (p, text) => {
      sent.push(text)
      return '译文' + sent.length
    },
    isNoOutput: () => false,
    log: () => {},
  })

  const r = await translate(CHUNK, [], undefined, {})

  assert.equal(sent.length, CHUNK.length, `应一行一个请求；实际 ${sent.length} 次`)
  // 每行请求都只含 value，不含 key（实测把回显率从 15.5% 压到 6.5%）
  for (const [k, v] of CHUNK) {
    assert.ok(sent.some((s) => s.endsWith(v)), `应发过 value "${v}"`)
    assert.ok(!sent.some((s) => s.includes(k)), `不该把 key "${k}" 发给模型`)
  }
  assert.equal(r.providerIds[0], perLine.id)
  assert.equal(r.fallback, 0)
})

test('整块模型仍走整块路径（一行请求都不该拆）', async () => {
  const whole = createFreeTierProvider({ model: 'Index-Translate-35B-A3B', url: () => 'u', label: 'x' })
  assert.equal(whole.perLine, false)

  const sent = []
  const translate = createChunkTranslator({
    freeTierProvider: whole,
    isFreeTierUsable: () => true,
    onFreeTierFailure: () => {},
    onFreeTierSuccess: () => {},
    isUnusable: () => false,
    markUnusable: () => {},
    callProvider: (p, messages) => {
      sent.push(messages)
      return GOOD
    },
    isNoOutput: () => false,
    log: () => {},
  })

  await translate(CHUNK, [], undefined, {})
  assert.equal(sent.length, 1, '整块模型只该发一次')
  assert.ok(Array.isArray(sent[0]), '整块路径传的是 messages 数组')
})

test('逐句模型部分回退不判失败（漏掉的行留英文，其余照用）', async () => {
  const perLine = createFreeTierProvider({ model: 'index-mt-2b-syllable', url: () => 'u', label: 'x' })
  let n = 0
  const translate = createChunkTranslator({
    freeTierProvider: perLine,
    isFreeTierUsable: () => true,
    onFreeTierFailure: () => {},
    onFreeTierSuccess: () => {},
    isUnusable: () => false,
    markUnusable: () => {},
    callProvider: (p, text) => {
      n++
      // 第一行原样回显（模拟实测的 6.5% echo），其余正常
      return n === 1 ? text.replace(/^.*?\n\n/s, '') : '译文'
    },
    isNoOutput: () => false,
    log: () => {},
  })

  const r = await translate(CHUNK, [], undefined, {})
  assert.equal(r.fallback, 1, '只有回显那一行算回退')
  assert.equal(r.providerIds[0], perLine.id, '免费层仍然算产出方')
})
