/**
 * Cloudflare Worker: 光影汉化请求代理 + 翻译队列。
 *
 * 职责：
 * 1. POST /          玩家提交光影链接（Modrinth 或 CurseForge）→ 解析并校验 → 写 KV（权威）+ 腾讯文档（尽力镜像）
 * 2. GET  /queue     返回全部队列条目，供站点轮询
 * 3. POST /translate 口令校验 → 取全部「待翻译」（body.retryFailed=true 时并含「失败」）
 *    → 触发 GitHub Actions → 置「翻译中」
 * 4. POST /status    Actions 回写单条状态（内部 token）→ 更新 KV + 尽力镜像腾讯文档
 * 5. GET  /models    代理网关 /models，返回当前可用模型 id 列表（公开；不含秘密）
 * 6. POST /verify-passphrase 仅校验 /translate 口令，供 /request 页门禁渲染模型多选
 *
 * 状态权威源是 KV；腾讯文档只作为「尽力而为」的镜像，任何失败都不阻断主流程。
 *
 * 环境变量（Worker Secrets / vars）：
 * - TENCENT_DOCS_TOKEN       腾讯文档 API token（缺失则跳过镜像）
 * - TRANSLATE_PASSPHRASE     /translate 口令
 * - INTERNAL_STATUS_TOKEN    /status 内部 token
 * - GITHUB_PAT               仅需本仓库 actions: write
 * - GITHUB_REPO              "owner/repo"，默认 Kall oer1/shader-i18n-site（见 wrangler.toml vars）
 * - GITHUB_WORKFLOW_FILE     workflow 文件名，默认 translate.yml
 * - BREVO_API_KEY            Brevo 发信 API key（Worker secret；缺失则跳过通知）
 * - EMAIL_FROM               发信地址（Worker secret，公开仓库禁写 wrangler.toml）
 * - NOTIFY_ENABLED           "1"/"0"（wrangler.toml [vars]，一键停发，不敏感）
 * - SUBMIT_LIMIT_PER_DAY     每 IP 每天「新增提交」上限（wrangler.toml [vars]，缺失/解析失败回退 3）
 * - LLM_BASE_URL             网关地址（默认 https://api.888424.xyz/v1，与 GitHub secret 同源）
 * - LLM_API_KEY              网关 API key（Worker secret，经 sync-worker-secrets.yml 同步）
 *
 * KV binding: TRANSLATION_QUEUE
 */
import {
  TENCENT_MCP_URL,
  TENCENT_FILE_ID,
  TENCENT_SHEET_ID,
  STATUS,
  SOURCE,
  buildFieldValues,
  parseModrinthSlug,
  parseCurseforgeSlug,
} from '../shared/tencent-docs.mjs'
import {
  DEFAULT_SUBMIT_LIMIT_PER_DAY,
  SUBMIT_LIMIT_TTL_SECONDS,
  parseSubmitLimit,
  submitLimit,
  shouldCountSubmit,
  submitDayKey,
  clientIp,
} from '../shared/submit-limit.mjs'

const MODRINTH_API = 'https://api.modrinth.com/v2'
const UA = 'shader-i18n-site/0.2.0 (request worker)'

const INDEX_KEY = 'queue:index'
const QUEUE_PREFIX = 'queue:'
const MAX_INDEX = 500

// CORS 白名单：pages.dev 生产域 + 本地开发 + Pages 预览域（预览域名形如
// shader-i18n-site-<hash>.pages.dev 或 <branch>.shader-i18n-site.pages.dev）
const ALLOWED_ORIGINS_EXACT = [
  'https://shader-i18n-site.pages.dev',
  'https://shader.mccnp.top',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/[a-z0-9-]+\.shader-i18n-site\.pages\.dev$/,
  /^https:\/\/shader-i18n-site(?:-[a-z0-9]+)?\.pages\.dev$/,
]

function isAllowedOrigin(origin) {
  if (!origin) return false
  if (ALLOWED_ORIGINS_EXACT.includes(origin)) return true
  return ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin))
}

function corsHeaders(origin) {
  const allowed = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS_EXACT[0]
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Passphrase, X-Internal-Token',
    Vary: 'Origin',
  }
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin) },
  })
}

// ---------- 网关模型列表（实时拉取） ----------
// 模型列表来自管理员自己的中转网关（OpenAI 兼容 /models），不是写死的策展清单：
// 管理员会实时增删模型，写死列表必然过时。Worker 用 LLM_BASE_URL / LLM_API_KEY
// （与 GitHub secret 同源，经 sync-worker-secrets.yml 同步）代理该请求，
// 这样浏览器端永远接触不到网关 key。

const DEFAULT_LLM_BASE_URL = 'https://api.888424.xyz/v1'

async function fetchGatewayModels(env) {
  const base = (env.LLM_BASE_URL || DEFAULT_LLM_BASE_URL).replace(/\/+$/, '')
  const key = env.LLM_API_KEY
  if (!key) return { error: '缺少 LLM_API_KEY（服务配置错误）' }
  let res
  try {
    res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}`, 'User-Agent': UA },
    })
  } catch (err) {
    console.error('gateway /models fetch failed:', err?.message ?? err)
    return { error: '模型网关不可达' }
  }
  if (!res.ok) {
    return { error: `模型网关返回 ${res.status}` }
  }
  const data = await res.json().catch(() => null)
  const models = Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter(Boolean) : []
  return { models }
}

// ---------- 免费层（bilibili Index-Translate）模型探测 ----------
// 免费层是**独立于网关**的另一层，它的模型不在网关 /models 里。
// 为什么要探而不是写死：服务方随时增删模型，且 2026-10-19 起 35B 持续 504 而
// syllable 存活——写死列表会让管理员选中一个必然失败的模型。
//
// ⚠️ 探测必须**发真实请求**，不能用 /health 或 /v1/models（2026-10-20 实测）：
// - `/health` 只报主模型与内部 checkpoint，**根本不列 syllable 系列**；
// - `/v1/models` 同样只列 `Index-Translate-35B-A3B`；
// - 而 35B 在 /health 里是 true、在 /v1/models 里也有，**实际却持续 504**。
// 即两个元数据端点既不完整也不准确。唯一可靠判据是「拿一句话真的翻一次」。
//
// 公开模型名不随元数据走，改为常量表；表里没有的新模型靠错误信息发现
// （错模型名会 400 并列出全部公开模型，见 /v1/chat/completions 的 detail）。
const DEFAULT_FREE_TIER_BASE = 'https://index-translate.bilibili.com'
const FREE_TIER_CANDIDATES = [
  'Index-Translate-35B-A3B',
  'index-mt-2b',
  'index-mt-9b',
  'index-mt-2b-syllable',
  'index-mt-9b-syllable',
]
// 探测请求：短、快、失败即判死。8 秒足够——实测死模型要么 30 秒 504，要么秒回 500。
const FREE_TIER_PROBE_TIMEOUT_MS = 8000
const FREE_TIER_PROBE_PROMPT = '请将以下文本翻译为简体中文，直接输出翻译结果，不要保留英文原文，不要进行任何解释。\n\nShadow Strength'

/**
 * 判定一次探测回话是否算「模型活着」。
 *
 * 必须有中文：回显英文说明模型没在翻译（或已被替换成别的东西）。
 * 纯函数，供离线单测覆盖（worker 顶层依赖 Cloudflare 绑定，无法整体 import）。
 */
export function isFreeTierProbeAlive(status, data) {
  if (status !== 200) return false
  const text = data?.choices?.[0]?.message?.content
  return Boolean(text) && /[一-鿿]/.test(text)
}

async function probeFreeTierModel(base, model) {
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      signal: AbortSignal.timeout(FREE_TIER_PROBE_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: FREE_TIER_PROBE_PROMPT }],
        temperature: 0,
        max_tokens: 64,
        stream: false,
        chat_template_kwargs: { enable_thinking: false },
      }),
    })
    const data = await res.json().catch(() => null)
    return isFreeTierProbeAlive(res.status, data)
  } catch {
    // 超时 / 网络错误一律判死：无 SLA 的公开服务，探不到就当不可用。
    return false
  }
}

async function fetchFreeTierModels(env) {
  const base = (env.FREE_TIER_BASE_URL || DEFAULT_FREE_TIER_BASE).replace(/\/+$/, '').replace(/\/v1$/, '')
  // 并行探测：串行最坏要 5×8 秒，会把整个模型列表拖慢。
  const results = await Promise.all(
    FREE_TIER_CANDIDATES.map(async (m) => [m, await probeFreeTierModel(base, m)]),
  )
  const models = results.filter(([, ok]) => ok).map(([m]) => m).sort()
  // 全挂时**不报错**：免费层本就是无 SLA 的公开服务，整组不可用是正常状态，
  // 前端只显示网关模型即可（与「探测失败优雅降级」同一原则）。
  return { models }
}

/** GET /models —— 公开返回可用模型：网关模型 + 免费层模型（不含任何秘密） */
async function handleModels(env, origin) {
  const { models, error } = await fetchGatewayModels(env)
  if (error) return json({ success: false, error }, 502, origin)
  // 免费层探测失败**不影响**网关模型返回：只是少一组选项，不报错。
  const free = await fetchFreeTierModels(env)
  return json({ success: true, models, freeTierModels: free.models, freeTierError: free.error }, 200, origin)
}

/** POST /verify-passphrase —— 仅校验口令，供 /request 页门禁渲染模型多选 */
async function handleVerifyPassphrase(request, env, origin) {
  const passphrase = request.headers.get('X-Passphrase') || ''
  const expected = env.TRANSLATE_PASSPHRASE
  if (!expected) return json({ error: '服务配置错误：缺少 TRANSLATE_PASSPHRASE' }, 500, origin)
  if (passphrase !== expected) return json({ error: '口令不正确' }, 401, origin)
  return json({ success: true }, 200, origin)
}

// ---------- KV 队列 ----------

async function readIndex(env) {
  const raw = await env.TRANSLATION_QUEUE.get(INDEX_KEY, 'json')
  return Array.isArray(raw) ? raw : []
}

async function writeIndex(env, ids) {
  await env.TRANSLATION_QUEUE.put(INDEX_KEY, JSON.stringify(ids.slice(0, MAX_INDEX)))
}

async function readEntry(env, id) {
  return env.TRANSLATION_QUEUE.get(QUEUE_PREFIX + id, 'json')
}

async function writeEntry(env, entry) {
  await env.TRANSLATION_QUEUE.put(QUEUE_PREFIX + entry.id, JSON.stringify(entry))
}

/** 腾讯文档镜像：任何失败都只记录日志，不抛出、不影响主流程。 */
async function mirrorToTencentDocs(env, entry, note) {
  const token = env.TENCENT_DOCS_TOKEN
  if (!token) return false
  try {
    const res = await fetch(TENCENT_MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'smartsheet.add_records',
        params: {
          file_id: TENCENT_FILE_ID,
          sheet_id: TENCENT_SHEET_ID,
          records: [
            {
              field_values: buildFieldValues({
                title: entry.name || entry.id,
                url: entry.url,
                source: entry.source,
                status: entry.status,
                note,
                timestamp: Date.parse(entry.submittedAt) || Date.now(),
              }),
            },
          ],
        },
        id: 1,
      }),
    })
    const result = await res.json()
    if (result.error) {
      console.warn('Tencent Docs mirror error (ignored):', JSON.stringify(result.error))
      return false
    }
    return true
  } catch (err) {
    // 腾讯文档读/改 API 未验证，写入失败是预期内的可接受降级。
    console.warn('Tencent Docs mirror failed (ignored):', err?.message ?? err)
    return false
  }
}

// ---------- 完成通知（Brevo 邮件） ----------
// 状态从非完成翻转到完成时发一次；任何失败只记日志，不回滚状态、不影响返回
// （同镜像降级风格）。KV 中只存邮箱哈希，绝不存明文邮箱：
// hash = sha256(INTERNAL_STATUS_TOKEN + "|" + 小写邮箱)，盐复用已有 secret，不新增。
function isDoneStatus(s) {
  return s === STATUS.DONE || s === STATUS.DONE_UNMIRRORED
}

function isValidEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v || '')
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function notifyEmailHash(email, salt) {
  return sha256Hex(`${salt}|${email.trim().toLowerCase()}`)
}

async function notifyHmac(email, key) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(email.trim().toLowerCase()))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function sendBrevoEmail({ apiKey, from, to, subject, text }) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify({ sender: { email: from }, to: [{ email: to }], subject, textContent: text }),
  })
  if (!res.ok) {
    throw new Error(`Brevo rejected (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
}

/**
 * 把发信结果写回队列条目（notifyError / notifiedAt）。
 * 只改这两个字段，绝不改 status；记录本身失败也只 warn，不影响 /status 返回。
 */
async function recordNotifyOutcome(env, entry, patch) {
  Object.assign(entry, patch)
  try {
    await writeEntry(env, entry)
  } catch (err) {
    console.warn('notify outcome record failed (ignored):', err?.message ?? err)
  }
}

/** 状态从非完成翻转到完成时发一次；掉出完成态则删去重键以便下次重发。整体 try/catch，失败只 warn。 */
async function maybeNotifyPlayer(env, entry, existing, request) {
  try {
    const wasDone = isDoneStatus(existing?.status)
    const isDone = isDoneStatus(entry?.status)
    const sentKey = `notify:sent:${entry.id}`
    if (wasDone && !isDone) {
      // 掉出完成态（如重翻失败）：删去重键，重译完成时才能再通知
      try {
        await env.TRANSLATION_QUEUE.delete(sentKey)
      } catch (err) {
        console.warn('notify dedup unlock failed (ignored):', err?.message ?? err)
      }
      return
    }
    if (!isDone || wasDone) return // 仅「非完成 → 完成」的翻转继续
    if (env.NOTIFY_ENABLED === '0') return // 一键停发
    const contact = (entry.contact || '').trim()
    if (!isValidEmail(contact)) return // 为空或 QQ 号等非邮箱格式：跳过
    const apiKey = env.BREVO_API_KEY
    const from = env.EMAIL_FROM
    if (!apiKey || !from) {
      console.warn('notify skipped (ignored): 缺少 BREVO_API_KEY / EMAIL_FROM')
      return
    }
    const salt = env.INTERNAL_STATUS_TOKEN
    if (!salt) {
      console.warn('notify skipped (ignored): 缺少 INTERNAL_STATUS_TOKEN（哈希盐）')
      return
    }
    if (await env.TRANSLATION_QUEUE.get(sentKey)) return // 已通知过
    const hash = await notifyEmailHash(contact, salt)
    if (await env.TRANSLATION_QUEUE.get(`notify:block:${hash}`)) return // 已退订
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const limitKey = `notify:limit:${hash}:${today}`
    const used = Number((await env.TRANSLATION_QUEUE.get(limitKey)) || 0)
    if (used >= 3) {
      console.warn('notify skipped (ignored): 同一邮箱今日已达上限')
      return
    }
    const workerOrigin = new URL(request.url).origin
    const token = await notifyHmac(contact, salt)
    const unsub = `${workerOrigin}/unsubscribe?e=${encodeURIComponent(contact)}&t=${token}`
    const title = entry.name || entry.id
    const text =
      `你请求的光影「${title}」状态已更新为：${entry.status}\n` +
      `页面链接：${entry.url || ''}\n` +
      `不再接收此类通知？退订：${unsub}\n`
    await sendBrevoEmail({ apiKey, from, to: contact, subject: `【光影汉化】${title} 已完成`, text })
    await env.TRANSLATION_QUEUE.put(sentKey, '1')
    await env.TRANSLATION_QUEUE.put(limitKey, String(used + 1), { expirationTtl: 172800 })
    // 发信成功：清掉上次的失败原因，并记下成功时间
    await recordNotifyOutcome(env, entry, { notifyError: '', notifiedAt: new Date().toISOString() })
  } catch (err) {
    // 发信失败绝不回滚状态、绝不影响 /status 返回；但必须记进队列条目，
    // 否则「玩家没收到信」只能靠玩家自己发现（Brevo 401 曾被完全吞掉）。
    const reason = String(err?.message ?? err)
    console.warn('notify failed (recorded):', reason)
    await recordNotifyOutcome(env, entry, { notifyError: reason.slice(0, 200) })
  }
}

/** GET /unsubscribe?e=<邮箱>&t=<hmac> —— 通过则写 block 键，回纯文本 */
async function handleUnsubscribe(url, env, origin) {
  const headers = { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders(origin) }
  try {
    const email = (url.searchParams.get('e') || '').trim()
    const token = url.searchParams.get('t') || ''
    const salt = env.INTERNAL_STATUS_TOKEN
    if (!isValidEmail(email) || !token || !salt) {
      return new Response('退订链接无效', { status: 400, headers })
    }
    const expected = await notifyHmac(email, salt)
    if (token !== expected) {
      return new Response('退订链接无效', { status: 400, headers })
    }
    const hash = await notifyEmailHash(email, salt)
    await env.TRANSLATION_QUEUE.put(`notify:block:${hash}`, '1')
    return new Response('已退订该邮箱的完成通知。', { status: 200, headers })
  } catch (err) {
    console.error('unsubscribe error:', err)
    return new Response('服务器内部错误', { status: 500, headers })
  }
}

// ---------- Modrinth 解析 ----------

/**
 * 用 Modrinth API 解析 slug → 项目信息。
 * 提交时即校验，非法链接当场 400，避免污染队列。
 */
async function resolveModrinthProject(slug) {
  const res = await fetch(`${MODRINTH_API}/project/${encodeURIComponent(slug)}`, {
    headers: { 'User-Agent': UA },
  })
  if (res.status === 404) return { error: 'not_found' }
  if (!res.ok) return { error: 'upstream', status: res.status }
  const project = await res.json()
  if (project?.project_type && project.project_type !== 'shader') {
    return { error: 'not_shader', projectType: project.project_type }
  }
  return {
    project: {
      id: project.slug ?? slug,
      projectId: project.id,
      title: project.title ?? slug,
      pageUrl: `https://modrinth.com/shader/${project.slug ?? slug}`,
    },
  }
}

// ---------- 路由处理 ----------

/** POST / —— 玩家提交翻译请求 */
async function handleSubmit(request, env, origin) {
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return json({ error: '请求体不是合法 JSON' }, 400, origin)
  }

  const { url, contact, note } = body
  if (!url) {
    return json({ error: '光影链接为必填' }, 400, origin)
  }

  // 先按 Modrinth 解析（原行为不变）；失败再试 CurseForge；两者都不认才 400。
  // CF 侧不在提交时调 CF API 校验：那需要给 Worker 加 CF key（增加维护面），
  // 项目名与合法性交由 pipeline 的 CF 分支处理。
  const modrinthSlug = parseModrinthSlug(url)
  let target
  if (modrinthSlug) {
    const resolved = await resolveModrinthProject(modrinthSlug)
    if (resolved.error === 'not_found') {
      return json({ error: 'Modrinth 上找不到该项目，请检查链接' }, 400, origin)
    }
    if (resolved.error === 'not_shader') {
      return json({ error: `该链接是 ${resolved.projectType}，不是光影项目` }, 400, origin)
    }
    if (resolved.error === 'upstream') {
      return json({ error: 'Modrinth 暂时不可用，请稍后重试' }, 502, origin)
    }
    target = {
      id: resolved.project.id,
      projectId: resolved.project.projectId,
      name: resolved.project.title,
      url: resolved.project.pageUrl,
      platform: 'modrinth',
    }
  } else {
    const cfSlug = parseCurseforgeSlug(url)
    if (!cfSlug) {
      return json({ error: '请填写有效的光影链接（Modrinth 或 CurseForge）' }, 400, origin)
    }
    // id 与 name 都用 slug：name 留待 pipeline 从 CF 取回项目名后补全。
    target = { id: cfSlug, name: cfSlug, url, platform: 'curseforge' }
  }

  const now = new Date().toISOString()
  const existing = await readEntry(env, target.id)

  // 每 IP 每天「新增提交」限流：只统计新增（同一 id 已入队 → 重复提交不计数）。
  // 只存 IP 哈希（sha256(INTERNAL_STATUS_TOKEN + '|' + ip)），绝不存原始 IP；
  // 无 IP / 缺盐时降级为不限流。上限见 SUBMIT_LIMIT_PER_DAY，缺失/解析失败回退 3。
  // 所有请求一律计数（无管理员豁免）。
  let remainingToday = null
  let limitKey = null
  let usedToday = 0
  let limitPerDay = DEFAULT_SUBMIT_LIMIT_PER_DAY
  if (shouldCountSubmit(existing)) {
    const { ip } = clientIp(request)
    if (ip) {
      const salt = env.INTERNAL_STATUS_TOKEN
      if (!salt) {
        console.warn('::warning:: 缺少 INTERNAL_STATUS_TOKEN，本次提交跳过 IP 限流')
      } else {
        const hash = await sha256Hex(`${salt}|${ip}`)
        limitKey = submitDayKey(new Date(), hash)
        usedToday = Number((await env.TRANSLATION_QUEUE.get(limitKey)) || 0)
        limitPerDay = parseSubmitLimit(env.SUBMIT_LIMIT_PER_DAY)
        const decision = submitLimit(usedToday, limitPerDay)
        if (!decision.allowed) {
          return json(
            { error: `今日提交次数已达上限（${limitPerDay} 次/天），请明天再试` },
            429,
            origin,
          )
        }
      }
    } else {
      console.warn('::warning:: 无法获取客户端 IP（无 CF-Connecting-IP 且无 X-Forwarded-For），本次提交不限流')
    }
  }

  // 去重：同一光影已入队则只更新时间，不重复登记（不足 M8）
  const entry = existing
    ? { ...existing, updatedAt: now, name: target.name, url: target.url, platform: target.platform }
    : {
        id: target.id,
        ...(target.projectId ? { projectId: target.projectId } : {}),
        name: target.name,
        url: target.url,
        platform: target.platform,
        source: SOURCE.PLAYER,
        status: STATUS.PENDING,
        submittedAt: now,
        updatedAt: now,
        attempts: 0,
        error: '',
        langPath: '',
        shaderVersion: '',
        quark: '',
        contact: contact || '',
        note: note || '',
      }

  await writeEntry(env, entry)

  if (!existing) {
    const index = await readIndex(env)
    if (!index.includes(entry.id)) {
      index.unshift(entry.id)
      await writeIndex(env, index)
    }
  }

  // 新增提交成功写入后才计数（写库失败不会消耗当日额度）
  if (limitKey) {
    const nextUsed = usedToday + 1
    await env.TRANSLATION_QUEUE.put(limitKey, String(nextUsed), { expirationTtl: SUBMIT_LIMIT_TTL_SECONDS })
    remainingToday = Math.max(0, limitPerDay - nextUsed)
  }

  // 腾讯文档仅作尽力镜像；失败不影响返回成功
  const mirrored = await mirrorToTencentDocs(env, entry, note || (existing ? '重复提交' : ''))

  return json(
    {
      success: true,
      message: existing ? '该光影已在翻译队列中，我们已更新你的请求。' : '提交成功！我们会尽快处理你的请求。',
      id: entry.id,
      status: entry.status,
      mirrored,
      remainingToday,
    },
    200,
    origin,
  )
}

/**
 * 选取本次要触发的条目（纯函数，便于直接单测）。
 *
 * - 默认只取「待翻译」。**不**默认重跑「失败」条目：否则每次点「开始翻译」
 *   都会把历史失败项再烧一遍翻译额度，必须由调用方显式要求。
 * - retryFailed 为 true（管理区「重试失败的光影」入口）时，额外取「失败」条目。
 * - 「翻译中」永不入选：可能真有 workflow 在跑，重复触发会并发烧预算。
 *
 * @param {Array<{ id: string, status: string }>} entries
 * @param {{ retryFailed?: boolean }} [options]
 * @returns {Array<{ id: string, status: string }>}
 */
export function selectTranslateTargets(entries, { retryFailed = false } = {}) {
  return entries.filter(
    (e) => e.status === STATUS.PENDING || (retryFailed && e.status === STATUS.FAILED),
  )
}

/** GET /queue —— 队列全量（供站点轮询） */
async function handleQueue(env, origin) {
  const index = await readIndex(env)
  const entries = await Promise.all(index.map((id) => readEntry(env, id)))
  const list = entries.filter(Boolean)
  // 公开端点只暴露「是否已成功发信」的布尔；notifyError 属内部细节，不外泄。
  const PUBLIC = ({ contact: _dropped, notifyError: _internal, notifiedAt, ...rest }) => ({
    ...rest,
    notified: Boolean(notifiedAt),
  })
  return json({ success: true, count: list.length, entries: list.map(PUBLIC) }, 200, origin)
}

/** POST /translate —— 口令校验后触发 GitHub Actions */
async function handleTranslate(request, env, origin) {
  const passphrase = request.headers.get('X-Passphrase') || ''
  const expected = env.TRANSLATE_PASSPHRASE
  if (!expected) {
    return json({ error: '服务配置错误：缺少 TRANSLATE_PASSPHRASE' }, 500, origin)
  }
  if (passphrase !== expected) {
    return json({ error: '口令不正确' }, 401, origin)
  }

  // 可选 models：来自 /request 管理区的模型多选（口令门禁后）。
  // 必须命中网关实时列表（白名单校验），绝不允许把任意字符串透传进 workflow。
  // 空选择 / 未传 → 不传 models，由仓库默认值兜底。
  // 网关不可达时宁可 400 拒绝，也不能跳过校验透传。
  let modelsInput = ''
  const body = await request.json().catch(() => null)
  const rawModels = body && body.models != null ? body.models : null
  if (rawModels != null) {
    const candidate = (Array.isArray(rawModels) ? rawModels : String(rawModels).split(','))
      .map((s) => String(s).trim())
      .filter(Boolean)
    if (candidate.length) {
      const { models: available, error } = await fetchGatewayModels(env)
      if (error) {
        return json({ error: `无法校验模型列表：${error}` }, 400, origin)
      }
      // 免费层模型不在网关列表里，单独校验。**探测失败时按"不可用"处理**：
      // 宁可拒绝，也不要把一个现在调不通的模型透传进 workflow 烧一轮预算。
      const { models: freeAvailable } = await fetchFreeTierModels(env)
      const gatewaySet = new Set(available)
      const freeSet = new Set(freeAvailable)
      const invalid = candidate.filter((m) => !gatewaySet.has(m) && !freeSet.has(m))
      if (invalid.length) {
        return json({
          error: `以下模型不在可用列表中（网关与免费层均未提供）：${invalid.join(', ')}`,
        }, 400, origin)
      }
      modelsInput = candidate.join(',')
    }
  }

  // 可选 retryFailed：管理区显式勾选「重试失败的光影」时，本次额外收集「失败」条目。
  // 必须是显式布尔 true —— 缺省不重跑失败项，避免每次点击都重复消耗翻译额度。
  const retryFailed = body?.retryFailed === true

  const index = await readIndex(env)
  const entries = (await Promise.all(index.map((id) => readEntry(env, id)))).filter(Boolean)
  const targets = selectTranslateTargets(entries, { retryFailed })

  if (!targets.length) {
    return json(
      {
        success: true,
        triggered: false,
        message: retryFailed ? '没有待翻译或失败的条目' : '没有待翻译的条目',
        ids: [],
      },
      200,
      origin,
    )
  }

  const ids = targets.map((e) => e.id)

  if (!env.GITHUB_PAT) {
    return json({ error: '服务配置错误：缺少 GITHUB_PAT' }, 500, origin)
  }
  const repo = env.GITHUB_REPO || 'Kalloer1/shader-i18n-site'
  const workflow = env.GITHUB_WORKFLOW_FILE || 'translate.yml'

  const inputs = { ids: ids.join(',') }
  if (modelsInput) inputs.models = modelsInput

  const dispatch = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': UA,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs }),
    },
  )

  if (!dispatch.ok) {
    const detail = (await dispatch.text()).slice(0, 300)
    console.error('workflow_dispatch failed:', dispatch.status, detail)
    return json({ error: '触发翻译失败，请稍后重试', detail }, 502, origin)
  }

  // dispatch 已成功，立即置为「翻译中」，避免重复点击导致重复触发
  const now = new Date().toISOString()
  await Promise.all(
    targets.map((e) => writeEntry(env, { ...e, status: STATUS.TRANSLATING, updatedAt: now, error: '' })),
  )

  return json({ success: true, triggered: true, ids, count: ids.length }, 200, origin)
}

/** POST /status —— Actions 回写单条状态 */
async function handleStatus(request, env, origin) {
  const token = request.headers.get('X-Internal-Token') || ''
  if (!env.INTERNAL_STATUS_TOKEN) {
    return json({ error: '服务配置错误：缺少 INTERNAL_STATUS_TOKEN' }, 500, origin)
  }
  if (token !== env.INTERNAL_STATUS_TOKEN) {
    return json({ error: '未授权' }, 401, origin)
  }

  const body = await request.json().catch(() => null)
  if (!body || !body.id || !body.status) {
    return json({ error: 'id 与 status 为必填' }, 400, origin)
  }

  const validStatuses = Object.values(STATUS)
  if (!validStatuses.includes(body.status)) {
    return json({ error: `status 必须是 ${validStatuses.join(' / ')} 之一` }, 400, origin)
  }

  const existing = await readEntry(env, body.id)
  if (!existing) {
    return json({ error: `队列中没有 ${body.id}` }, 404, origin)
  }

  const entry = {
    ...existing,
    status: body.status,
    updatedAt: new Date().toISOString(),
    attempts: Number.isFinite(body.attempts) ? body.attempts : existing.attempts,
    error: typeof body.error === 'string' ? body.error.slice(0, 500) : existing.error,
    note: typeof body.note === 'string' ? body.note.slice(0, 500) : existing.note,
    langPath: body.langPath ?? existing.langPath,
    shaderVersion: body.shaderVersion ?? existing.shaderVersion,
    quark: body.quark ?? existing.quark,
  }

  await writeEntry(env, entry)
  const mirrored = await mirrorToTencentDocs(env, entry, entry.error)
  // 翻转到完成即通知玩家；内部整体 try/catch，失败不影响本次返回
  await maybeNotifyPlayer(env, entry, existing, request)

  return json(
    {
      success: true,
      id: entry.id,
      status: entry.status,
      mirrored,
      // 内部端点回显发信结果，便于运维发现「状态已完成但邮件没发出去」
      notifyError: entry.notifyError || '',
      notifiedAt: entry.notifiedAt || '',
    },
    200,
    origin,
  )
}

// ---------- 入口 ----------

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || ''

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) })
    }

    if (!env.TRANSLATION_QUEUE) {
      return json({ error: '服务配置错误：缺少 TRANSLATION_QUEUE KV 绑定' }, 500, origin)
    }

    const { pathname } = new URL(request.url)

    try {
      if (pathname === '/' || pathname === '') {
        if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin)
        return await handleSubmit(request, env, origin)
      }

      if (pathname === '/queue') {
        if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, origin)
        return await handleQueue(env, origin)
      }

      if (pathname === '/models') {
        if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, origin)
        return await handleModels(env, origin)
      }

      if (pathname === '/verify-passphrase') {
        if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin)
        return await handleVerifyPassphrase(request, env, origin)
      }

      if (pathname === '/translate') {
        if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin)
        return await handleTranslate(request, env, origin)
      }

      if (pathname === '/unsubscribe') {
        if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, origin)
        return await handleUnsubscribe(new URL(request.url), env, origin)
      }

      if (pathname === '/status') {
        if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin)
        return await handleStatus(request, env, origin)
      }

      return json({ error: 'Not found' }, 404, origin)
    } catch (err) {
      console.error('Worker error:', err)
      return json({ error: '服务器内部错误' }, 500, origin)
    }
  },
}
