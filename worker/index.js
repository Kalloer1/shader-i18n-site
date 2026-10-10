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

  const { name, url, contact, note } = body
  if (!name || !url) {
    return json({ error: '光影名称和 Modrinth 链接为必填' }, 400, origin)
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
    ? { ...existing, updatedAt: now, name: name || existing.name, url: project.pageUrl }
    : {
        id: project.id,
        projectId: project.projectId,
        name: name || project.title,
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
        baidu: '',
        note: '',
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
  return json({ success: true, count: entries.length, entries: entries.filter(Boolean) }, 200, origin)
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
    baidu: body.baidu ?? existing.baidu,
  }

  await writeEntry(env, entry)
  const mirrored = await mirrorToTencentDocs(env, entry, entry.error)

  return json({ success: true, id: entry.id, status: entry.status, mirrored }, 200, origin)
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
