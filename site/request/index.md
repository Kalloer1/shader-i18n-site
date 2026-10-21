---
title: "请求翻译"
description: "提交你想要翻译的 Minecraft 光影包，并查看翻译队列"
layout: page
---

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'

const WORKER_URL = 'https://shader-i18n-api.wqclo.workers.dev'
const POLL_INTERVAL_MS = 15000

/* ---------- 提交表单 ---------- */

const form = ref({ url: '', contact: '', note: '' })
const submitting = ref(false)
const submitted = ref(false)
const error = ref('')

/* 前端只做「看起来是不是这两个站点的光影链接」的宽松预检：
   域名（含/不含 www，http/https 都收）命中 Modrinth 或 CurseForge 即放行。
   刻意不在前端复刻 slug 解析规则：严格的 slug 合法性、项目是否存在、是不是光影项目，
   全部交给 Worker（shared/tencent-docs.mjs 的 parseModrinthSlug / parseCurseforgeSlug
   + Modrinth API），它会给回明确的错误文案。
   取舍：平台规则（分类路径、slug 规则）变动时只需改 Worker 一处，不会出现两处逻辑漂移；
   代价是前端会放过少量「域名对但路径不是光影」的链接，由 Worker 的 400 提示兜住。 */
const SHADER_LINK_HOSTS = new Set([
  'modrinth.com',
  'www.modrinth.com',
  'curseforge.com',
  'www.curseforge.com',
])

function looksLikeShaderLink(raw) {
  let parsed
  try {
    parsed = new URL(String(raw).trim())
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  return SHADER_LINK_HOSTS.has(parsed.hostname.toLowerCase())
}

async function handleSubmit() {
  if (!form.value.url) {
    error.value = '请填写光影链接'
    return
  }
  if (!looksLikeShaderLink(form.value.url)) {
    error.value = '请填写有效的光影链接（Modrinth 或 CurseForge）'
    return
  }

  submitting.value = true
  error.value = ''

  try {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form.value),
    })
    const data = await res.json()
    if (data.success) {
      submitted.value = true
      await loadQueue()
    } else {
      error.value = data.error || '提交失败，请稍后重试'
    }
  } catch {
    error.value = '网络错误，请检查连接后重试'
  } finally {
    submitting.value = false
  }
}

function resetForm() {
  submitted.value = false
  error.value = ''
  form.value = { url: '', contact: '', note: '' }
}

/* ---------- 队列（GET /queue 轮询） ---------- */

const entries = ref([])
const queueLoading = ref(true)
const queueError = ref('')
const lastUpdated = ref('')

async function loadQueue() {
  try {
    const res = await fetch(`${WORKER_URL}/queue`)
    const data = await res.json()
    if (!data.success) throw new Error(data.error || '读取失败')
    entries.value = data.entries ?? []
    queueError.value = ''
    lastUpdated.value = new Date().toLocaleTimeString('zh-CN')
  } catch {
    queueError.value = '队列暂时不可用，稍后会自动重试'
  } finally {
    queueLoading.value = false
  }
}

let timer = null
onMounted(() => {
  loadQueue()
  timer = setInterval(loadQueue, POLL_INTERVAL_MS)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  timer = null
})

const STATUS_META = {
  待翻译: { cls: 'st-pending', label: '待翻译' },
  翻译中: { cls: 'st-running', label: '翻译中' },
  已完成: { cls: 'st-done', label: '已完成' },
  镜像缺失: { cls: 'st-mirror', label: '镜像缺失' },
  失败: { cls: 'st-failed', label: '失败' },
}

function statusMeta(status) {
  return STATUS_META[status] ?? { cls: 'st-unknown', label: status || '未知' }
}

const counts = computed(() => {
  const c = { total: entries.value.length, pending: 0, running: 0, done: 0, failed: 0, autoRetry: 0, manual: 0 }
  for (const e of entries.value) {
    if (e.status === '待翻译') c.pending++
    else if (e.status === '翻译中') c.running++
    else if (e.status === '失败') {
      c.failed++
      /* retry 由 Worker 算好（上限口径只有 Worker 一处）：autoRetry=下次触发会自动带上；
         manual=已达自动重试上限，需人工介入（手动勾「重试失败」仍可强制重试）。 */
      if (e.retry?.autoRetry) c.autoRetry++
      else if (e.retry?.manual) c.manual++
    } else c.done++
  }
  return c
})

const summary = computed(() => {
  const c = counts.value
  const failedNote = c.failed
    ? `（其中 ${c.autoRetry} 条会自动重试，${c.manual} 条需人工介入）`
    : ''
  return `共 ${c.total} 项 · 待翻译 ${c.pending} · 翻译中 ${c.running} · 已完成 ${c.done} · 失败 ${c.failed}${failedNote}`
})

/* ---------- 触发翻译（口令存 sessionStorage，不落 URL） ---------- */

const passphrase = ref('')
const triggering = ref(false)
const triggerMsg = ref('')
const triggerErr = ref('')

/* 失败条目重试：
   - 默认不勾也会自动重试失败项，但 Worker 会封顶（AUTO_RETRY_LIMIT 次），防无限烧预算；
   - 勾选时请求体带 retryFailed=true，**无视次数上限**强制重试（含「需人工介入」的条目）。
   触发成功后自动取消勾选，避免手滑连点重复烧额度。 */
const retryFailed = ref(false)

/* ---------- 模型多选（口令门禁后渲染；选择存 localStorage） ---------- */

const unlocked = ref(false)
const modelList = ref([])
const selectedModels = ref([])
const modelsLoading = ref(false)
const modelsError = ref('')
/* 免费层模型（bilibili Index-Translate）单独一组：它们不在网关 /models 里。
   勾选后由 Worker 分别校验；免费层失败会由流水线自动降级到网关模型，所以可以放心勾。 */
const freeTierModels = ref([])
const freeTierError = ref('')
const lastRefreshedAt = ref('')

const MODELS_STORAGE_KEY = 'translate-selected-models'

async function loadModels() {
  modelsLoading.value = true
  modelsError.value = ''
  freeTierError.value = ''
  try {
    const res = await fetch(`${WORKER_URL}/models`)
    const data = await res.json()
    if (!data.success) throw new Error(data.error || '拉取失败')
    modelList.value = Array.isArray(data.models) ? data.models : []
    freeTierModels.value = Array.isArray(data.freeTierModels) ? data.freeTierModels : []
    // 免费层探测失败不影响网关模型：只提示一句，不阻断选择。
    freeTierError.value = data.freeTierError || ''
    const all = [...modelList.value, ...freeTierModels.value]
    // 上次选择只保留仍在可用列表里的模型，已下线的自动丢弃
    let saved = []
    try {
      const parsed = JSON.parse(localStorage.getItem(MODELS_STORAGE_KEY) || '[]')
      if (Array.isArray(parsed)) saved = parsed
    } catch { /* 忽略损坏的本地存储 */ }
    selectedModels.value = all.filter((m) => saved.includes(m))
    // 无历史选择时默认全选：返回什么就默认用全部（轮班机制下每个模型都会分到约 1/N 段落）
    if (!selectedModels.value.length) selectedModels.value = [...all]
    lastRefreshedAt.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  } catch {
    modelsError.value = '拉取模型列表失败，请稍后重试'
  } finally {
    modelsLoading.value = false
  }
}

function persistModels() {
  localStorage.setItem(MODELS_STORAGE_KEY, JSON.stringify(selectedModels.value))
}

async function verifyPassphrase() {
  /* 口令发送前必须先 trim：粘贴时极易带首尾空格/换行，而 Worker 是精确比对，
     多一个字符就是 401（页面显示「口令不正确」）。trim 后的值才是真正有效的口令。 */
  const value = passphrase.value.trim()
  if (!value) {
    triggerErr.value = '请输入口令'
    return
  }
  modelsLoading.value = true
  triggerErr.value = ''
  triggerMsg.value = ''
  try {
    const res = await fetch(`${WORKER_URL}/verify-passphrase`, {
      method: 'POST',
      headers: { 'X-Passphrase': value },
    })
    if (res.status === 401) {
      triggerErr.value = '口令不正确'
      sessionStorage.removeItem('translate-passphrase')
      unlocked.value = false
      return
    }
    if (!res.ok) {
      triggerErr.value = '验证失败，请稍后重试'
      return
    }
    sessionStorage.setItem('translate-passphrase', value)
    unlocked.value = true
    await loadModels()
  } catch {
    triggerErr.value = '网络错误，请稍后重试'
  } finally {
    modelsLoading.value = false
  }
}

onMounted(async () => {
  passphrase.value = sessionStorage.getItem('translate-passphrase') || ''
  if (passphrase.value) await verifyPassphrase()
})

async function handleTrigger() {
  /* 与 verifyPassphrase 用的是同一个口令，同样先 trim：只改一处会漏。 */
  const value = passphrase.value.trim()
  if (!unlocked.value || !value) {
    triggerErr.value = '请先验证口令'
    return
  }
  triggering.value = true
  triggerErr.value = ''
  triggerMsg.value = ''

  try {
    const res = await fetch(`${WORKER_URL}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Passphrase': value },
      body: JSON.stringify({ models: selectedModels.value, retryFailed: retryFailed.value }),
    })
    const data = await res.json()

    if (res.status === 401) {
      triggerErr.value = '口令不正确'
      sessionStorage.removeItem('translate-passphrase')
      unlocked.value = false
      return
    }
    if (!data.success) {
      triggerErr.value = data.error || '触发失败'
      return
    }

    sessionStorage.setItem('translate-passphrase', value)
    /* 免费层与网关是两条独立路径，提示里必须分开写：
       否则「勾了免费层模型」看起来和网关模型一样，实际作用完全不同。 */
    const gatewayNote = modelList.value.some((m) => selectedModels.value.includes(m))
      ? `网关模型：${selectedModels.value.filter((m) => modelList.value.includes(m)).join(' / ')}`
      : '网关模型：仓库默认'
    const freeNote = data.freeTierModel
      ? `免费层：${data.freeTierModel}${data.freeTierSelectedCount > 1 ? `（勾了 ${data.freeTierSelectedCount} 个，取第一个）` : ''}`
      : '免费层：仓库默认'
    const modelNote = selectedModels.value.length ? `（${gatewayNote}；${freeNote}）` : '（未选择，使用仓库默认模型）'
    const retryNote = retryFailed.value ? '（含强制重试失败项，已重新消耗翻译额度）' : ''
    triggerMsg.value = data.triggered
      ? `已触发 ${data.count} 个光影的翻译${retryNote}${modelNote}，状态会自动刷新`
      : (data.message || '没有待翻译的条目')
    if (data.triggered) retryFailed.value = false
    await loadQueue()
  } catch {
    triggerErr.value = '网络错误，请稍后重试'
  } finally {
    triggering.value = false
  }
}
</script>

<!-- 注意：下方 HTML 块内不能出现「空行 + 4 空格以上缩进」，
     Markdown 会把它当成代码块（VitePress 会渲染出转义后的 <pre>）。
     因此块内用注释行分隔区块，不写空行。 -->
<div class="request-page">
  <header class="request-hero">
    <p class="request-kicker">REQUEST · 翻译工作台</p>
    <h1 class="request-title">请求翻译</h1>
    <p class="request-lead">提交你想要翻译的光影包，或在下方的翻译队列里查看实时进度。</p>
  </header>
  <!-- 成功状态 -->
  <section v-if="submitted" class="request-success" aria-labelledby="submit-success-title">
    <div class="success-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.6 2.6L16 9.5" /></svg>
    </div>
    <h2 id="submit-success-title">提交成功</h2>
    <p>你的翻译请求已收到，我们会尽快处理。</p>
    <p class="success-hint">也可以在下方「翻译队列」里看到它的实时状态。</p>
    <button type="button" class="btn btn-primary" @click="resetForm">继续提交</button>
  </section>
  <!-- 提交表单 -->
  <section v-else class="panel panel--form" aria-labelledby="submit-form-title">
    <h2 id="submit-form-title" class="panel-title">提交新请求</h2>
    <form class="request-form" novalidate @submit.prevent="handleSubmit">
      <div class="form-group">
        <label for="url">Modrinth / CurseForge 光影链接 <span class="required" aria-hidden="true">*</span><span class="sr-only">（必填）</span></label>
        <input id="url" v-model="form.url" type="url" name="url" placeholder="https://modrinth.com/shader/... 或 https://www.curseforge.com/minecraft/shaders/..." autocomplete="off" required aria-required="true" aria-describedby="url-hint" />
        <p id="url-hint" class="hint">在 Modrinth 或 CurseForge 光影页面的地址栏复制链接</p>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="contact">联系方式 <span class="optional">选填</span></label>
          <input id="contact" v-model="form.contact" type="text" name="contact" placeholder="QQ / 邮箱" autocomplete="off" aria-describedby="contact-hint" />
          <p id="contact-hint" class="hint">翻译完成后通知你</p>
        </div>
        <div class="form-group">
          <label for="note">备注 <span class="optional">选填</span></label>
          <textarea id="note" v-model="form.note" name="note" rows="3" placeholder="特殊需求或说明…"></textarea>
        </div>
      </div>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary" :disabled="submitting" :aria-busy="submitting ? 'true' : 'false'">{{ submitting ? '提交中…' : '提交请求' }}</button>
        <span class="form-actions-hint">提交后可在下方队列查看进度</span>
      </div>
    </form>
  </section>
  <!-- 翻译工作台 -->
  <section class="panel panel--workbench workbench" aria-labelledby="workbench-title">
    <div class="wb-head">
      <div class="wb-head-main">
        <h2 id="workbench-title" class="panel-title">翻译队列</h2>
        <p class="wb-meta" role="status" aria-live="polite">
          <span v-if="queueLoading">加载中…</span>
          <span v-else>{{ summary }}</span>
        </p>
      </div>
      <p v-if="lastUpdated" class="wb-updated">更新于 {{ lastUpdated }}</p>
    </div>
    <p v-if="queueError" class="form-error" role="alert">{{ queueError }}</p>
    <ul v-if="entries.length" class="wb-list">
      <li v-for="e in entries" :key="e.id" class="wb-item">
        <div class="wb-item-main">
          <a class="wb-name" :href="e.url" target="_blank" rel="noopener noreferrer">{{ e.name || e.id }}</a>
          <span class="wb-badge" :class="statusMeta(e.status).cls">{{ statusMeta(e.status).label }}</span>
        </div>
        <div class="wb-item-sub">
          <code class="wb-id">{{ e.id }}</code>
          <span v-if="e.shaderVersion" class="wb-chip">光影 v{{ e.shaderVersion }}</span>
          <!-- 失败项的重试状态：自动重试次数 / 需人工介入（口径由 Worker 的 retryState 给） -->
          <span v-if="e.retry?.label" class="wb-chip" :class="e.retry.manual ? 'wb-retry-manual' : 'wb-retry-count'">{{ e.retry.label }}</span>
          <span v-if="e.error" class="wb-err" :title="e.error">{{ e.error }}</span>
          <a v-if="e.quark" class="wb-mirror" :href="e.quark" target="_blank" rel="noopener noreferrer">国内镜像</a>
        </div>
      </li>
    </ul>
    <p v-else-if="!queueLoading" class="wb-empty">队列为空，欢迎提交第一个请求。</p>
    <form class="wb-trigger" @submit.prevent="handleTrigger">
      <h3 class="wb-trigger-title">管理员操作</h3>
      <!-- 轮班说明：这是流水线机制，不是对模型的评价（门禁前后都可见） -->
      <p class="hint wb-rotation-hint">模型是轮班而非优先级：每个被选中的模型都会分到约 1/N 的段落。</p>
      <template v-if="!unlocked">
        <label for="passphrase" class="wb-label">管理员口令</label>
        <div class="wb-trigger-row">
          <input id="passphrase" v-model="passphrase" type="password" name="passphrase" autocomplete="new-password" placeholder="输入口令后选择翻译模型" />
          <button type="button" class="btn btn-primary" @click="verifyPassphrase" :disabled="modelsLoading" :aria-busy="modelsLoading ? 'true' : 'false'">{{ modelsLoading ? '验证中…' : '验证口令' }}</button>
        </div>
        <p v-if="triggerErr" class="form-error" role="alert">{{ triggerErr }}</p>
        <p class="hint">口令仅保存在本标签页的 sessionStorage，不会写入 URL 或发送给第三方。</p>
      </template>
      <template v-else>
        <p class="wb-label">
          选择本轮翻译模型
          <button type="button" class="btn-refresh-models" :disabled="modelsLoading" @click="loadModels">{{ modelsLoading ? '刷新中…' : '刷新模型列表' }}</button>
        </p>
        <p v-if="lastRefreshedAt" class="hint">模型列表更新于 {{ lastRefreshedAt }}。点「刷新」可重新探测当前可用模型。</p>
        <p v-if="modelsError" class="form-error" role="alert">{{ modelsError }}</p>
        <p v-else-if="modelsLoading && !modelList.length" class="hint">正在加载模型列表…</p>
        <div v-else-if="modelList.length" class="wb-models">
          <label v-for="m in modelList" :key="m" class="wb-model">
            <input type="checkbox" v-model="selectedModels" :value="m" @change="persistModels" />
            <code>{{ m }}</code>
          </label>
        </div>
        <template v-if="freeTierModels.length">
          <p class="wb-label">免费层模型（bilibili Index-Translate）</p>
          <p class="hint">免费层失败会自动降级到上面勾选的模型，可放心勾选。一轮只会用一个免费层模型——勾多个时取第一个；一个都不勾则使用仓库默认值（免费层不会被关闭）。逐句模型按行翻译，质量稳定但请求数多。</p>
          <div class="wb-models">
            <label v-for="m in freeTierModels" :key="m" class="wb-model">
              <input type="checkbox" v-model="selectedModels" :value="m" @change="persistModels" />
              <code>{{ m }}</code>
            </label>
          </div>
        </template>
        <p v-else-if="freeTierError" class="hint">免费层暂不可用（{{ freeTierError }}），本轮只使用上面的网关模型。</p>
        <p class="hint wb-auto-retry-hint">
          失败项会自动重试（最多 3 次），无需手动勾选；达到上限后标为「需人工介入」，仍可手动强制重试。
        </p>
        <label class="wb-model wb-retry">
          <input type="checkbox" v-model="retryFailed" :disabled="!counts.failed" />
          <span>强制重试失败的光影（无视次数上限，会重新消耗翻译额度）<em v-if="counts.failed">当前 {{ counts.failed }} 条，需人工介入 {{ counts.manual }} 条</em><em v-else>当前没有失败项</em></span>
        </label>
        <div class="wb-trigger-row wb-trigger-row--submit">
          <button type="submit" class="btn btn-primary" :disabled="triggering" :aria-busy="triggering ? 'true' : 'false'">{{ triggering ? '翻译中…' : '开始翻译' }}</button>
        </div>
        <p v-if="triggerErr" class="form-error" role="alert">{{ triggerErr }}</p>
        <p v-if="triggerMsg" class="wb-ok" role="status">{{ triggerMsg }}</p>
        <p class="hint">选择会保存在本机 localStorage，下次自动恢复；不选任何模型时使用仓库默认模型。</p>
      </template>
    </form>
  </section>
  <!-- 工作流程 -->
  <section class="panel panel--info request-info" aria-labelledby="workflow-title">
    <h2 id="workflow-title" class="panel-title">工作流程</h2>
    <ol class="info-steps">
      <li>提交你想要翻译的光影包</li>
      <li>队列登记后由管理员一键开启翻译</li>
      <li>自动翻译 + 自动校验（键集合、格式码、占位符）</li>
      <li>通过校验即自动发布，可在站点下载中文语言文件</li>
    </ol>
  </section>
</div>

<style scoped>
/* ============================================================
   请求翻译 / 翻译工作台 — 暗色画廊风
   移动优先：默认窄屏，min-width 逐级增强。
   ============================================================ */

.request-page {
  max-width: 820px;
  margin: 0 auto;
  padding: 16px;
}

/* 视觉隐藏但保留给屏幕阅读器 */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* ---- Hero ---- */
.request-hero {
  text-align: center;
  margin-bottom: 28px;
}
.request-kicker {
  font-family: var(--shader-display-font);
  font-size: 12px;
  letter-spacing: 0.26em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
  margin-bottom: 10px;
}
.request-title {
  font-size: 30px;
  font-weight: 800;
  line-height: 1.15;
  margin: 0 0 10px !important;
  border: none !important;
  padding: 0 !important;
  font-family: var(--shader-display-font);
}
.request-lead {
  color: var(--vp-c-text-3);
  font-size: 14.5px;
  line-height: 1.7;
  max-width: 34em;
  margin: 0 auto;
}

/* ---- 面板 ---- */
.panel {
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  padding: 20px 18px;
  margin-bottom: 20px;
}
.panel--workbench {
  background: linear-gradient(180deg, rgba(232, 163, 61, 0.035), transparent 30%), var(--vp-c-bg-soft);
}
.panel-title {
  font-family: var(--shader-display-font);
  font-size: 18px;
  font-weight: 700;
  color: var(--vp-c-text-1);
  margin: 0 0 14px !important;
  padding: 0 !important;
  border: none !important;
}
.panel-title::before {
  content: '';
  display: inline-block;
  width: 3px;
  height: 16px;
  background: var(--vp-c-brand-1);
  border-radius: 2px;
  margin-right: 9px;
  vertical-align: -2px;
}

/* ---- 表单 ---- */
.form-group {
  margin-bottom: 18px;
}
.form-group label {
  display: block;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--vp-c-text-1);
  margin-bottom: 7px;
}
.required {
  color: #ff6b6b;
}
.optional {
  font-weight: 400;
  color: var(--vp-c-text-3);
  font-size: 12px;
}
.form-group input,
.form-group textarea,
.wb-trigger-row input {
  width: 100%;
  padding: 11px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 9px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 14px;
  font-family: inherit;
  transition: border-color 0.18s, box-shadow 0.18s;
}
.form-group textarea {
  resize: vertical;
  min-height: 84px;
}
.form-group input::placeholder,
.form-group textarea::placeholder,
.wb-trigger-row input::placeholder {
  color: var(--vp-c-text-3);
}
.form-group input:focus-visible,
.form-group textarea:focus-visible,
.wb-trigger-row input:focus-visible {
  outline: none;
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 0 0 3px rgba(232, 163, 61, 0.2);
}
.hint {
  font-size: 12px;
  color: var(--vp-c-text-3);
  margin: 6px 0 0;
  line-height: 1.6;
}

.form-actions {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
  margin-top: 6px;
}
.form-actions-hint {
  font-size: 12px;
  color: var(--vp-c-text-3);
  text-align: center;
}

/* ---- 提示条 ---- */
.form-error {
  padding: 11px 14px;
  border-radius: 9px;
  border: 1px solid rgba(255, 107, 107, 0.35);
  background: rgba(255, 107, 107, 0.1);
  color: #ff8f8f;
  font-size: 13px;
  line-height: 1.6;
  margin: 14px 0 0;
}
.wb-ok {
  padding: 11px 14px;
  border-radius: 9px;
  border: 1px solid rgba(79, 178, 134, 0.35);
  background: rgba(79, 178, 134, 0.12);
  color: #5cc79a;
  font-size: 13px;
  line-height: 1.6;
  margin: 14px 0 0;
}

/* ---- 按钮 ---- */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 11px 26px;
  border: 1px solid transparent;
  border-radius: 9px;
  font-size: 14px;
  font-weight: 600;
  font-family: var(--shader-display-font);
  cursor: pointer;
  transition: opacity 0.2s, transform 0.2s, box-shadow 0.2s;
}
.btn-primary {
  background: var(--vp-c-brand-1);
  color: #14100a;
}
.btn-primary:hover:not(:disabled) {
  opacity: 0.94;
  transform: translateY(-1px);
  box-shadow: 0 8px 22px rgba(232, 163, 61, 0.32);
}
.btn:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 3px;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}

/* ---- 成功态 ---- */
.request-success {
  text-align: center;
  background: var(--vp-c-bg-soft);
  border: 1px solid rgba(79, 178, 134, 0.35);
  border-radius: 14px;
  padding: 34px 20px;
  margin-bottom: 20px;
}
.success-icon {
  color: #4fb286;
  margin-bottom: 12px;
  display: flex;
  justify-content: center;
}
.request-success h2 {
  font-size: 20px;
  font-family: var(--shader-display-font);
  margin: 0 0 10px !important;
  border: none !important;
  padding: 0 !important;
}
.request-success p {
  color: var(--vp-c-text-3);
  margin: 0 0 8px;
  font-size: 14px;
}
.success-hint {
  font-size: 13px;
  margin-bottom: 20px !important;
}

/* ---- 队列 ---- */
.wb-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 14px;
}
.wb-head-main {
  min-width: 0;
}
.wb-meta {
  font-size: 13px;
  color: var(--vp-c-text-3);
  margin: 0;
  font-variant-numeric: tabular-nums;
  line-height: 1.6;
}
.wb-updated {
  font-size: 12px;
  color: var(--vp-c-text-3);
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.wb-list {
  list-style: none;
  padding: 0;
  margin: 0;
  max-height: 440px;
  overflow-y: auto;
  border-top: 1px solid var(--vp-c-divider);
  scrollbar-width: thin;
  scrollbar-color: var(--vp-c-divider) transparent;
}
.wb-item {
  padding: 11px 2px;
  border-bottom: 1px solid var(--vp-c-divider);
  transition: background-color 0.18s;
}
.wb-item:hover {
  background: rgba(255, 255, 255, 0.02);
}
.wb-item:last-child {
  border-bottom: none;
}
.wb-item-main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.wb-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--vp-c-text-1);
  text-decoration: none;
  border-radius: 4px;
}
.wb-name:hover {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
}
.wb-name:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}
.wb-badge {
  font-size: 12px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid transparent;
  white-space: nowrap;
}
.st-pending {
  background: rgba(232, 163, 61, 0.15);
  color: #f0b55e;
  border-color: rgba(232, 163, 61, 0.4);
}
.st-running {
  background: rgba(90, 140, 230, 0.15);
  color: #7aa5f0;
  border-color: rgba(90, 140, 230, 0.4);
}
.st-done {
  background: rgba(79, 178, 134, 0.15);
  color: #5cc79a;
  border-color: rgba(79, 178, 134, 0.4);
}
.st-mirror {
  background: rgba(150, 120, 220, 0.15);
  color: #ab93e6;
  border-color: rgba(150, 120, 220, 0.4);
}
.st-failed {
  background: rgba(255, 107, 107, 0.15);
  color: #ff8f8f;
  border-color: rgba(255, 107, 107, 0.4);
}
.st-unknown {
  background: var(--vp-c-bg);
  color: var(--vp-c-text-3);
  border-color: var(--vp-c-divider);
}
.wb-item-sub {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 6px;
  font-size: 12px;
  color: var(--vp-c-text-3);
}
.wb-id {
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
}
.wb-chip {
  font-size: 12px;
  padding: 2px 7px;
  border-radius: 4px;
  background: rgba(232, 163, 61, 0.1);
  color: var(--vp-c-brand-1);
}
/* 失败重试状态：自动重试（中性）vs 需人工介入（警示） */
.wb-retry-count {
  background: rgba(232, 163, 61, 0.1);
  color: #f0b55e;
}
.wb-retry-manual {
  background: rgba(255, 107, 107, 0.14);
  color: #ff8f8f;
  border: 1px solid rgba(255, 107, 107, 0.35);
}
.wb-err {
  color: #ff8f8f;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.wb-mirror {
  color: var(--vp-c-brand-1);
  border-radius: 4px;
}
.wb-mirror:hover {
  text-decoration: underline;
}
.wb-mirror:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}
.wb-empty {
  font-size: 13px;
  color: var(--vp-c-text-3);
  margin: 0;
  padding: 18px 0;
}

/* ---- 管理员触发 ---- */
.wb-trigger {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid var(--vp-c-divider);
}
.wb-trigger-title {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--vp-c-text-2);
  margin: 0 0 12px !important;
  padding: 0 !important;
  border: none !important;
  text-transform: uppercase;
}
.wb-rotation-hint {
  font-size: 12px;
  line-height: 1.6;
  color: var(--vp-c-text-3);
  margin: 0 0 12px;
  padding: 8px 10px;
  border-left: 3px solid var(--vp-c-brand-1);
  background: var(--vp-c-bg);
  border-radius: 0 6px 6px 0;
}
.wb-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--vp-c-text-1);
  margin-bottom: 8px;
}
/* 模型列表是实时探测的（网关会增删模型、免费层会整组挂掉），必须能手动重探。 */
.btn-refresh-models {
  margin-left: 10px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 500;
  color: var(--vp-c-brand-1);
  background: transparent;
  border: 1px solid var(--vp-c-brand-1);
  border-radius: 6px;
  cursor: pointer;
}
.btn-refresh-models:hover:not(:disabled) { background: var(--vp-c-brand-soft); }
.btn-refresh-models:disabled { opacity: 0.5; cursor: default; }
.wb-trigger-row {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.wb-trigger-row input {
  flex: 1 1 auto;
  min-width: 0;
}
.wb-trigger-row .btn {
  white-space: nowrap;
  flex: none;
}
.wb-trigger-row--submit {
  margin-top: 14px;
}

/* ---- 失败重试（口令门禁后；复用 .wb-model 的触控尺寸与勾选框样式） ---- */
.wb-retry {
  margin-top: 12px;
  font-size: 13px;
  color: var(--vp-c-text-2);
}
.wb-retry em {
  font-style: normal;
  color: var(--vp-c-text-3);
  margin-left: 4px;
}
.wb-retry input[type='checkbox']:disabled {
  cursor: not-allowed;
}

/* ---- 模型多选（移动端点击目标 ≥44px，字号 ≥12px） ---- */
.wb-models {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 260px;
  overflow-y: auto;
  padding: 2px;
}
.wb-model {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  padding: 8px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 9px;
  background: var(--vp-c-bg);
  cursor: pointer;
  transition: border-color 0.18s, background-color 0.18s;
}
.wb-model:hover {
  border-color: var(--vp-c-brand-1);
}
.wb-model input[type='checkbox'] {
  width: 20px;
  height: 20px;
  flex: none;
  accent-color: var(--vp-c-brand-1);
  cursor: pointer;
}
.wb-model code {
  font-size: 13px;
  line-height: 1.5;
  word-break: break-all;
  color: var(--vp-c-text-1);
}

/* ---- 工作流程 ---- */
.info-steps {
  padding-left: 20px;
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 14px;
  line-height: 1.7;
}
.info-steps li {
  margin-bottom: 7px;
}
.info-steps li::marker {
  color: var(--vp-c-brand-1);
  font-weight: 700;
}

/* ===== 窄屏：队列里的链接抬到最小触控高度 ===== */
@media (max-width: 640px) {
  .wb-name,
  .wb-mirror {
    display: inline-flex;
    align-items: center;
    min-height: var(--tap-min);
  }
}

/* ===== 增强：平板起 ===== */
@media (min-width: 640px) {
  .request-page {
    padding: 20px;
  }
  .panel {
    padding: 24px;
  }
  .request-title {
    font-size: 34px;
  }
  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 18px;
  }
  .form-actions {
    flex-direction: row;
    align-items: center;
    gap: 14px;
  }
  .form-actions-hint {
    text-align: left;
  }
  .wb-head {
    flex-direction: row;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  .wb-trigger-row {
    flex-direction: row;
    align-items: stretch;
  }
}

/* ===== 无障碍：减弱动效 ===== */
@media (prefers-reduced-motion: reduce) {
  .btn,
  .form-group input,
  .form-group textarea,
  .wb-trigger-row input,
  .wb-item {
    transition: none !important;
  }
  .btn-primary:hover:not(:disabled) {
    transform: none;
  }
}
</style>
