/**
 * Cloudflare Worker: 光影汉化请求代理 + 翻译队列。
 *
 * 职责：
 * 1. POST /          玩家提交 Modrinth 链接 → 解析并校验 → 写 KV（权威）+ 腾讯文档（尽力镜像）
 * 2. GET  /queue     返回全部队列条目，供站点轮询
 * 3. POST /translate 口令校验 → 取全部「待翻译」→ 触发 GitHub Actions → 置「翻译中」
 * 4. POST /status    Actions 回写单条状态（内部 token）→ 更新 KV + 尽力镜像腾讯文档
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
} from '../shared/tencent-docs.mjs'

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
    return json({ error: 'Modrinth 链接为必填' }, 400, origin)
  }

  const slug = parseModrinthSlug(url)
  if (!slug) {
    return json({ error: '请填写有效的 Modrinth 光影链接（https://modrinth.com/shader/...）' }, 400, origin)
  }

  const resolved = await resolveModrinthProject(slug)
  if (resolved.error === 'not_found') {
    return json({ error: 'Modrinth 上找不到该项目，请检查链接' }, 400, origin)
  }
  if (resolved.error === 'not_shader') {
    return json({ error: `该链接是 ${resolved.projectType}，不是光影项目` }, 400, origin)
  }
  if (resolved.error === 'upstream') {
    return json({ error: 'Modrinth 暂时不可用，请稍后重试' }, 502, origin)
  }

  const project = resolved.project
  const now = new Date().toISOString()
  const existing = await readEntry(env, project.id)

  // 去重：同一光影已入队则只更新时间，不重复登记（不足 M8）
  const entry = existing
    ? { ...existing, updatedAt: now, name: project.title, url: project.pageUrl }
    : {
        id: project.id,
        projectId: project.projectId,
        name: project.title,
        url: project.pageUrl,
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

  // 腾讯文档仅作尽力镜像；失败不影响返回成功
  const mirrored = await mirrorToTencentDocs(env, entry, note || (existing ? '重复提交' : ''))

  return json(
    {
      success: true,
      message: existing ? '该光影已在翻译队列中，我们已更新你的请求。' : '提交成功！我们会尽快处理你的请求。',
      id: entry.id,
      status: entry.status,
      mirrored,
    },
    200,
    origin,
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

  const index = await readIndex(env)
  const entries = (await Promise.all(index.map((id) => readEntry(env, id)))).filter(Boolean)
  const pending = entries.filter((e) => e.status === STATUS.PENDING)

  if (!pending.length) {
    return json({ success: true, triggered: false, message: '没有待翻译的条目', ids: [] }, 200, origin)
  }

  const ids = pending.map((e) => e.id)

  if (!env.GITHUB_PAT) {
    return json({ error: '服务配置错误：缺少 GITHUB_PAT' }, 500, origin)
  }
  const repo = env.GITHUB_REPO || 'Kalloer1/shader-i18n-site'
  const workflow = env.GITHUB_WORKFLOW_FILE || 'translate.yml'

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
      body: JSON.stringify({ ref: 'main', inputs: { ids: ids.join(',') } }),
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
    pending.map((e) => writeEntry(env, { ...e, status: STATUS.TRANSLATING, updatedAt: now, error: '' })),
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
