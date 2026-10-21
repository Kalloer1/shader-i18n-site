#!/usr/bin/env node
/**
 * 问题 A：管理员在 /request 勾选的模型必须真正决定翻译路径。
 *
 * 免费层与网关是**两条独立的路径**：
 * - 免费层模型 → workflow input `freeTierModel` → 环境变量 `FREE_TIER_MODEL`；
 * - 网关模型   → workflow input `models` → 环境变量 `LLM_MODELS`。
 *
 * 改动前二者混在 `inputs.models` 里，免费层模型会被 `createProvider` 当成网关模型名
 * 去请求网关（`pipeline.mjs` 用 LLM_URL + LLM_KEY），必然失败。本文件锁住拆分逻辑，
 * 并用假 KV / 假 fetch 跑通 `/translate` 的完整装配（真正发给 GitHub 的 inputs）。
 *
 * 全部离线：不碰任何真实接口。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import worker, {
  splitModelSelection,
  FREE_TIER_CANDIDATES_FOR_TEST,
} from '../worker/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const GATEWAY = ['kilo/kilo-auto/free', 'kilo/poolside/laguna-s-2.1:free']
const FREE = ['index-mt-2b-syllable', 'index-mt-9b-syllable']

// ---------- 纯函数：拆分 ----------

describe('splitModelSelection：免费层与网关分成两组', () => {
  test('各自归位，顺序按管理员勾选顺序（列表顺序）', () => {
    const r = splitModelSelection(
      ['index-mt-9b-syllable', 'kilo/kilo-auto/free', 'index-mt-2b-syllable'],
      { gatewayModels: GATEWAY, freeTierModels: FREE },
    )
    assert.deepEqual(r.freeTier, ['index-mt-9b-syllable', 'index-mt-2b-syllable'])
    assert.deepEqual(r.gateway, ['kilo/kilo-auto/free'])
    assert.deepEqual(r.invalid, [])
  })

  test('多个免费层模型时取第一个（不按字母排序，按勾选顺序）', () => {
    const r = splitModelSelection(
      ['index-mt-9b-syllable', 'index-mt-2b-syllable'],
      { gatewayModels: GATEWAY, freeTierModels: FREE },
    )
    assert.equal(r.freeTierModel, 'index-mt-9b-syllable')
    assert.equal(r.freeTier.length, 2, '要保留完整列表，便于日志说出「勾了 N 个」')
  })

  test('全选网关 → freeTierModel 为空（= 不传，仓库默认兜底）', () => {
    const r = splitModelSelection(['kilo/kilo-auto/free'], { gatewayModels: GATEWAY, freeTierModels: FREE })
    assert.equal(r.freeTierModel, '')
    assert.deepEqual(r.freeTier, [])
    assert.deepEqual(r.gateway, ['kilo/kilo-auto/free'])
  })

  test('只选免费层 → gateway 为空（不把免费层模型塞进 LLM_MODELS）', () => {
    const r = splitModelSelection(['index-mt-9b-syllable'], { gatewayModels: GATEWAY, freeTierModels: FREE })
    assert.deepEqual(r.gateway, [], '绝不能把免费层模型当网关模型传下去')
    assert.equal(r.freeTierModel, 'index-mt-9b-syllable')
  })

  test('未知模型进 invalid（白名单校验的输入）', () => {
    const r = splitModelSelection(['nope/model', 'kilo/kilo-auto/free'], {
      gatewayModels: GATEWAY, freeTierModels: FREE,
    })
    assert.deepEqual(r.invalid, ['nope/model'])
    assert.deepEqual(r.gateway, ['kilo/kilo-auto/free'])
  })

  test('去重、去空白、忽略空串（避免 LLM_MODELS 出现重复提供方）', () => {
    const r = splitModelSelection(
      [' kilo/kilo-auto/free ', '', 'kilo/kilo-auto/free', null, 'index-mt-9b-syllable'],
      { gatewayModels: GATEWAY, freeTierModels: FREE },
    )
    assert.deepEqual(r.gateway, ['kilo/kilo-auto/free'])
    assert.deepEqual(r.freeTier, ['index-mt-9b-syllable'])
  })

  test('向后兼容：候选为空 → 两组都空（不传任何 models 的路径）', () => {
    for (const input of [[], undefined, null]) {
      const r = splitModelSelection(input, { gatewayModels: GATEWAY, freeTierModels: FREE })
      assert.deepEqual(r, { gateway: [], freeTier: [], freeTierModel: '', invalid: [] })
    }
  })

  test('同名同时在两组时按网关处理（分组信息已丢失，网关优先保持旧行为）', () => {
    const r = splitModelSelection(['shared-model'], { gatewayModels: ['shared-model'], freeTierModels: ['shared-model'] })
    assert.deepEqual(r.gateway, ['shared-model'])
    assert.deepEqual(r.freeTier, [])
  })
})

// ---------- 装配：/translate 真正发给 GitHub 的 inputs ----------

/** 最小 KV 桩：get/put/delete，支持 'json' 类型。 */
function makeKV(seed = {}) {
  const store = new Map(Object.entries(seed))
  return {
    async get(key, type) {
      if (!store.has(key)) return null
      const raw = store.get(key)
      return type === 'json' ? JSON.parse(raw) : raw
    },
    async put(key, value) { store.set(key, value) },
    async delete(key) { store.delete(key) },
    dump: () => Object.fromEntries(store),
  }
}

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const entry = (overrides) => ({
  id: 'bsl-shaders',
  name: 'BSL Shaders',
  url: 'https://modrinth.com/shader/bsl-shaders',
  platform: 'modrinth',
  source: '玩家请求',
  status: '待翻译',
  submittedAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z',
  attempts: 0,
  error: '',
  langPath: '',
  shaderVersion: '',
  quark: '',
  contact: '',
  note: '',
  ...overrides,
})

const seedQueue = (entries) => {
  const seed = { 'queue:index': JSON.stringify(entries.map((e) => e.id)) }
  for (const e of entries) seed[`queue:${e.id}`] = JSON.stringify(e)
  return seed
}

/** 造一份假环境：网关 /models 与免费层探测都走假 fetch。 */
function makeEnv(seedEntries = []) {
  return {
    TRANSLATION_QUEUE: makeKV(seedQueue(seedEntries)),
    TRANSLATE_PASSPHRASE: 'pw',
    GITHUB_PAT: 'gh-pat',
    LLM_API_KEY: 'gw-key',
    LLM_BASE_URL: 'https://gw.invalid/v1',
    FREE_TIER_BASE_URL: 'https://free.invalid',
  }
}

/**
 * 假 fetch：记录全部调用，按 URL 回话。
 * 免费层探测只让 syllable 两兄弟存活（与 2026-10-20 实测一致）。
 */
function installFetch({ freeAlive = ['index-mt-2b-syllable', 'index-mt-9b-syllable'] } = {}) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url)
    calls.push({ url: u, opts })
    if (u === 'https://gw.invalid/v1/models') {
      return jsonRes({ data: GATEWAY.map((id) => ({ id })) })
    }
    if (u.startsWith('https://free.invalid/v1/chat/completions')) {
      const body = JSON.parse(opts.body)
      const alive = freeAlive.includes(body.model)
      return jsonRes({ choices: [{ message: { content: alive ? '阴影强度' : '' } }] })
    }
    if (u.includes('api.github.com') && u.endsWith('/dispatches')) {
      return new Response(null, { status: 200 })
    }
    throw new Error(`测试里出现未预期的请求：${u}`)
  }
  return {
    calls,
    dispatchCalls: () => calls.filter((c) => c.url.includes('api.github.com')),
    restore: () => { globalThis.fetch = original },
  }
}

const postTranslate = (body, env) =>
  worker.fetch(
    new Request('https://worker.test/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Passphrase': 'pw' },
      body: JSON.stringify(body),
    }),
    env,
  )

/** 从 dispatch 请求里取出 workflow inputs。 */
function dispatchedInputs(calls) {
  const dispatch = calls.filter((c) => c.url.includes('api.github.com'))
  assert.equal(dispatch.length, 1, '应恰好派发一次 workflow')
  return JSON.parse(dispatch[0].opts.body).inputs
}

test('勾选 2 个免费层 + 1 个网关：免费层取第一个，网关单独走 models', async () => {
  const env = makeEnv([entry({ id: 'bsl-shaders' })])
  const f = installFetch()
  try {
    const res = await postTranslate(
      { models: ['index-mt-9b-syllable', 'kilo/kilo-auto/free', 'index-mt-2b-syllable'] },
      env,
    )
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.success, true)
    assert.equal(data.freeTierModel, 'index-mt-9b-syllable')
    assert.equal(data.freeTierSelectedCount, 2)

    const inputs = dispatchedInputs(f.calls)
    assert.equal(inputs.models, 'kilo/kilo-auto/free', 'LLM_MODELS 只该有网关模型')
    assert.equal(inputs.freeTierModel, 'index-mt-9b-syllable', '免费层走独立 input')
    assert.ok(!inputs.models.includes('index-mt'), '免费层模型绝不能混进 models')
  } finally {
    f.restore()
  }
})

test('只勾免费层：不传 models（网关回到仓库默认），freeTierModel 正确', async () => {
  const env = makeEnv([entry({ id: 'bsl-shaders' })])
  const f = installFetch()
  try {
    const res = await postTranslate({ models: ['index-mt-2b-syllable'] }, env)
    assert.equal(res.status, 200)
    const inputs = dispatchedInputs(f.calls)
    assert.equal(inputs.models, undefined, '不传 models，交给 translate.yml 的默认值')
    assert.equal(inputs.freeTierModel, 'index-mt-2b-syllable')
  } finally {
    f.restore()
  }
})

test('不传 models（向后兼容）：两个 input 都不传，行为与改造前一致', async () => {
  const env = makeEnv([entry({ id: 'bsl-shaders' })])
  const f = installFetch()
  try {
    const res = await postTranslate({}, env)
    assert.equal(res.status, 200)
    const inputs = dispatchedInputs(f.calls)
    assert.equal(inputs.models, undefined)
    assert.equal(inputs.freeTierModel, undefined)
    assert.equal(inputs.ids, 'bsl-shaders')
  } finally {
    f.restore()
  }
})

test('只勾网关模型：不传 freeTierModel（免费层仍按仓库默认开启）', async () => {
  const env = makeEnv([entry({ id: 'bsl-shaders' })])
  const f = installFetch()
  try {
    const res = await postTranslate({ models: ['kilo/kilo-auto/free'] }, env)
    assert.equal(res.status, 200)
    const inputs = dispatchedInputs(f.calls)
    assert.equal(inputs.models, 'kilo/kilo-auto/free')
    assert.equal(inputs.freeTierModel, undefined, '没勾 ≠ 关掉：交给 FREE_TIER_MODEL 默认值')
  } finally {
    f.restore()
  }
})

test('未知模型仍 400 拒绝，且不派发 workflow', async () => {
  const env = makeEnv([entry({ id: 'bsl-shaders' })])
  const f = installFetch()
  try {
    const res = await postTranslate({ models: ['index-mt-9b-syllable', 'evil/model'] }, env)
    assert.equal(res.status, 400)
    const data = await res.json()
    assert.match(data.error, /evil\/model/)
    assert.equal(f.dispatchCalls().length, 0)
  } finally {
    f.restore()
  }
})

test('免费层探测全挂时，免费层模型不可选（宁可 400 也不透传必挂模型）', async () => {
  const env = makeEnv([entry({ id: 'bsl-shaders' })])
  const f = installFetch({ freeAlive: [] })
  try {
    const res = await postTranslate({ models: ['index-mt-9b-syllable'] }, env)
    assert.equal(res.status, 400)
    assert.equal(f.dispatchCalls().length, 0)
  } finally {
    f.restore()
  }
})

test('声明一个 free-then-gateway 的 workflow input（Worker 与 translate.yml 的契约）', () => {
  const yml = readFileSync(join(ROOT, '.github', 'workflows', 'translate.yml'), 'utf8')
  assert.match(yml, /^\s{6}freeTierModel:/m, 'translate.yml 必须声明 freeTierModel input')
  assert.match(yml, /^\s{6}freeTierModels:/m, 'translate.yml 必须声明 freeTierModels（多模型池）input')
  assert.match(yml, /^\s{6}gateway:/m, 'translate.yml 必须声明 gateway（网关开关）input')

  // ⚠️ 2026-10-21 契约变更：FREE_TIER_MODEL **不再兜硬编码默认值**。
  // 旧写法 `|| 'index-mt-9b-syllable'` 会把默认多模型池收窄成单模型，
  // 于是 pipeline 的 DEFAULT_FREE_TIER_MODELS（5 模型池）永远不生效。
  // 优先级收紧为 inputs > secrets > pipeline 默认池。
  assert.match(
    yml,
    /FREE_TIER_MODEL:\s*\$\{\{\s*inputs\.freeTierModel\s*\|\|\s*secrets\.FREE_TIER_MODEL\s*\}\}/,
    'FREE_TIER_MODEL 优先级必须是 inputs > secrets > pipeline 默认（不得再硬编码单模型默认）',
  )
  assert.match(
    yml,
    /FREE_TIER_MODELS:\s*\$\{\{\s*inputs\.freeTierModels\s*\|\|\s*secrets\.FREE_TIER_MODELS\s*\}\}/,
    'FREE_TIER_MODELS 必须能覆盖整个池子',
  )
  // 网关开关：false → '0'；不传（默认 true）→ '1'，与既有行为一致。
  assert.match(yml, /GATEWAY_ENABLED:\s*\$\{\{\s*inputs\.gateway\s*==\s*false\s*&&\s*'0'\s*\|\|\s*'1'\s*\}\}/,
    'GATEWAY_ENABLED 必须由 inputs.gateway 派生，且缺省为开启')
  assert.match(yml, /FREE_TIER_ENABLED:\s*\$\{\{\s*secrets\.FREE_TIER_ENABLED\s*\|\|\s*'1'\s*\}\}/,
    'FREE_TIER_ENABLED=0 必须仍能关掉免费层（优先级最高）')

  // 两处 env（Show selected models + Translate）必须一致，否则日志会骗人。
  const nModel = (yml.match(/^\s+FREE_TIER_MODEL:\s*\$\{\{/gm) ?? []).length
  const nModels = (yml.match(/^\s+FREE_TIER_MODELS:\s*\$\{\{/gm) ?? []).length
  const nGateway = (yml.match(/^\s+GATEWAY_ENABLED:\s*\$\{\{/gm) ?? []).length
  assert.equal(nModel, 2, 'FREE_TIER_MODEL 应在展示步与翻译步各出现一次')
  assert.equal(nModels, 2, 'FREE_TIER_MODELS 应在展示步与翻译步各出现一次')
  assert.equal(nGateway, 2, 'GATEWAY_ENABLED 应在展示步与翻译步各出现一次')

  // 硬编码默认值若再回来，池子就被悄悄收窄了 —— 直接判红。
  assert.ok(!/FREE_TIER_MODELS:[^\n]*index-mt-/.test(yml),
    'FREE_TIER_MODELS 不得在 workflow 里写死默认池（交给 pipeline.mjs）')
  assert.ok(!/FREE_TIER_MODEL:[^\n]*\|\|\s*'index-mt-/.test(yml),
    'FREE_TIER_MODEL 不得再兜单模型硬编码默认值')
})

test('Worker 源码里 freeTierModel 只作为独立 input 传递', () => {
  const src = readFileSync(join(ROOT, 'worker', 'index.js'), 'utf8')
  assert.match(src, /inputs\.freeTierModel\s*=\s*freeTierModelInput/)
  assert.match(src, /inputs\.models\s*=\s*modelsInput/)
})

// 供上方的契约测试确认探测候选表没被悄悄改空（探测依赖真实候选）。
test('免费层探测候选表非空且含两个 syllable 模型', () => {
  assert.ok(FREE_TIER_CANDIDATES_FOR_TEST.length > 0)
  assert.ok(FREE_TIER_CANDIDATES_FOR_TEST.includes('index-mt-9b-syllable'))
})
