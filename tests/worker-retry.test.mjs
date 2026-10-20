#!/usr/bin/env node
/**
 * 问题 C：失败条目自动进入重试，但要有次数上限。
 *
 * 规则（本文件是唯一权威描述）：
 * - 默认选中「待翻译」+「失败且未达上限」的条目 → 失败项自动重试；
 * - 达到 `MAX_AUTO_RETRIES`（3）后不再自动选中，页面显示「需人工介入」；
 * - 管理区手动勾「重试失败的光影」时**无视次数上限**（用户明确要求）；
 * - 「翻译中」永不入选：可能真有 workflow 在跑，重复触发会并发烧预算。
 *
 * 重试次数以 Worker 队列（KV）为准，**不读 pipeline 回写的 `attempts`**：
 * pipeline 的 `entry.attempts` 来自目录条目，而目录里根本没有这个字段
 * （tests/pipeline-smoke 之外没有任何地方写它），所以那个计数实际恒为 1。
 *
 * 全部离线。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import worker, {
  selectTranslateTargets,
  AUTO_RETRY_LIMIT,
  retryState,
} from '../worker/index.js'
import { STATUS } from '../shared/tencent-docs.mjs'

const e = (id, status, extra = {}) => ({ id, status, ...extra })

test('默认上限是 3 次', () => {
  assert.equal(AUTO_RETRY_LIMIT, 3)
})

test('失败条目默认自动入选（改造前不会）', () => {
  const entries = [e('a', STATUS.PENDING), e('b', STATUS.FAILED)]
  assert.deepEqual(selectTranslateTargets(entries).map((x) => x.id), ['a', 'b'])
})

test('重试次数未达上限 → 自动入选；达到上限 → 不入选', () => {
  const entries = [
    e('never', STATUS.FAILED, { retryCount: 0 }),
    e('twice', STATUS.FAILED, { retryCount: 2 }),
    e('capped', STATUS.FAILED, { retryCount: 3 }),
    e('way-past', STATUS.FAILED, { retryCount: 99 }),
  ]
  assert.deepEqual(selectTranslateTargets(entries).map((x) => x.id), ['never', 'twice'])
})

test('缺 retryCount 视为 0（历史队列条目不因缺字段被永久跳过）', () => {
  const entries = [e('legacy', STATUS.FAILED)]
  assert.deepEqual(selectTranslateTargets(entries).map((x) => x.id), ['legacy'])
})

test('非法 retryCount（负数 / NaN / 字符串）按 0 处理，不炸', () => {
  const entries = [
    e('neg', STATUS.FAILED, { retryCount: -5 }),
    e('nan', STATUS.FAILED, { retryCount: Number.NaN }),
    e('str', STATUS.FAILED, { retryCount: 'x' }),
  ]
  assert.equal(selectTranslateTargets(entries).length, 3)
})

test('手动重试失败项：无视次数上限', () => {
  const entries = [
    e('capped', STATUS.FAILED, { retryCount: 3 }),
    e('way-past', STATUS.FAILED, { retryCount: 99 }),
  ]
  assert.deepEqual(
    selectTranslateTargets(entries, { retryFailed: true }).map((x) => x.id),
    ['capped', 'way-past'],
  )
})

test('翻译中永不入选，手动重试也不行', () => {
  const entries = [e('running', STATUS.TRANSLATING), e('running2', STATUS.TRANSLATING, { retryCount: 0 })]
  assert.deepEqual(selectTranslateTargets(entries), [])
  assert.deepEqual(selectTranslateTargets(entries, { retryFailed: true }), [])
})

test('已完成 / 镜像缺失不因「自动重试」入选', () => {
  const entries = [e('done', STATUS.DONE), e('mirror', STATUS.DONE_UNMIRRORED)]
  assert.deepEqual(selectTranslateTargets(entries), [])
  assert.deepEqual(selectTranslateTargets(entries, { retryFailed: true }), [])
})

test('向后兼容：只有待翻译时行为与改造前完全一致', () => {
  const entries = [e('a', STATUS.PENDING), e('b', STATUS.PENDING)]
  assert.deepEqual(selectTranslateTargets(entries), entries)
  assert.deepEqual(selectTranslateTargets(entries, { retryFailed: true }), entries)
  assert.deepEqual(selectTranslateTargets([]), [])
})

// ---------- 页面展示用的状态 ----------

test('retryState：失败且未达上限 → auto，并给出「已自动重试 N 次」', () => {
  assert.deepEqual(retryState(e('a', STATUS.FAILED, { retryCount: 1 })), {
    manual: false,
    retriedTimes: 1,
    autoRetry: true,
    canAutoRetry: true,
    label: '已自动重试 1 次',
  })
})

test('retryState：达到上限 → 需人工介入', () => {
  const s = retryState(e('a', STATUS.FAILED, { retryCount: 3 }))
  assert.equal(s.canAutoRetry, false)
  assert.equal(s.manual, true)
  assert.equal(s.label, '需人工介入')
})

test('retryState：非失败条目不参与自动重试（无重试次数时完全静默）', () => {
  for (const status of [STATUS.PENDING, STATUS.TRANSLATING, STATUS.DONE, STATUS.DONE_UNMIRRORED]) {
    assert.deepEqual(retryState(e('x', status)), {
      manual: false, retriedTimes: 0, autoRetry: false, canAutoRetry: false, label: '',
    })
  }
})

test('retryState：重试中的条目仍如实展示历史次数，但不参与自动重试', () => {
  assert.deepEqual(retryState(e('x', STATUS.TRANSLATING, { retryCount: 2 })), {
    manual: false, retriedTimes: 2, autoRetry: false, canAutoRetry: false, label: '已自动重试 2 次',
  })
})

// ---------- 装配：/translate 真的把失败项带上，并把计数 +1 ----------

function makeKV(seed) {
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

const baseEntry = (overrides) => ({
  id: 'x', name: 'X', url: 'https://modrinth.com/shader/x', platform: 'modrinth',
  source: '玩家请求', status: STATUS.PENDING, submittedAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z', attempts: 0, error: '', langPath: '',
  shaderVersion: '', quark: '', contact: '', note: '', ...overrides,
})

function makeEnv(entries) {
  const seed = { 'queue:index': JSON.stringify(entries.map((x) => x.id)) }
  for (const x of entries) seed[`queue:${x.id}`] = JSON.stringify(x)
  return {
    TRANSLATION_QUEUE: makeKV(seed),
    TRANSLATE_PASSPHRASE: 'pw',
    GITHUB_PAT: 'gh-pat',
    LLM_API_KEY: 'k',
    LLM_BASE_URL: 'https://gw.invalid/v1',
  }
}

function installFetch() {
  const dispatched = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/dispatches')) {
      dispatched.push(JSON.parse(opts.body))
      return new Response(null, { status: 200 })
    }
    throw new Error(`未预期请求：${url}`)
  }
  return { dispatched, restore: () => { globalThis.fetch = original } }
}

const postTranslate = (body, env) =>
  worker.fetch(new Request('https://w.test/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Passphrase': 'pw' },
    body: JSON.stringify(body),
  }), env)

const getQueue = async (env) => {
  const res = await worker.fetch(new Request('https://w.test/queue'), env)
  return (await res.json()).entries
}

test('端到端：失败项默认被派发，随后 retryCount +1', async () => {
  const env = makeEnv([
    baseEntry({ id: 'pending' }),
    baseEntry({ id: 'failed', status: STATUS.FAILED, retryCount: 1 }),
  ])
  const f = installFetch()
  try {
    const res = await postTranslate({}, env)
    assert.equal(res.status, 200)
    assert.deepEqual(f.dispatched[0].inputs.ids, 'pending,failed')
    const entries = await getQueue(env)
    assert.equal(entries.find((x) => x.id === 'failed').retryCount, 2, '派发后应 +1')
    // 待翻译条目不该凭空写入 retryCount（历史行为与字段形态保持不变）
    assert.equal(entries.find((x) => x.id === 'pending').retryCount, undefined, '待翻译不算重试')
  } finally {
    f.restore()
  }
})

test('端到端：达到上限的失败项默认不派发，响应里如实说明', async () => {
  const env = makeEnv([
    baseEntry({ id: 'capped', status: STATUS.FAILED, retryCount: AUTO_RETRY_LIMIT }),
  ])
  const f = installFetch()
  try {
    const res = await postTranslate({}, env)
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.triggered, false)
    assert.equal(f.dispatched.length, 0)
    assert.match(data.message, /需人工介入/)
    assert.equal(data.needsManual, 1)
  } finally {
    f.restore()
  }
})

test('端到端：手动 retryFailed 无视上限，且不增加「自动重试」计数以外的副作用', async () => {
  const env = makeEnv([
    baseEntry({ id: 'capped', status: STATUS.FAILED, retryCount: AUTO_RETRY_LIMIT }),
  ])
  const f = installFetch()
  try {
    const res = await postTranslate({ retryFailed: true }, env)
    assert.equal(res.status, 200)
    assert.deepEqual(f.dispatched[0].inputs.ids, 'capped')
    const data = await res.json()
    assert.equal(data.needsManual, 0, '手动强制重试时不应再报「需人工介入」')
    const entries = await getQueue(env)
    assert.equal(entries[0].retryCount, AUTO_RETRY_LIMIT + 1)
  } finally {
    f.restore()
  }
})

test('端到端：没有任何可派发项时 selected 为空但队列状态不变', async () => {
  const env = makeEnv([baseEntry({ id: 'done', status: STATUS.DONE })])
  const f = installFetch()
  try {
    const res = await postTranslate({}, env)
    const data = await res.json()
    assert.equal(data.triggered, false)
    const entries = await getQueue(env)
    assert.equal(entries[0].retryCount, undefined, '不该凭空写入 retryCount')
  } finally {
    f.restore()
  }
})

test('GET /queue：失败项带 retry 展示状态（页面只渲染，不自己算上限）', async () => {
  const env = makeEnv([
    baseEntry({ id: 'retried', status: STATUS.FAILED, retryCount: 2 }),
    baseEntry({ id: 'capped', status: STATUS.FAILED, retryCount: 3 }),
    baseEntry({ id: 'ok', status: STATUS.PENDING }),
  ])
  const entries = await getQueue(env)
  const byId = Object.fromEntries(entries.map((x) => [x.id, x]))
  assert.equal(byId.retried.retry.label, '已自动重试 2 次')
  assert.equal(byId.retried.retry.autoRetry, true)
  assert.equal(byId.capped.retry.label, '需人工介入')
  assert.equal(byId.capped.retry.manual, true)
  assert.equal(byId.ok.retry.label, '')
})
