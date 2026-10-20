#!/usr/bin/env node
/**
 * 自动汉化流水线（ADR-0005）：下载 → 检测自带中文 → LLM 初翻 → 校验 → 登记。
 *
 * 候选：目录中按下载量排序、未被流水线覆盖且不在缺少英文源清单中的光影（无汉化映射、未检出自带中文）。
 * 翻译默认走两层：免费层（无 SLA 的公开服务）优先，失败或产出不合格才落到模型池回退。
 * 回退池按分块轮转调用；失败或回退过高时自动尝试下一个模型。
 * LLM_CONCURRENCY 控制光影级并发（每条光影仍各自独立超时、独立中断）。
 * LLM_CHUNK_CONCURRENCY 控制单条光影内部的分块并发（只提交 1 条时也能用上闲置并发）。
 * 某个模型在首块一行译文都产不出时立即弃用该模型（见 scripts/lib/llm-guard.mjs），
 * 全部模型都被弃用则整条立刻判失败，不再空烧预算。
 *
 * LLM 提供方：环境变量配置，默认指向自建中转站（OpenAI 兼容）。
 *   LLM_BASE_URL    接口地址；优先级 LLM_BASE_URL > SILICONFLOW_BASE_URL（旧名别名） > 默认中转站
 *   LLM_API_KEY     API key；缺省回退 SILICONFLOW_API_KEY（旧名别名）
 *   LLM_MODELS      模型名列表（逗号分隔）；优先于 LLM_MODEL
 *   LLM_MODEL       兼容单模型配置，也接受逗号分隔列表
 *   LLM_CONCURRENCY 并发度；默认 10
 *   LLM_CHUNK_CONCURRENCY 单条光影内的分块并发度；默认 3，上限 4
 *   LLM_EXTRA_BODY  额外请求体（JSON 字符串，浅合并进 body，用于透传中转站参数）
 *
 * 免费层（默认开启的**主路**，独立于 LLM_MODELS）：
 *   FREE_TIER_ENABLED   0/false/no/off 时关闭；缺省开启
 *   FREE_TIER_BASE_URL  默认 bilibili Index-Translate 公开 API；给到 /v1 会自动补 /chat/completions
 *   FREE_TIER_MODEL     默认 Index-Translate-35B-A3B
 * 它是无 SLA 的公开服务，失败快速降级到回退池（单次尝试、无退避、60 秒超时；
 * 连续 2 次失败才熔断）。**刻意不参与 LLM_MODELS**：否则站点管理员一勾模型
 * 就会静默关掉免费层，而界面上完全看不出来。
 *
 * 没有 LLM_API_KEY 时不再硬失败：回退池留空，以「免费层单跑」模式运行。
 * （这有意打破了「不设任何 LLM_* 环境变量时行为逐字一致」的原不变量，见 README 决策摘要。）
 * 不设任何 LLM_* 环境变量且免费层开启时，启动输出与改造前的差异仅限免费层那两行。
 * 密钥通过环境变量读取，不入库；接口使用 OpenAI 兼容 chat/completions。
 *
 * 用法：
 *   node scripts/pipeline.mjs [--top 50]     按候选顺序处理前 N 个（行为与改造前完全一致）
 *   node scripts/pipeline.mjs --ids a,b,c    只处理指定 shaderId（站点 /translate 触发的路径）
 *
 * --ids 与 --top 互斥；同时给出时以 --ids 为准并打印警告。
 * 每条光影独立 5 分钟超时，并各自持有独立的 AbortController/signal
 * （并发下超时只中断这一条的进行中 fetch，不会波及其他条目）；
 * 超时或抛错只影响该条，不阻断整批。
 * 设置 WORKER_URL + INTERNAL_STATUS_TOKEN 时，每条结束即回写 KV 状态（尽力而为）。
 */
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { STATUS } from '../shared/tencent-docs.mjs'
import { validatePair, repairMalformedSections } from './validate-lang.mjs'
import { isEnUsLangPath, isLangFilePath, isZhCNLangPath } from './lib/lang-source.mjs'
import { cfGetFiles, cfGetDownloadUrl, cfFindBySlug, cfGetMod } from './lib/cf-api.mjs'
import { cfVersionFromFileName, buildShaderEntry, isCurseforgeEntry } from './lib/cf.mjs'
import { buildTitleIndex, findTranslatedTwin } from './lib/cross-platform.mjs'
import { EmptyResponseError, isProviderNoOutput, providerUnusableMessage } from './lib/llm-guard.mjs'
// 骨架提取与记忆读写守卫见 scripts/lib/glossary.mjs（与 scripts/rebuild-glossary.mjs 共用同一实现）。
// 本文件不再直接使用它们：记忆/进度/LLM 的编排在 lib/translate-entries.mjs，进度判据在 lib/resume-progress.mjs。
import {
  progressRelativePath,
  parseProgress,
  serializeProgress,
  pruneProgress,
  progressSummary,
} from './lib/resume-progress.mjs'
import { readFileQuietly, writeFileAtomic, removeFileQuietly } from './lib/atomic-file.mjs'
import { renderZhLang } from './lib/lang-render.mjs'
import { createTranslateEntries } from './lib/translate-entries.mjs'
import { runPool, DEFAULT_CHUNK_CONCURRENCY, MAX_CHUNK_CONCURRENCY } from './lib/pool.mjs'
// 提示词与请求体形状是 **provider 的属性**，不是模块级常量：免费层要走官方 instTrans 形态、
// 且不继承 LLM_EXTRA_BODY。抽象在 lib 里，超时/重试/熔断仍留在本文件（那是流水线策略）。
import { createGatewayProvider, createFreeTierProvider, buildContributorLine } from './lib/providers.mjs'
import {
  parseLangLines as parseLangLinesLib,
  createChunkTranslator,
} from './lib/provider-chain.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG_FILE = join(ROOT, 'site/data/modrinth-catalog.json')
const CF_CATALOG_FILE = join(ROOT, 'site/data/curseforge-catalog.json')
const SHADERS_FILE = join(ROOT, 'site/data/shaders.json')
const GLOSSARY_FILE = join(ROOT, 'site/data/glossary.json')
const LANG_DIR = join(ROOT, 'site/public/lang')
const SOURCES_DIR = join(ROOT, 'sources')
const MODRINTH_API = 'https://api.modrinth.com/v2'
const CHUNK_LINES = 60
// 2026-10-20：旧的 opencode-zen-free/* 三个模型已从网关下架，换成实测可用的两个。
// 与 .github/workflows/translate.yml 的 LLM_MODELS 默认值保持一致（本地运行走这里）。
const DEFAULT_MODEL = 'kilo/kilo-auto/free'
const DEFAULT_CONCURRENCY = 10
const DEFAULT_BASE_URL = 'https://api.888424.xyz/v1/chat/completions'
// 免费层（bilibili Index-Translate 公开 API）：**无需 API key**，无 SLA。
// 它是流水线的默认主路，失败才落到上面的网关回退池。
const DEFAULT_FREE_TIER_URL = 'https://index-translate.bilibili.com/v1/chat/completions'
const DEFAULT_FREE_TIER_MODEL = 'Index-Translate-35B-A3B'
// 免费层连续失败多少次才标记「本轮不可用」。单次抖动只降级当前分块，不熔断。
const FREE_TIER_FAILURE_THRESHOLD = 2
const MAX_RETRIES = 10
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 可被中断的等待：signal abort 后立刻结束，不再把退避时间睡满（否则超时之后还会白等）。
function sleepAbortable(ms, signal) {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => { cleanup(); resolve() }
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// 每条光影的处理上限：防止单个卡死的下载/LLM 调用拖垮整批（在 CI 里就是整个 workflow 超时）。
const PER_SHADER_TIMEOUT_MS = (() => {
  const raw = Number(process.env.LLM_PER_SHADER_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60 * 1000
})()

// CurseForge 分支的两层上限（外层仍有 PER_SHADER_TIMEOUT_MS 兜底）：
// 单个候选文件最多 3 分钟，整条 CF 光影最多 6 分钟——
// 避免「候选数 × 各自超时」叠加成长时间占用（曾经一个 CF 光影把 CI 卡住 8 小时）。
const CF_CANDIDATE_TIMEOUT_MS = 3 * 60 * 1000
const CF_SHADER_BUDGET_MS = 6 * 60 * 1000
// 状态回写目标（Worker 的 /status）。两者缺一即静默跳过，不影响本地手动运行。
const WORKER_URL = process.env.WORKER_URL
const INTERNAL_STATUS_TOKEN = process.env.INTERNAL_STATUS_TOKEN

/**
 * 回写单条状态到 KV（经 Worker /status）。
 * 尽力而为：未配置、网络失败、Worker 未部署都只打日志，绝不影响翻译主流程。
 */
async function reportStatus(id, payload) {
  if (!WORKER_URL || !INTERNAL_STATUS_TOKEN) return
  try {
    const res = await fetch(`${WORKER_URL.replace(/\/+$/, '')}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_STATUS_TOKEN },
      body: JSON.stringify({ id, ...payload }),
    })
    if (!res.ok) console.log(`  [status] 回写失败 HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`)
  } catch (err) {
    console.log(`  [status] 回写异常: ${err.message.slice(0, 120)}`)
  }
}

// 所有网络请求都走 mfetch：中断信号由调用方显式传入（每条光影自己的 signal）。
// 不再读模块级全局信号——并发下那样会让一条的超时打断其他条的请求。
function mfetch(url, { signal, ...opts } = {}) {
  return fetch(url, { ...opts, signal })
}

// ---------- LLM 提供方（环境变量可配，默认与改造前一致） ----------
// 空字符串视为未设置，避免 `LLM_MODEL=` 之类把配置抹成空值。
function envStr(name) {
  const v = process.env[name]
  return v === undefined || v.trim() === '' ? undefined : v
}

function parseModels() {
  const raw = envStr('LLM_MODELS') ?? envStr('LLM_MODEL')
  if (raw === undefined) return [DEFAULT_MODEL]
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

const LLM_MODELS = parseModels()
if (!LLM_MODELS.length) {
  console.error('LLM_MODELS / LLM_MODEL 不能为空')
  process.exit(2)
}
const LLM_URL = () => envStr('LLM_BASE_URL') ?? envStr('SILICONFLOW_BASE_URL') ?? DEFAULT_BASE_URL
const LLM_KEY = () => envStr('LLM_API_KEY') ?? envStr('SILICONFLOW_API_KEY')

// ---------- 免费层（独立配置，**不参与 LLM_MODELS**） ----------
// 为什么必须隔离：站点管理员在 /request 页勾选的是**回退池**。若免费层也走 LLM_MODELS，
// 管理员一勾模型就会静默关掉免费层（默认主路），而界面上完全看不出来。
function freeTierEnabled() {
  const raw = envStr('FREE_TIER_ENABLED')
  if (raw === undefined) return true // 默认开启
  return !/^(0|false|no|off)$/i.test(raw.trim())
}

/** 免费层地址：允许只给到 `/v1`（README 里的写法），自动补 `/chat/completions`。 */
function freeTierUrl() {
  const raw = envStr('FREE_TIER_BASE_URL') ?? DEFAULT_FREE_TIER_URL
  return /\/chat\/completions$/.test(raw) ? raw : `${raw.replace(/\/+$/, '')}/chat/completions`
}
const FREE_TIER_MODEL = () => envStr('FREE_TIER_MODEL') ?? DEFAULT_FREE_TIER_MODEL
const FREE_TIER_ON = freeTierEnabled()

// 仅当「提供方本身」被改写（换模型/换地址）时按自定义提供方呈现；
// 只设 LLM_CONCURRENCY / LLM_API_KEY 时不改打印，保持与改造前一致的字面输出。
const LLM_ENV_SET = envStr('LLM_MODELS') !== undefined
  || envStr('LLM_MODEL') !== undefined
  || envStr('LLM_BASE_URL') !== undefined
  || envStr('LLM_API_KEY') !== undefined

// 额外请求体：浅合并进 body，透传中转站的额外参数（如 enable_thinking）。
let LLM_EXTRA_BODY = {}
const rawExtraBody = envStr('LLM_EXTRA_BODY')
if (rawExtraBody !== undefined) {
  try {
    const parsed = JSON.parse(rawExtraBody)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('必须是 JSON 对象')
    LLM_EXTRA_BODY = parsed
  } catch (err) {
    console.error(`LLM_EXTRA_BODY 不是合法的 JSON 对象：${err.message}`)
    process.exit(2)
  }
}

// 并发度：默认 10；非法值回退为默认值。
function readConcurrency() {
  const raw = envStr('LLM_CONCURRENCY')
  if (raw === undefined) return DEFAULT_CONCURRENCY
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    console.error(`LLM_CONCURRENCY 无效（${raw}），回退为 ${DEFAULT_CONCURRENCY}`)
    return DEFAULT_CONCURRENCY
  }
  return n
}
const LLM_CONCURRENCY = readConcurrency()

// 分块并发度：默认 3，上限 4；非法值回退为默认值。
function readChunkConcurrency() {
  const raw = envStr('LLM_CHUNK_CONCURRENCY')
  if (raw === undefined) return DEFAULT_CHUNK_CONCURRENCY
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    console.error(`LLM_CHUNK_CONCURRENCY 无效（${raw}），回退为 ${DEFAULT_CHUNK_CONCURRENCY}`)
    return DEFAULT_CHUNK_CONCURRENCY
  }
  if (n > MAX_CHUNK_CONCURRENCY) {
    console.log(`LLM_CHUNK_CONCURRENCY=${n} 超过上限 ${MAX_CHUNK_CONCURRENCY}（网关账号级并发限制），按 ${MAX_CHUNK_CONCURRENCY} 使用\n`)
    return MAX_CHUNK_CONCURRENCY
  }
  return n
}
const LLM_CHUNK_CONCURRENCY = readChunkConcurrency()

// 本轮已被判定「产不出译文」的模型 id。跨光影共享：坏模型不重复烧预算。
const unusableProviders = new Set()

/**
 * 给定模型列表是否全部已被判定不可用。
 *
 * **空列表算「不可用」**（issue #4）：回退池为空是「免费层单跑」模式的合法状态，
 * 不是「没问题」。若这里返回 false，`everythingUnusable()` 就永远为 false，
 * 免费层也挂掉时整轮会静默「成功但零产出」。
 */
function allProvidersUnusable(list = providers) {
  return list.length === 0 || list.every((p) => unusableProviders.has(p.id))
}

function providerHostLabel(url) {
  try { return new URL(url).host } catch { return url }
}

function createProvider(model) {
  const isDefault = !LLM_ENV_SET && model === DEFAULT_MODEL
  return createGatewayProvider({
    model,
    url: LLM_URL,
    key: LLM_KEY,
    extraBody: LLM_EXTRA_BODY,
    label: isDefault ? `space-bunny-free（${providerHostLabel(DEFAULT_BASE_URL)}）` : `${model}（${providerHostLabel(LLM_URL())}）`,
  })
}

// 无 key 时回退池**真的为空**：不能留一个必 401 的 provider 列表，否则每个分块都要先撞一次
// 401 才落回免费层（浪费预算且日志噪声）。有 key 时行为与改造前一致。
const providers = LLM_KEY() ? LLM_MODELS.map(createProvider) : []
const provider = providers[0]
let providerCursor = 0

function nextProviderOrder(list = providers) {
  if (list.length === 0) return list
  const start = providerCursor++ % list.length
  return [...list.slice(start), ...list.slice(0, start)]
}

// ---------- 免费层实例与熔断状态 ----------
// 逐句模型（syllable）的并发度：本机实测 32 是拐点，CI 出口未验证故默认 16。
function readFreeTierConcurrency() {
  const raw = envStr('FREE_TIER_CONCURRENCY')
  if (raw === undefined) return undefined // 交给 provider 的默认值
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) {
    console.error(`FREE_TIER_CONCURRENCY 无效（${raw}），使用默认值`)
    return undefined
  }
  return Math.min(Math.floor(n), 64) // 64 是实测吞吐已开始下降的上限，再高只是排队
}

const freeTierProvider = createFreeTierProvider({
  model: FREE_TIER_MODEL(),
  url: freeTierUrl,
  label: `${FREE_TIER_MODEL()}（${providerHostLabel(freeTierUrl())}）`,
  lineConcurrency: readFreeTierConcurrency(),
})

// 免费层连续失败计数。达 FREE_TIER_FAILURE_THRESHOLD 才熔断（单次抖动只降级当前分块）。
let freeTierConsecutiveFailures = 0
let freeTierDisabledReason = ''

function freeTierUsable() {
  return FREE_TIER_ON && !unusableProviders.has(freeTierProvider.id)
}

/**
 * 记一次免费层失败。**连续**两次才熔断：单次超时/5xx 是公开服务的正常抖动，
 * 把它当成「服务挂了」会让免费层抖一下就整轮不用它。
 */
function noteFreeTierFailure() {
  freeTierConsecutiveFailures++
  if (freeTierConsecutiveFailures >= FREE_TIER_FAILURE_THRESHOLD && !unusableProviders.has(freeTierProvider.id)) {
    unusableProviders.add(freeTierProvider.id)
    freeTierDisabledReason = `连续 ${freeTierConsecutiveFailures} 次失败`
    console.log(`  [免费层] ${freeTierDisabledReason}，本轮不再尝试免费层，全部走回退池`)
  }
}

function noteFreeTierSuccess() {
  freeTierConsecutiveFailures = 0
}

// 署名行是纯函数，放在 lib 里（pipeline.mjs 无法被单测 import：它顶层就会跑整个流水线）。
const contributorLine = (providerIds) => buildContributorLine(providerIds, freeTierProvider.id)

// 没有网关 key 时不再硬失败：免费层不需要 key，回退池留空，以「免费层单跑」模式运行（issue #4）。
// ⚠️ 这**有意打破**了一条原不变量（「不设任何 LLM_* 环境变量时行为与改造前逐字一致」）——
// 用户已于 2026-10-17 明确点头，此处记录在案。
// 但免费层也被显式关掉时（FREE_TIER_ENABLED=0）确实没有任何可用提供方，仍保持原有的硬失败。
const LLM_KEY_MISSING = !LLM_KEY()
if (LLM_KEY_MISSING) {
  if (!FREE_TIER_ON) {
    if (LLM_ENV_SET) {
      console.error('缺少 API key：请设置 LLM_API_KEY（或别名 SILICONFLOW_API_KEY），默认站点 ' + providerHostLabel(DEFAULT_BASE_URL))
    } else {
      console.error('缺少 API key：请设置 LLM_API_KEY（或别名 SILICONFLOW_API_KEY）')
    }
    console.error('且免费层已通过 FREE_TIER_ENABLED 关闭，没有任何可用提供方')
    process.exit(2)
  }
  console.warn('警告：未设置 LLM_API_KEY（或别名 SILICONFLOW_API_KEY），回退池为空，将以「免费层单跑」模式运行\n')
}
const providerLabel = providers.length === 0
  ? '（无，回退池为空）'
  : providers.length === 1 && !LLM_ENV_SET
    ? `${provider.name}（${provider.body([]).model}）`
    : providers.map((p) => `${p.name}（${p.body([]).model}）`).join(' / ')
console.log(`LLM 提供方：${providerLabel}\n`)
// 免费层是**独立于 LLM_MODELS** 的一层，因此单独打印。
if (FREE_TIER_ON) {
  console.log(`免费层（优先）：${freeTierProvider.name}\n`)
} else {
  console.log('免费层（优先）：已通过 FREE_TIER_ENABLED 关闭\n')
}
// 仅在显式配置时打印，保证「不设环境变量」时的输出与改造前逐字一致。
if (envStr('LLM_CONCURRENCY') !== undefined) console.log(`LLM 并发度：${LLM_CONCURRENCY}\n`)
if (envStr('LLM_CHUNK_CONCURRENCY') !== undefined) console.log(`LLM 分块并发度：${LLM_CHUNK_CONCURRENCY}\n`)

async function chatOnce(activeProvider, messages, signal) {
  const key = activeProvider.key()
  // 免费层无需鉴权：不能发 `Bearer undefined`（实测免费层忽略该头，但发出去是脏请求）。
  const headers = { 'Content-Type': 'application/json' }
  if (key) headers.Authorization = `Bearer ${key}`
  // 免费层自带 60 秒超时，与调用方传入的 signal 合并：任一触发即中止。
  const timeoutMs = activeProvider.requestTimeoutMs
  const reqSignal = timeoutMs ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)) : signal
  const res = await mfetch(activeProvider.url(), {
    method: 'POST',
    headers,
    body: JSON.stringify(activeProvider.body(messages)),
    signal: reqSignal,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const j = await res.json()
  const text = activeProvider.extract(j)
  // 空正文（含纯空白）是模型的稳定行为，不是网络抖动，用专门错误类型区分。
  if (!text || text.trim() === '') throw new EmptyResponseError()
  return text
}

/**
 * 带退避重试的调用。重试次数是 **provider 的属性**：
 * - 网关（默认 10 次，与原实现一致）；
 * - 免费层 `maxAttempts: 1` —— 单次尝试、无退避（见 issue #3：不让无 SLA 的公开服务
 *   把每条光影的 15 分钟预算烧光，失败就交给回退池）。
 */
async function chatWithRetry(activeProvider, messages, signal) {
  const maxAttempts = activeProvider.maxAttempts ?? MAX_RETRIES
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await chatOnce(activeProvider, messages, signal)
    } catch (err) {
      if (attempt === maxAttempts) throw err
      // 正文为空：重试同一个模型只会拿到同样的空正文（推理模型把内容写在 reasoning_content），
      // 原实现的退避重试会把预算烧在必然失败的重试上，这里直接抛出交给 translateChunk 判定。
      if (err instanceof EmptyResponseError) throw err
      // 本条已超时中断：立即结束，不再退避重试（否则会留下挂到超时之后的孤儿重试）
      if (signal?.aborted) throw err
      const delay = 2000 * 2 ** (attempt - 1)
      await sleepAbortable(delay, signal)
    }
  }
}

// ---------- 翻译记忆（glossary.json） ----------
let glossary = {}
try {
  glossary = JSON.parse(readFileSync(GLOSSARY_FILE, 'utf8'))
  console.log(`翻译记忆加载：${Object.keys(glossary).length} 条\n`)
} catch {
  console.log('翻译记忆不存在，将从头构建\n')
}

// 骨架提取与记忆读写守卫见 scripts/lib/glossary.mjs（与 scripts/rebuild-glossary.mjs 共用同一实现）。

// ---------- 断点续翻进度文件 ----------
// 放 sources/<id>/<version>/.progress.json，理由：
// 1. 它按「光影 + 版本」严格隔离，与 sources/ 里 en_US.lang 的目录结构天然对应；
// 2. sources/ 已被 .gitignore 排除，进度是**中间态**，不该进仓库（进度全成功后会删掉，
//    但进程被杀时留下的那份也不该污染 git status）；
// 3. 不放进 site/public/lang/<id>/<version>/：那是**站点静态产物目录**，构建会原样发布，
//    放一个 .progress.json 进去等于把内部中间态暴露到公网。
// 删掉进度文件最多导致重跑；进度里的译文**必须**逐行重新过 judgeLine 才复用（见 resume-progress.mjs）。
function progressPathFor(id, version) {
  return join(ROOT, progressRelativePath(id, version))
}

/** 读本条进度；文件不存在 / 损坏 / 不属于本条的一律返回 null（当作没翻过）。 */
function loadProgress(id, version) {
  const text = readFileQuietly(progressPathFor(id, version))
  return text === null ? null : parseProgress(text)
}

/**
 * 写本条进度（原子写，内容没变不碰文件）。
 *
 * 一行都没翻成时**不写空文件**：否则每次失败的运行都会在 sources/ 里留下
 * 一堆 `{"lines":{}}`，下次还会被当成「有进度」读一遍。
 * 失败只记日志：进度是**加速手段**，写不进去最多让下次重跑，不应让本条失败。
 */
function saveProgress(progress) {
  if (!progress || progress.lines.size === 0) return
  try {
    writeFileAtomic(progressPathFor(progress.id, progress.version), serializeProgress(progress))
  } catch (err) {
    console.log(`  [progress] ${progress.id}/${progress.version} 进度写入失败（不影响本次产出）: ${err.message.slice(0, 120)}`)
  }
}

/**
 * 翻译全部成功后删除进度文件。
 *
 * 为什么必须删：产物已经落盘并登记，这一版不再需要断点；留着只会在 sources/ 里堆垃圾。
 * 什么时候**不**删：本条以 cfMode 失败（还要试候选文件）、或整条超时——那些情况下进度仍是有效信息。
 */
function clearProgress(id, version) {
  removeFileQuietly(progressPathFor(id, version))
}

// ---------- 落盘队列（并发安全） ----------
// 并发 worker 会同时改 catalog / db / glossary。所有写盘任务排进同一条队列串行执行，
// 且写盘时才序列化当前内存状态，因此两个写任务不会交错写坏同一个 JSON。
let writeQueue = Promise.resolve()
// 写盘失败计数。落盘是尽力而为，但**不能静默吞掉**：CI 里 git commit 不校验文件内容，
// 写失败仍 exit 0 就是假绿灯。这里累计，结束时用非零退出码暴露。
let writeFailures = 0

function enqueueWrite(label, write) {
  writeQueue = writeQueue.then(write).catch((err) => {
    writeFailures++
    console.error(`  [persist] ${label} 写回失败: ${err.message}`)
  })
  return writeQueue
}

/**
 * 内容没变就不写；变了则原子写（先写同目录临时文件再 rename）。
 *
 * 为什么要原子写：直接 writeFileSync 覆盖大文件时，进程被杀或并发写会留下
 * 半截 JSON。rename 在同一分区上是原子的，读到的永远是完整版本。
 */
function writeJsonIfChanged(file, value) {
  const next = JSON.stringify(value, null, 2) + '\n'
  try {
    if (readFileSync(file, 'utf8') === next) return // 无改动，不碰文件
  } catch {
    // 文件不存在或读不了：照常写
  }
  const tmpFile = `${file}.tmp-${process.pid}`
  writeFileSync(tmpFile, next)
  renameSync(tmpFile, file)
}

// 保存翻译记忆
function persistGlossary() {
  return enqueueWrite('glossary', () => {
    // 同 writeJsonIfChanged 的理由：无改动就不写。
    // 之前这里无条件重写 39k 条的记忆库，`--ids __nonexistent__`（什么都没干）
    // 也会重写它 —— `npm test` 并行跑多个 pipeline 子进程时会在 Windows 上
    // 撞文件锁（`UNKNOWN: unknown error, open 'glossary.json'`），让 deploy 闸门随机变红。
    writeJsonIfChanged(GLOSSARY_FILE, glossary)
  })
}

// ---------- 极简 zip 读取（只读，支持 Stored/Deflate，不处理 zip64） ----------
function zipEntries(buf) {
  const eocdSig = 0x06054b50
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === eocdSig) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('zip: 找不到 EOCD')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const entries = new Map()
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip: 中央目录损坏')
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOffset = buf.readUInt32LE(off + 42)
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8')
    entries.set(name, { method, compSize, localOffset })
    off += 46 + nameLen + extraLen + commentLen
  }
  return {
    read(name) {
      const e = entries.get(name)
      if (!e) return null
      const lho = e.localOffset
      if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(`zip: 本地头损坏 ${name}`)
      const nameLen = buf.readUInt16LE(lho + 26)
      const extraLen = buf.readUInt16LE(lho + 28)
      const dataStart = lho + 30 + nameLen + extraLen
      const raw = buf.slice(dataStart, dataStart + e.compSize)
      return e.method === 0 ? raw : inflateRawSync(raw)
    },
    names: [...entries.keys()],
  }
}

// ---------- 翻译 ----------
// 两层的决策逻辑（免费层优先 → 回退池）在 scripts/lib/provider-chain.mjs 里，
// 那是纯逻辑、可离线单测；这里只负责把真实网络调用与环境状态注入进去。
const parseLangLines = parseLangLinesLib

// 日志时间戳（UTC HH:MM:SS.mmm）：并发下用来核对分块确实在重叠执行。
function timestamp() {
  return new Date().toISOString().slice(11, 23)
}

/**
 * 注入用的网络调用：把 provider 的提示词/请求体/超时/重试都套上，返回正文。
 * 免费层的 `maxAttempts: 1`（单次、无退避）与 `requestTimeoutMs` 在 chatOnce/chatWithRetry 里生效。
 *
 * `messages` 有两种形态：
 * - 数组（整块路径）：直接发给模型；
 * - 字符串（逐句路径）：**已经是一行待译文本**，由 line-translator 传入，
 *   这里包成单条 user 消息。逐句模型的提示词在 line-translator 里，不在 provider 上。
 */
function callProvider(activeProvider, messages, signal) {
  const payload = typeof messages === 'string' ? [{ role: 'user', content: messages }] : messages
  return chatWithRetry(activeProvider, payload, signal)
}

/** 本轮所有模型都已不可用**且**免费层也不可用 —— 才算整体失败。 */
function everythingUnusable(list = providers) {
  return allProvidersUnusable(list) && !freeTierUsable()
}

// 分块翻译器的**装配**也在 lib 里（createChunkTranslator）：这里只注入真实依赖。
// 把装配搬出 pipeline.mjs 是为了堵住一个真实覆盖盲区 —— 这段胶水层曾经从没被跑过，
// 重构时接连踩到 `timestamp is not defined` 与 `log is not defined`。
const translateChunk = createChunkTranslator({
  freeTierProvider,
  isFreeTierUsable: freeTierUsable,
  onFreeTierFailure: noteFreeTierFailure,
  onFreeTierSuccess: noteFreeTierSuccess,
  isUnusable: (id) => unusableProviders.has(id),
  markUnusable: (id) => unusableProviders.add(id),
  callProvider: (activeProvider, messages, sig) => callProvider(activeProvider, messages, sig),
  isNoOutput: isProviderNoOutput,
})

// 一条光影的初翻编排在 lib 里（createTranslateEntries）：记忆 → 进度 → LLM。
// 抽出去的理由同上：pipeline.mjs 无法被单测 import，而「三者优先级」「逐块记进度」
// 恰恰是决定产物的逻辑，必须能被离线复现（tests/translate-entries.test.mjs）。
// 全局记忆的读取在这里注入，本条局部增量由调用方按每条光影现建。
const translateEntries = createTranslateEntries({
  translateChunk,
  nextProviderOrder,
  everythingUnusable,
  providerUnusableMessage,
  chunkLines: CHUNK_LINES,
  chunkConcurrency: LLM_CHUNK_CONCURRENCY,
})

// ---------- 主流程 ----------
const catalog = JSON.parse(readFileSync(CATALOG_FILE, 'utf8'))
const cfCatalog = JSON.parse(readFileSync(CF_CATALOG_FILE, 'utf8'))
const db = JSON.parse(readFileSync(SHADERS_FILE, 'utf8'))

const latestLangVersion = new Map()
for (const s of db.shaders) {
  for (const v of s.langVersions ?? []) {
    latestLangVersion.set(s.id, v.shaderVersion) // langVersions 按新在前
    break
  }
}

// 跨平台去重用的 Modrinth 标题索引（判据与误判防护见 scripts/lib/cross-platform.mjs）。
const modrinthTitleIndex = buildTitleIndex(catalog.shaders, (e) => e.title)

/**
 * CF 条目在 Modrinth 侧已有汉化时返回那条 Modrinth 条目，否则 null。
 * 旁证（作者名/描述）取自 CF 目录：目录里没有该条目时只剩 slug 强证据，不按名称匹配（宁漏勿错）。
 */
function findTranslatedTwinForEntry(entry) {
  if (!isCurseforgeEntry(entry)) return null
  const cfRecord = (cfCatalog.mods ?? []).find(
    (m) =>
      m.slug === entry.curseforge?.slug ||
      (entry.curseforge?.cfId != null && m.cfId === entry.curseforge.cfId),
  )
  return findTranslatedTwin(
    {
      slug: cfRecord?.slug ?? entry.curseforge?.slug ?? entry.id,
      title: cfRecord?.name ?? entry.title,
      author: cfRecord?.author,
      description: cfRecord?.description,
    },
    modrinthTitleIndex,
    db.shaders,
  )
}

const candidates = catalog.shaders.filter((c) => {
  if (c.hasNativeZhCN === true) return false
  if (c.noEnUsLang === true) return false
  if (latestLangVersion.get(c.id)) return false // 最新版本已有汉化
  return true
})

const args = process.argv.slice(2)
const topArg = args.indexOf('--top')
const idsArg = args.indexOf('--ids')
const TOP = topArg >= 0 ? Number(args[topArg + 1]) : 50
const IDS = idsArg >= 0
  ? (args[idsArg + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  : []
// 老路径（向后兼容）：CF_SOURCE=curseforge 时 --ids 的每个 id 都强制当作 CF slug。
// 现在已不需要它：--ids 默认逐 id 自行判定平台（见下方 worklist 构造）。
const CF_SOURCE = process.env.CF_SOURCE

const tmp = mkdtempSync(join(tmpdir(), 'shader-pipeline-'))
let done = 0, skippedNative = 0, failed = 0, processed = 0

// 处理清单：--ids 优先（站点触发路径），否则沿用「按下载量取前 N 个」
let worklist
if (IDS.length) {
  if (topArg >= 0) console.log('⚠ 同时指定了 --ids 与 --top，以 --ids 为准（--top 被忽略）')
  worklist = []
  for (const id of IDS) {
    // 老路径（向后兼容）：CF_SOURCE=curseforge 时每个 id 都当作 CF slug，现场从 CurseForge 解析
    if (CF_SOURCE === 'curseforge') {
      try {
        const found = await cfFindBySlug(id)
        const cfEntry = buildShaderEntry({ source: 'curseforge', slug: found.slug, cfId: found.id })
        cfEntry.title = found.name ?? id
        worklist.push(cfEntry)
        console.log(`[${cfEntry.id}] 已从 CurseForge 现场解析（cfId ${found.id}）`)
      } catch (err) {
        console.log(`[${id}] 无法解析 CurseForge slug: ${err.message.slice(0, 120)}`)
        failed++
        await reportStatus(id, { status: STATUS.FAILED, error: `无法解析该 CF 光影：${err.message.slice(0, 200)}` })
      }
      continue
    }
    const fromCatalog = catalog.shaders.find((c) => c.id === id)
    if (fromCatalog) { worklist.push(fromCatalog); continue }

    // ② CurseForge 目录命中（按 slug）→ CF 分支，用目录里的 cfId（省一次 API 调用）
    const cfFromCatalog = (cfCatalog.mods ?? []).find((m) => m.slug === id)
    if (cfFromCatalog) {
      const cfEntry = buildShaderEntry({ source: 'curseforge', slug: cfFromCatalog.slug, cfId: cfFromCatalog.cfId })
      cfEntry.title = cfFromCatalog.name ?? id
      worklist.push(cfEntry)
      console.log(`[${cfEntry.id}] 命中 CurseForge 目录（cfId ${cfFromCatalog.cfId}）`)
      continue
    }

    // ③ 两个目录都没有（多为玩家刚提交的新光影）：先试 CurseForge，再试 Modrinth。
    // CF 未命中/未配 key/网络不可达都不算失败：Modrinth 是默认来源，继续走下面的现场解析。
    try {
      const found = await cfFindBySlug(id)
      const cfEntry = buildShaderEntry({ source: 'curseforge', slug: found.slug, cfId: found.id })
      cfEntry.title = found.name ?? id
      worklist.push(cfEntry)
      console.log(`[${cfEntry.id}] 不在任何目录中，已从 CurseForge 现场解析（cfId ${found.id}）`)
      continue
    } catch (err) {
      console.log(`[${id}] CurseForge 未命中（${err.message.slice(0, 120)}），改试 Modrinth`)
    }

    // catalog 外（多为玩家刚提交的新光影）：现场向 Modrinth 解析，失败只影响这一条
    try {
      const res = await fetch(`${MODRINTH_API}/project/${encodeURIComponent(id)}`, {
        headers: { 'User-Agent': UA() },
      })
      if (!res.ok) throw new Error(`Modrinth 返回 HTTP ${res.status}`)
      const p = await res.json()
      const synthesized = { id: p.slug ?? id, projectId: p.id, title: p.title ?? id, synthesized: true }
      catalog.shaders.push(synthesized)
      worklist.push(synthesized)
      console.log(`[${synthesized.id}] 不在 catalog 中，已从 Modrinth 现场解析（projectId ${p.id}）`)
    } catch (err) {
      console.log(`[${id}] 无法解析: ${err.message.slice(0, 120)}`)
      failed++
      await reportStatus(id, { status: STATUS.FAILED, error: `无法解析该光影（Modrinth 与 CurseForge 均未命中）：${err.message.slice(0, 200)}` })
    }
  }
  console.log(`本次处理 ${worklist.length} 个指定光影\n`)
} else {
  worklist = candidates.slice(0, TOP)
  console.log(`候选 ${candidates.length} 个，本次处理前 ${TOP} 个\n`)
}

// 写回 catalog + shaders。同一 tick 内的重复请求合并为一次写（persistPending），
// 实际写盘在微任务中执行，此时各 worker 的同步改动都已生效。
//
// ⚠️ 2026-10-19 修：这里曾经在**没有任何改动**时也无条件重写两个 JSON（合计约 4MB）。
// 后果：`--ids __nonexistent__` 这种「什么都没做」的运行也会重写文件，而
// `npm test` 会把多个测试文件**并行**跑，多个 pipeline 子进程同时重写同一对文件 →
// Windows 上偶发 `UNKNOWN: unknown error, open 'modrinth-catalog.json'` →
// `pipeline-smoke` 间歇性变红（实测 5 次里红 3 次）。
// deploy.yml 的闸门就是 `npm test`，所以这不是「测试不稳」，是**部署会随机失败**。
// 修法：写前先比内容，没变就不写；变了则原子写（临时文件 + rename）。
let persistPending = false
function persist() {
  if (persistPending) return writeQueue
  persistPending = true
  return enqueueWrite('catalog/shaders', () => {
    persistPending = false
    writeJsonIfChanged(CATALOG_FILE, catalog)
    writeJsonIfChanged(SHADERS_FILE, db)
  })
}

async function processShader(entry, signal, localGlossary) {
  const tag = `[${entry.id}]`
  // 跨平台去重：同一个光影在 Modrinth 侧已有汉化时直接判完成，不消耗任何 LLM 预算。
  // 必须放在最前面（早于 CF API / 下载），否则会先把时间花在下载上。
  const twin = findTranslatedTwinForEntry(entry)
  if (twin) {
    console.log(`${tag} 该光影的 Modrinth 版本（id=${twin.id}，名称「${twin.title}」v${twin.shaderVersion}）已有汉化，跳过`)
    return {
      status: STATUS.DONE,
      error: '',
      note: `该光影的 Modrinth 版本（id=${twin.id}）已有汉化，无需重复翻译`,
    }
  }
  // 模型级熔断：本轮已判定所有模型都产不出译文时，后续条目直接失败，不再下载、不再调 LLM。
  if (everythingUnusable()) {
    const message = providerUnusableMessage(providers.map((p) => p.id))
    console.log(`${tag} 跳过：${message}`)
    return { status: STATUS.FAILED, error: message }
  }
  // CurseForge 分支：下载/版本选择/降级都在 processShaderCf 内处理，行为与 Modrinth 互不影响。
  if (isCurseforgeEntry(entry)) return processShaderCf(entry, signal, localGlossary)
  try {
    if (signal.aborted) {
      return { status: STATUS.FAILED, error: '处理超时' }
    }
    const versions = await mfetch(`${MODRINTH_API}/project/${entry.projectId}/version`, {
      headers: { 'User-Agent': UA() },
      signal,
    }).then((r) => r.json())
    const latest = versions[0]
    const file = latest?.files?.find((f) => f.primary) ?? latest?.files?.[0]
    if (!file) { console.log(`${tag} 无可下载文件，跳过`); failed++; return { status: STATUS.FAILED, error: 'Modrinth 最新版本无可下载文件' } }
    const shaderVersion = latest.version_number
    if (latestLangVersion.get(entry.id) === shaderVersion) {
      console.log(`${tag} v${shaderVersion} 已有汉化，跳过`)
      return { status: STATUS.DONE, error: '', shaderVersion }
    }

    const zipBuf = await downloadZipBuffer(file.url, signal, tag)
    const zip = zipEntries(zipBuf)
    return await translateFromZip({ entry, zip, shaderVersion, sourceFileName: file.filename, tag, signal, localGlossary })
  } catch (err) {
    if (signal.aborted) {
      return { status: STATUS.FAILED, error: '处理超时' }
    }
    console.log(`${tag} 失败: ${err.message.slice(0, 200)}`)
    failed++
    return { status: STATUS.FAILED, error: err.message.slice(0, 200) }
  }
}

/** 整包下载 zip 并解析为条目对象（带 3 次线性退避重试，与原有 Modrinth 分支行为一致）。 */
async function downloadZipBuffer(url, signal, tag) {
  let zipBuf
  for (let attempt = 1; ; attempt++) {
    try {
      zipBuf = Buffer.from(await mfetch(url, { headers: { 'User-Agent': UA() }, signal }).then((r) => r.arrayBuffer()))
      return zipBuf
    } catch (err) {
      if (attempt >= 3 || signal?.aborted) throw err
      console.log(`${tag} 下载失败（第 ${attempt} 次）: ${err.message.slice(0, 80)}，重试`)
      await sleepAbortable(2000 * attempt, signal)
    }
  }
}

/**
 * 取 shaders.json 里对应条目；缺失时按来源补建（CF 用 curseforge 映射，Modrinth 用 modrinth 映射）。
 * CF 条目的 entry 是 buildShaderEntry 造的临时对象，只有写进 db.shaders 才能被站点读到。
 */
function ensureShaderEntry(entry) {
  let shaderEntry = db.shaders.find((s) => s.id === entry.id)
  if (!shaderEntry) {
    shaderEntry = entry.source === 'curseforge'
      ? buildShaderEntry({ source: 'curseforge', slug: entry.id, cfId: entry.curseforge?.cfId })
      : buildShaderEntry({ modrinth: { slug: entry.id, projectId: entry.projectId } })
    db.shaders.push(shaderEntry)
  }
  return shaderEntry
}

/**
 * 已下载 zip 后的公共处理路径（Modrinth 与 CurseForge 共用）：
 * 检测自带中文 → 抽取英文源 → LLM 初翻 → 校验落盘 → 登记 langVersions。
 *
 * cfMode=true 时（CF 候选文件循环）：某文件失败/无英文源不落盘、不改标记，
 * 返回 { cfRetry: true } 让调用方尝试下一个文件；检出自带中文与成功路径与 Modrinth 完全一致（都是终态，标记完成）。
 */
async function translateFromZip({ entry, zip, shaderVersion, sourceFileName, tag, signal, localGlossary, cfMode = false }) {
  const langNames = zip.names.filter(isLangFilePath)
  if (langNames.some(isZhCNLangPath)) {
    // 自带中文是终态：CF 候选文件循环里也直接标记完成，不再当候选失败去试下一个。
    // CF 的 entry 是 buildShaderEntry 造的临时对象（不在 catalog/db 里），
    // 标记必须落到 shaders.json 的对应条目，否则展示侧读不到 hasNativeZhCN。
    entry.hasNativeZhCN = true
    if (isCurseforgeEntry(entry)) ensureShaderEntry(entry).hasNativeZhCN = true
    console.log(`${tag} 自带中文（v${shaderVersion}），已标记并排除`)
    skippedNative++
    persist()
    return { status: STATUS.DONE, error: '', shaderVersion, note: '该光影已自带简体中文，无需汉化' }
  }
  const enName = langNames.find(isEnUsLangPath)
  if (!enName) {
    if (cfMode) {
      console.log(`${tag} 候选文件 v${shaderVersion} 无 en_US.lang（lang 文件: ${langNames.join(', ') || '无'}），尝试下一个`)
      return { status: STATUS.FAILED, error: `候选文件无 en_US.lang（lang 文件: ${langNames.join(', ') || '无'}）`, cfRetry: true }
    }
    entry.noEnUsLang = true
    console.log(`${tag} 无 en_US.lang（lang 文件: ${langNames.join(', ') || '无'}），跳过`)
    failed++
    persist()
    return { status: STATUS.FAILED, error: `无 en_US.lang（lang 文件: ${langNames.join(', ') || '无'}）` }
  }

  const enText = (await zip.read(enName)).toString('utf8')
  const lines = enText.split('\n')
  const pairs = []
  for (const line of lines) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    pairs.push([t.slice(0, eq), t.slice(eq + 1)])
  }
  if (!pairs.length) {
    if (cfMode) {
      console.log(`${tag} 候选文件 v${shaderVersion} en_US.lang 无可翻译条目，尝试下一个`)
      return { status: STATUS.FAILED, error: '候选文件 en_US.lang 无可翻译条目', cfRetry: true }
    }
    entry.noEnUsLang = true
    console.log(`${tag} en_US.lang 无可翻译条目，跳过`)
    failed++
    persist()
    return { status: STATUS.FAILED, error: 'en_US.lang 无可翻译条目' }
  }

  // 断点续翻：读本条这一版的进度（不存在 / 损坏 / 版本不符 → 当作没翻过）。
  // 进度里的译文会在 planLines 里**逐行重新过 judgeLine** 才复用，所以文件被外部改坏
  // 最多让那几行重翻，不会产出错译。
  const heldProgress = loadProgress(entry.id, shaderVersion)
  // 收敛：丢掉「英文源已改 / 键已删 / 译文不合格」的旧记录，并保证 id/version 是**本条**的
  // （否则后续保存会按旧 id 写回错误路径）。
  const progress = pruneProgress(heldProgress, { id: entry.id, version: shaderVersion, pairs })
  const resumeSummary = progressSummary(progress, pairs)
  if (resumeSummary.done > 0) {
    console.log(`${tag} 发现断点进度：${resumeSummary.done}/${resumeSummary.total} 行已翻（剩余 ${resumeSummary.remaining} 行）`)
  }

  // 日志要如实反映「谁在干活」：免费层是默认主路，只列 LLM_MODELS 会误导排查。
  const poolLabel = providers.length ? `回退池 [${LLM_MODELS.join(', ')}]` : '回退池（空）'
  const freeLabel = FREE_TIER_ON ? `免费层 [${freeTierProvider.id}] 优先，` : ''
  console.log(`${tag} v${shaderVersion}：${pairs.length} 个键，${freeLabel}${poolLabel} 开始初翻…`)
  // 翻译记忆读取：全局（已合并的历史）优先，其次本条已累积的局部记忆。
  // 放在这里（而不是模块顶层）是因为它依赖本条的 localGlossary。
  const lookup = (skel) => glossary[skel] ?? localGlossary.get(skel)
  // 进度落盘放在 finally：translateEntries 抛错（模型全挂 / 整体失败）时，
  // 已完成分块的译文仍要留下痕迹，下次只补没翻成的。
  // 内部按分块完成即时 recordProgress，所以这里拿到的是「抛错前已翻好的部分」。
  let translated
  try {
    translated = await translateEntries(pairs, providers, signal, localGlossary, {
      lookup,
      progress,
      id: entry.id,
      version: shaderVersion,
      // 每块完成即落盘：整条被超时打断时，最多丢掉正跑到一半的那一块。
      onChunkDone: () => saveProgress(progress),
    })
  } finally {
    saveProgress(progress)
  }
  const { map: zhMap, totalFallback, glossaryHit, progressHit, llmCalls, providersUsed } = translated
  // 本条的局部记忆由 processShaderWithTimeout 的 finally 统一合并（超时也能合并）。
  console.log(`${tag} 翻译完成：记忆命中 ${glossaryHit}，LLM 调用 ${llmCalls} 次，回退 ${totalFallback}/${pairs.length}，来源 ${providersUsed.length ? providersUsed.join(' + ') : '翻译记忆'}`)
  // 整体回退率过高视为翻译失败：不上线、不登记，留待下次重试
  if (totalFallback > pairs.length * 0.3) {
    const done = progressSummary(progress, pairs)
    if (cfMode) {
      console.log(`${tag} 候选文件 v${shaderVersion} 回退率过高（${totalFallback}/${pairs.length}），尝试下一个`)
      console.log(`${tag} 断点进度已保存：${done.done}/${pairs.length} 行，下次只补 ${done.remaining} 行`)
      return { status: STATUS.FAILED, error: `翻译回退率过高（${totalFallback}/${pairs.length}）`, cfRetry: true }
    }
    console.log(`${tag} 回退率过高（${totalFallback}/${pairs.length}），判定失败，跳过`)
    console.log(`${tag} 断点进度已保存：${done.done}/${pairs.length} 行，下次只补 ${done.remaining} 行`)
    failed++
    return { status: STATUS.FAILED, error: `翻译回退率过高（${totalFallback}/${pairs.length}）` }
  }
  // 渲染在 lib 里（纯函数），保证「复用进度的译文」与「重新翻出的译文」
  // 渲染出的字节完全一致；tests/lang-render.test.mjs 用仓库真实文件做往返比对。
  const content = renderZhLang({
    title: entry.title, id: entry.id, shaderVersion, sourceFileName, enName, lines, zhMap,
    repair: repairMalformedSections,
  })
  const outPath = join(LANG_DIR, entry.id, shaderVersion, 'zh_CN.lang')

  // 先校验内存里的内容，通过后才落盘。
  // 历史实现是「先写文件再校验」，校验失败时已把坏文件留在磁盘上。
  const verdict = validatePair(enText, content, `${entry.id}/${shaderVersion}`)
  if (verdict.problems.length) {
    const msg = verdict.problems.join('; ').slice(0, 300)
    console.log(`${tag} 校验未通过，不落盘: ${msg}`)
    if (cfMode) return { status: STATUS.FAILED, error: msg, cfRetry: true }
    failed++
    persist()
    return { status: STATUS.FAILED, error: msg }
  }

  if (signal.aborted) {
    throw new Error('处理超时')
  }
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, content)

  // 全部成功：删除进度文件（这一版不再需要断点）。
  // 只有产物真正落盘后才删——否则「校验未通过」分支会连断点一起丢掉。
  clearProgress(entry.id, shaderVersion)

  // 同时缓存英文原文到 sources/，供 pack-lang-sources.mjs 重新打包。
  // 否则新翻译的光影在 CI 里找不到英文源，下一次 validate:lang 会判失败。
  const enCachePath = join(SOURCES_DIR, entry.id, shaderVersion, 'en_US.lang')
  mkdirSync(dirname(enCachePath), { recursive: true })
  writeFileSync(enCachePath, enText)

  const shaderEntry = ensureShaderEntry(entry)
  shaderEntry.langVersions = shaderEntry.langVersions ?? []
  shaderEntry.langVersions.unshift({
    shaderVersion,
    langVersion: '1.0.0',
    file: `/lang/${entry.id}/${shaderVersion}/zh_CN.lang`,
    quark: '',
    updatedAt: new Date().toISOString().slice(0, 10),
    contributors: [contributorLine(providersUsed)],
  })
  done++
  processed++
  console.log(`${tag} 完成（${processed}/${worklist.length}） -> ${outPath.replace(ROOT + '\\', '').replace(/\\\\/g, '/')}`)
  persist()
  await sleep(300)
  return {
    status: STATUS.DONE,
    error: '',
    langPath: `/lang/${entry.id}/${shaderVersion}/zh_CN.lang`,
    shaderVersion,
  }
}

/**
 * CurseForge 分支：按 release 优先 + fileDate 倒序取候选文件，逐个尝试；
 * 某文件下载/解析/翻译失败就试下一个；全部失败只记一次失败并返回，不阻断其他 shader。
 */
async function processShaderCf(entry, signal, localGlossary) {
  const tag = `[${entry.id}]`
  try {
    if (signal.aborted) {
      return { status: STATUS.FAILED, error: '处理超时' }
    }
    const cfId = entry.curseforge?.cfId
    if (cfId == null) throw new Error('CurseForge 条目缺少 curseforge.cfId')
    // 本条光影的 CF 预算：元数据请求、每个候选文件都从这份预算里扣，总占用有硬上限。
    const deadline = Date.now() + CF_SHADER_BUDGET_MS
    // 项目详情里就能读到分发许可：allowModDistribution=false 是项目级永久属性，
    // CF 下载接口一律返回 403，重试无意义 —— 在读文件列表之前就跳过，不浪费下载预算。
    const mod = await cfGetMod(cfId, AbortSignal.any([signal, AbortSignal.timeout(CF_SHADER_BUDGET_MS)]))
    if (mod?.allowModDistribution === false) {
      console.log(`${tag} 跳过：作者禁止 API 分发（allowModDistribution=false），永久排除，不尝试下载`)
      return { status: STATUS.DONE, error: '', note: '作者禁止 API 分发（allowModDistribution=false），永久排除' }
    }
    const files = await cfGetFiles(cfId, 50, AbortSignal.any([signal, AbortSignal.timeout(CF_SHADER_BUDGET_MS)]))
    // release 优先（releaseType===1），同类型内按 fileDate 倒序（新在前）
    const candidates = files
      .slice()
      .sort((a, b) => {
        const aRelease = a.releaseType === 1 ? 0 : 1
        const bRelease = b.releaseType === 1 ? 0 : 1
        if (aRelease !== bRelease) return aRelease - bRelease
        return String(b.fileDate).localeCompare(String(a.fileDate))
      })
    if (!candidates.length) {
      console.log(`${tag} CF 无任何可下载文件，跳过`)
      failed++
      return { status: STATUS.FAILED, error: 'CurseForge 无任何可下载文件' }
    }
    let lastError = ''
    for (const f of candidates) {
      if (signal.aborted) return { status: STATUS.FAILED, error: '处理超时' }
      // 模型级熔断：所有模型都产不出译文时，不再为剩余候选文件重复下载/试错。
      if (everythingUnusable()) {
        lastError = providerUnusableMessage(providers.map((p) => p.id))
        console.log(`${tag} ${lastError}，不再尝试剩余候选文件`)
        break
      }
      const budgetLeft = deadline - Date.now()
      if (budgetLeft <= 0) {
        lastError = `本条光影 CF 预算（${CF_SHADER_BUDGET_MS / 60000} 分钟）已用尽`
        console.log(`${tag} ${lastError}，不再尝试剩余候选文件`)
        break
      }
      const shaderVersion = cfVersionFromFileName(f.fileName, f.id)
      if (latestLangVersion.get(entry.id) === shaderVersion) {
        console.log(`${tag} ${shaderVersion} 已有汉化，跳过`)
        return { status: STATUS.DONE, error: '', shaderVersion }
      }
      // 单候选上限 = min(单候选 3 分钟, 本条剩余预算)，并与光影 signal 合并：
      // 该候选的下载/翻译全部走这个 signal，任一中止即真正断开进行中的 fetch。
      const candSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.min(CF_CANDIDATE_TIMEOUT_MS, budgetLeft)),
      ])
      try {
        const downloadUrl = await cfGetDownloadUrl(cfId, f.id, candSignal)
        const zipBuf = await downloadZipBuffer(downloadUrl, candSignal, tag)
        const zip = zipEntries(zipBuf)
        const result = await translateFromZip({
          entry,
          zip,
          shaderVersion,
          sourceFileName: f.fileName,
          tag,
          signal: candSignal,
          localGlossary,
          cfMode: true,
        })
        if (result.status === STATUS.DONE) return result
        lastError = result.error || '候选文件处理失败'
        console.log(`${tag} 候选文件 ${f.id}（${shaderVersion}）失败: ${lastError}，尝试下一个`)
      } catch (err) {
        if (signal.aborted) return { status: STATUS.FAILED, error: '处理超时' }
        lastError = candSignal.aborted
          ? `候选文件超时（>${CF_CANDIDATE_TIMEOUT_MS / 60000} 分钟）`
          : err.message.slice(0, 200)
        console.log(`${tag} 候选文件 ${f.id}（${shaderVersion}）异常: ${lastError}，尝试下一个`)
      }
    }
    console.log(`${tag} 所有候选文件均失败: ${lastError}`)
    failed++
    return { status: STATUS.FAILED, error: `CF 所有候选文件均失败: ${lastError}` }
  } catch (err) {
    if (signal.aborted) {
      return { status: STATUS.FAILED, error: '处理超时' }
    }
    console.log(`${tag} 失败: ${err.message.slice(0, 200)}`)
    failed++
    return { status: STATUS.FAILED, error: err.message.slice(0, 200) }
  }
}

/**
 * 给 processShader 套一层独立超时。
 * 超时或抛错都只让这一条计为失败，不影响后续条目（失败隔离）。
 */
async function processShaderWithTimeout(entry) {
  // 每条光影独立的中断信号：超时只中断这一条的进行中请求，
  // 并发处理其他条目时互不影响（不再使用模块级 activeSignal）。
  const controller = new AbortController()
  const { signal } = controller
  // 本条光影的翻译记忆增量。**在这里创建**，这样超时/抛错被 Promise.race 抢占时，
  // 已经翻好的术语仍能在 finally 里合并，不会白丢（否则下次重跑要重调 LLM）。
  const localGlossary = new Map()

  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve('timeout')
    }, PER_SHADER_TIMEOUT_MS)
  })

  let result
  try {
    result = await Promise.race([
      processShader(entry, signal, localGlossary).catch((err) => ({ status: STATUS.FAILED, error: err.message.slice(0, 200) })),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
    // 无论成功 / 超时 / 抛错，都合并本条已产出的记忆增量。
    // 同步循环、无 await，合并本身不会被并发打断；重复合并是幂等的（有 !glossary[k] 守卫）。
    for (const [k, v] of localGlossary) if (!glossary[k]) glossary[k] = v
  }

  if (result === 'timeout') {
    const minutes = PER_SHADER_TIMEOUT_MS / 60000
    console.log(`[${entry.id}] 超过 ${minutes} 分钟未完成，已中止，跳过`)
    failed++
    result = { status: STATUS.FAILED, error: `处理超时（>${minutes} 分钟）` }
  }

  await reportStatus(entry.id, {
    status: result.status,
    error: result.error,
    langPath: result.langPath,
    shaderVersion: result.shaderVersion,
    note: result.note,
    attempts: (entry.attempts ?? 0) + 1,
  })
}

function UA() {
  return 'shader-i18n-site/0.1.0 (translation pipeline)'
}

try {
  await runPool(worklist, processShaderWithTimeout, LLM_CONCURRENCY)
} finally {
  // 等在飞的写盘任务落完再退出（persist 现在是排队 + 微任务执行）
  await persist()
  await persistGlossary()
  rmSync(tmp, { recursive: true, force: true })
  console.log(`\n流水线结束：完成 ${done}，自带中文排除 ${skippedNative}，失败/跳过 ${failed}`)
  if (writeFailures > 0) {
    console.error(`\n❌ 有 ${writeFailures} 次写盘失败，产物可能不完整（退出码置 1）`)
    process.exitCode = 1
  }
}
