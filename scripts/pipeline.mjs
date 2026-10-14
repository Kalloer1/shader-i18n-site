#!/usr/bin/env node
/**
 * 自动汉化流水线（ADR-0005）：下载 → 检测自带中文 → LLM 初翻 → 校验 → 登记。
 *
 * 候选：目录中按下载量排序、未被流水线覆盖且不在缺少英文源清单中的光影（无汉化映射、未检出自带中文）。
 * 翻译默认使用模型池，按分块轮转调用；失败或回退过高时自动尝试下一个模型。
 * LLM_CONCURRENCY 控制光影级并发（每条光影仍各自独立超时、独立中断）。
 *
 * LLM 提供方：环境变量配置，默认指向自建中转站（OpenAI 兼容）。
 *   LLM_BASE_URL    接口地址；优先级 LLM_BASE_URL > SILICONFLOW_BASE_URL（旧名别名） > 默认中转站
 *   LLM_API_KEY     API key；缺省回退 SILICONFLOW_API_KEY（旧名别名）
 *   LLM_MODELS      模型名列表（逗号分隔）；优先于 LLM_MODEL
 *   LLM_MODEL       兼容单模型配置，也接受逗号分隔列表
 *   LLM_CONCURRENCY 并发度；默认 10
 *   LLM_EXTRA_BODY  额外请求体（JSON 字符串，浅合并进 body，用于透传中转站参数）
 * 不设任何 LLM_* 环境变量时，报错文案 / provider 打印 / 请求体 / 模型与改造前完全一致。
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
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { STATUS } from '../shared/tencent-docs.mjs'
import { validatePair, repairMalformedSections } from './validate-lang.mjs'
import { isEnUsLangPath, isLangFilePath, isZhCNLangPath } from './lib/lang-source.mjs'
import { cfGetFiles, cfGetDownloadUrl, cfFindBySlug } from './lib/cf-api.mjs'
import { cfVersionFromFileName, buildShaderEntry, isCurseforgeEntry } from './lib/cf.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG_FILE = join(ROOT, 'site/data/modrinth-catalog.json')
const SHADERS_FILE = join(ROOT, 'site/data/shaders.json')
const GLOSSARY_FILE = join(ROOT, 'site/data/glossary.json')
const LANG_DIR = join(ROOT, 'site/public/lang')
const SOURCES_DIR = join(ROOT, 'sources')
const MODRINTH_API = 'https://api.modrinth.com/v2'
const CHUNK_LINES = 60
const DEFAULT_MODEL = 'tencent/Hunyuan-MT-7B'
const DEFAULT_CONCURRENCY = 10
const DEFAULT_BASE_URL = 'https://api.888424.xyz/v1/chat/completions'
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

function providerHostLabel(url) {
  try { return new URL(url).host } catch { return url }
}

function createProvider(model) {
  const isDefault = !LLM_ENV_SET && model === DEFAULT_MODEL
  return {
    id: model,
    name: isDefault ? `Hunyuan-MT-7B（${providerHostLabel(DEFAULT_BASE_URL)}）` : `${model}（${providerHostLabel(LLM_URL())}）`,
    url: LLM_URL,
    key: LLM_KEY,
    body: (messages) => ({
      model,
      messages,
      temperature: 0.2,
      max_tokens: 8192,
      ...LLM_EXTRA_BODY,
    }),
    extract: (j) => j.choices?.[0]?.message?.content,
  }
}

const providers = LLM_MODELS.map(createProvider)
const provider = providers[0]
let providerCursor = 0

function nextProviderOrder(list = providers) {
  const start = providerCursor++ % list.length
  return [...list.slice(start), ...list.slice(0, start)]
}

if (!LLM_KEY()) {
  if (LLM_ENV_SET) {
    console.error('缺少 API key：请设置 LLM_API_KEY（或别名 SILICONFLOW_API_KEY），默认站点 ' + providerHostLabel(DEFAULT_BASE_URL))
  } else {
    console.error('缺少 API key：请设置 LLM_API_KEY（或别名 SILICONFLOW_API_KEY）')
  }
  process.exit(2)
}
const providerLabel = providers.length === 1 && !LLM_ENV_SET
  ? `${provider.name}（${provider.body([]).model}）`
  : providers.map((p) => `${p.name}（${p.body([]).model}）`).join(' / ')
console.log(`LLM 提供方：${providerLabel}\n`)
// 仅在显式配置时打印，保证「不设环境变量」时的输出与改造前逐字一致。
if (envStr('LLM_CONCURRENCY') !== undefined) console.log(`LLM 并发度：${LLM_CONCURRENCY}\n`)

async function chatOnce(activeProvider, messages, signal) {
  const res = await mfetch(activeProvider.url(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${activeProvider.key()}` },
    body: JSON.stringify(activeProvider.body(messages)),
    signal,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const j = await res.json()
  const text = activeProvider.extract(j)
  if (!text) throw new Error('返回为空')
  return text
}

async function chatWithRetry(activeProvider, messages, signal) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await chatOnce(activeProvider, messages, signal)
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err
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

// 骨架提取：剥离合法 § 格式码、小写、压缩空白
function stripSkeleton(value) {
  return value
    .replace(/§[0-9a-fk-or]+/gi, '')   // 剥离合法 § 码（§e、§r、§a[+]§c[-] 等）
    .toLowerCase()
    .replace(/\s+/g, ' ')               // 压缩空白
    .trim()
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

// 保存翻译记忆
function persistGlossary() {
  return enqueueWrite('glossary', () => {
    writeFileSync(GLOSSARY_FILE, JSON.stringify(glossary, null, 2) + '\n')
  })
}

// ---------- 翻译提示词 ----------
const SYSTEM_PROMPT = `你是 Minecraft Java 版光影包（Iris / OptiFine）语言文件（.lang）的专业本地化译者。输入每行形如 "键=英文值"，输出 "键=中文值"。

硬性规则（违反即任务失败）：
1. 键名（= 左侧）一字不改；输出行数与输入一致、顺序相同；禁止合并或拆分行。
2. 占位符（%s、%value%、%n$s 等）与格式码（§ 及其后一个字符，如 §e、§r、§a[+]§c[-]）的数量、种类、相对位置必须与原文完全一致。
3. 只输出结果行，禁止解释、禁止序号、禁止 markdown 代码块。

术语表（全篇统一，符合 Minecraft 社区习惯）：
chunk=区块｜biome=群系｜vanilla=原版｜shaderpack=光影包｜resource pack=资源包
ambient occlusion/AO=环境光遮蔽｜bloom=泛光｜light shafts/volumetric light=体积光｜god rays=体积光
depth of field/DoF=景深｜caustics=焦散｜specular=高光｜normal mapping=法线贴图｜parallax=视差
emissive=自发光｜anti-aliasing=抗锯齿｜tonemap=色调映射｜saturation=饱和度｜vibrance=自然饱和度
profile=配置档｜shadowmap=阴影贴图｜skybox=天空盒｜fog=雾｜translucent=半透明
motion blur=运动模糊｜vignette=暗角｜chromatic aberration=色差｜lens flare=镜头光晕｜refraction=折射

风格规则：
4. "More xxx Config" 类界面名译为「xxx 高级设置」；"xxx Strength/Amount" 译为「xxx 强度/数量」。
5. 质量档位用 低配/中配/高配/极高；数值型取值（"0.50"、"8K"、"5 cm"、"10%"）保持原样。
6. 专有名词保留原文：TAA、FXAA、labPBR、SEUS、PBR、LOD、Voxy、Distant Horizons、Perlin、Worley、OptiFine、Iris、BSL。
7. 界面文案要简洁（游戏设置空间有限），长说明句（.comment）译得通顺完整、不偷懒减行。
8. 语义不明的键保持英文原值，不要猜。`

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
// 解析模型输出：提取 键=值 对（容忍代码块围栏、前后杂讯）
function parseLangLines(text) {
  const got = new Map()
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    got.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  return got
}

// 翻译一个分块。模型偶发空响应/回显原文，因此回退率超过 10% 即重试，最多 3 次，取回退最少的版本。
async function translateChunk(chunk, activeProviders, signal) {
  const providerList = Array.isArray(activeProviders) ? activeProviders : [activeProviders]
  const input = chunk.map(([k, v]) => `${k}=${v}`).join('\n')
  let best = null, bestFallback = chunk.length
  const threshold = Math.ceil(chunk.length * 0.1)
  for (const activeProvider of providerList) {
    for (let attempt = 1; attempt <= 3 && bestFallback > threshold; attempt++) {
      let text
      try {
        text = await chatWithRetry(activeProvider, [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: input },
        ], signal)
      } catch (err) {
        console.log(`    [${activeProvider.id}] 分块翻译失败（重试耗尽）: ${err.message.slice(0, 120)}`)
        break
      }
      const got = parseLangLines(text)
      const out = new Map()
      let fallback = 0
      for (const [k, v] of chunk) {
        const zh = got.get(k)
        if (zh && zh !== v) out.set(k, zh)
        else { out.set(k, v); fallback++ }
      }
      if (fallback < bestFallback) {
        best = out
        bestFallback = fallback
      }
      if (bestFallback > threshold) {
        console.log(`    第 ${attempt} 次分块回退率 ${fallback}/${chunk.length}，重试`)
      }
    }
    if (bestFallback <= threshold) break
  }
  return { map: best ?? new Map(chunk.map(([k, v]) => [k, v])), fallback: bestFallback }
}

async function translateEntries(pairs, activeProviders, signal, localGlossary) {
  const providerList = Array.isArray(activeProviders) ? activeProviders : [activeProviders]
  const out = new Map()
  let totalFallback = 0
  let glossaryHit = 0
  let llmCalls = 0

  // 翻译记忆读取：全局（已合并的历史）优先，其次本条已累积的局部记忆。
  const lookup = (skel) => glossary[skel] ?? localGlossary.get(skel)

  // 第一步：查翻译记忆，命中的直接复用
  const unmatched = []
  for (const [k, v] of pairs) {
    const skel = stripSkeleton(v)
    const hit = skel ? lookup(skel) : undefined
    if (hit) {
      out.set(k, hit)
      glossaryHit++
    } else {
      unmatched.push([k, v])
    }
  }

  if (unmatched.length === 0) {
    console.log(`    翻译记忆全覆盖（${glossaryHit}/${pairs.length}），跳过 LLM`)
    return { map: out, totalFallback: 0, glossaryHit, llmCalls: 0 }
  }

  console.log(`    翻译记忆命中 ${glossaryHit}/${pairs.length}，剩余 ${unmatched.length} 个需 LLM 翻译`)

  // 第二步：未命中的发给 LLM
  for (let i = 0; i < unmatched.length; i += CHUNK_LINES) {
    const chunk = unmatched.slice(i, i + CHUNK_LINES)
    const orderedProviders = providerList.length > 1 ? nextProviderOrder(providerList) : providerList
    const { map, fallback } = await translateChunk(chunk, orderedProviders, signal)
    for (const [k, v] of map) {
      out.set(k, v)
      // 新翻译结果按英文原文记入本条的局部翻译记忆，不直接改共享的 glossary；
      // 本条处理结束后由调用方一次性合并，避免并发 worker 同时写同一对象。
      const sourceSkeleton = stripSkeleton(chunk.find(([key]) => key === k)?.[1] ?? '')
      if (sourceSkeleton && !lookup(sourceSkeleton)) {
        localGlossary.set(sourceSkeleton, v)
      }
    }
    totalFallback += fallback
    llmCalls++
  }

  return { map: out, totalFallback, glossaryHit, llmCalls }
}

// ---------- 主流程 ----------
const catalog = JSON.parse(readFileSync(CATALOG_FILE, 'utf8'))
const db = JSON.parse(readFileSync(SHADERS_FILE, 'utf8'))

const latestLangVersion = new Map()
for (const s of db.shaders) {
  for (const v of s.langVersions ?? []) {
    latestLangVersion.set(s.id, v.shaderVersion) // langVersions 按新在前
    break
  }
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
// 来源切换：CF_SOURCE=curseforge 时 --ids 的每个 id 都当作 CF slug，走 CurseForge 解析。
const CF_SOURCE = process.env.CF_SOURCE

const tmp = mkdtempSync(join(tmpdir(), 'shader-pipeline-'))
let done = 0, skippedNative = 0, failed = 0, processed = 0

// 处理清单：--ids 优先（站点触发路径），否则沿用「按下载量取前 N 个」
let worklist
if (IDS.length) {
  if (topArg >= 0) console.log('⚠ 同时指定了 --ids 与 --top，以 --ids 为准（--top 被忽略）')
  worklist = []
  for (const id of IDS) {
    // CF 来源：--ids 里的每个 id 都当作 CF slug，现场从 CurseForge 解析（不走 Modrinth API）
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
      await reportStatus(id, { status: STATUS.FAILED, error: `无法解析该光影：${err.message.slice(0, 200)}` })
    }
  }
  console.log(`本次处理 ${worklist.length} 个指定光影\n`)
} else {
  worklist = candidates.slice(0, TOP)
  console.log(`候选 ${candidates.length} 个，本次处理前 ${TOP} 个\n`)
}

// 写回 catalog + shaders。同一 tick 内的重复请求合并为一次写（persistDirty），
// 实际写盘在微任务中执行，此时各 worker 的同步改动都已生效。
let persistDirty = false
function persist() {
  if (persistDirty) return writeQueue
  persistDirty = true
  return enqueueWrite('catalog/shaders', () => {
    persistDirty = false
    writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2) + '\n')
    writeFileSync(SHADERS_FILE, JSON.stringify(db, null, 2) + '\n')
  })
}

async function processShader(entry, signal, localGlossary) {
  const tag = `[${entry.id}]`
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
 * 已下载 zip 后的公共处理路径（Modrinth 与 CurseForge 共用）：
 * 检测自带中文 → 抽取英文源 → LLM 初翻 → 校验落盘 → 登记 langVersions。
 *
 * cfMode=true 时（CF 候选文件循环）：某文件失败/无英文源不落盘、不改标记，
 * 返回 { cfRetry: true } 让调用方尝试下一个文件；成功路径与 Modrinth 完全一致。
 */
async function translateFromZip({ entry, zip, shaderVersion, sourceFileName, tag, signal, localGlossary, cfMode = false }) {
  const langNames = zip.names.filter(isLangFilePath)
  if (langNames.some(isZhCNLangPath)) {
    if (cfMode) {
      console.log(`${tag} 候选文件 v${shaderVersion} 自带中文，尝试下一个`)
      return { status: STATUS.FAILED, error: '候选文件自带中文', cfRetry: true }
    }
    entry.hasNativeZhCN = true
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

  console.log(`${tag} v${shaderVersion}：${pairs.length} 个键，[${LLM_MODELS.join(', ')}] 开始初翻…`)
  const { map: zhMap, totalFallback, glossaryHit, llmCalls } = await translateEntries(pairs, providers, signal, localGlossary)
  // 本条的局部记忆由 processShaderWithTimeout 的 finally 统一合并（超时也能合并）。
  console.log(`${tag} 翻译完成：记忆命中 ${glossaryHit}，LLM 调用 ${llmCalls} 次，回退 ${totalFallback}/${pairs.length}`)
  // 整体回退率过高视为翻译失败：不上线、不登记，留待下次重试
  if (totalFallback > pairs.length * 0.3) {
    if (cfMode) {
      console.log(`${tag} 候选文件 v${shaderVersion} 回退率过高（${totalFallback}/${pairs.length}），尝试下一个`)
      return { status: STATUS.FAILED, error: `翻译回退率过高（${totalFallback}/${pairs.length}）`, cfRetry: true }
    }
    console.log(`${tag} 回退率过高（${totalFallback}/${pairs.length}），判定失败，跳过`)
    failed++
    return { status: STATUS.FAILED, error: `翻译回退率过高（${totalFallback}/${pairs.length}）` }
  }
  const outLines = lines.map((line) => {
    const t = line.trim()
    if (!t || t.startsWith('#')) return line
    const eq = t.indexOf('=')
    if (eq <= 0) return line
    const key = t.slice(0, eq)
    const value = zhMap.get(key) ?? t.slice(eq + 1)
    // 初翻常见的格式码切断（`§e§ ` 这类）在落盘前就修掉，
    // 避免产出会被闸门拦下的文件。
    return `${key}=${repairMalformedSections(value).text}`
  })
  const header = `#shaders/lang/zh_CN.lang\n# ${entry.title ?? entry.id} v${shaderVersion} 简体中文翻译（AI 初翻，未人工校对）\n# 源文件：${sourceFileName} 的 ${enName}\n`
  const outPath = join(LANG_DIR, entry.id, shaderVersion, 'zh_CN.lang')

  // 先校验内存里的内容，通过后才落盘。
  // 历史实现是「先写文件再校验」，校验失败时已把坏文件留在磁盘上。
  const verdict = validatePair(enText, header + outLines.join('\n'), `${entry.id}/${shaderVersion}`)
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
  writeFileSync(outPath, header + outLines.join('\n'))

  // 同时缓存英文原文到 sources/，供 pack-lang-sources.mjs 重新打包。
  // 否则新翻译的光影在 CI 里找不到英文源，下一次 validate:lang 会判失败。
  const enCachePath = join(SOURCES_DIR, entry.id, shaderVersion, 'en_US.lang')
  mkdirSync(dirname(enCachePath), { recursive: true })
  writeFileSync(enCachePath, enText)

  let shaderEntry = db.shaders.find((s) => s.id === entry.id)
  if (!shaderEntry) {
    shaderEntry = entry.source === 'curseforge'
      ? buildShaderEntry({ source: 'curseforge', slug: entry.id, cfId: entry.curseforge?.cfId })
      : buildShaderEntry({ modrinth: { slug: entry.id, projectId: entry.projectId } })
    db.shaders.push(shaderEntry)
  }
  shaderEntry.langVersions = shaderEntry.langVersions ?? []
  shaderEntry.langVersions.unshift({
    shaderVersion,
    langVersion: '1.0.0',
    file: `/lang/${entry.id}/${shaderVersion}/zh_CN.lang`,
    quark: '',
    updatedAt: new Date().toISOString().slice(0, 10),
    contributors: [`AI 初翻（免费模型池：${LLM_MODELS.join(' / ')}），未人工校对`],
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

/**
 * 固定并发度的 worker pool。concurrency = 1 时与改造前的串行 for 完全等价。
 * queue.shift() 与空值判断之间没有 await，单线程下不会把同一条派发给两个 worker。
 */
async function runPool(items, worker, concurrency) {
  const queue = [...items]
  const workers = Math.min(concurrency, queue.length)
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const entry = queue.shift()
      if (!entry) return
      await worker(entry)
    }
  }))
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
