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

const freeProvider = () => createFreeTierProvider({ model: 'Index-Translate-35B-A3B', url: () => 'https://free.invalid/v1', label: 'free' })
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

test('网关 provider 没有免费层专属字段（行为不许变）', () => {
  const gw = createGatewayProvider({ model: 'm', url: () => 'u', key: () => 'k', label: 'x' })
  assert.equal(gw.maxAttempts, undefined, '网关仍走 MAX_RETRIES')
  assert.equal(gw.requestTimeoutMs, undefined, '网关不加单请求超时')
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
})

test('fallbackThreshold：60 行分块阈值为 6', () => {
  assert.equal(fallbackThreshold(60), 6)
  assert.equal(fallbackThreshold(3), 1)
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
