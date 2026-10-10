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

const form = ref({ name: '', url: '', contact: '', note: '' })
const submitting = ref(false)
const submitted = ref(false)
const error = ref('')

async function handleSubmit() {
  if (!form.value.name || !form.value.url) {
    error.value = '请填写光影名称和 Modrinth 链接'
    return
  }
  if (!form.value.url.includes('modrinth.com/')) {
    error.value = '请填写有效的 Modrinth 链接'
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
  form.value = { name: '', url: '', contact: '', note: '' }
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
  已完成待镜像: { cls: 'st-mirror', label: '已完成待镜像' },
  失败: { cls: 'st-failed', label: '失败' },
}

function statusMeta(status) {
  return STATUS_META[status] ?? { cls: 'st-unknown', label: status || '未知' }
}

const counts = computed(() => {
  const c = { total: entries.value.length, pending: 0, running: 0, done: 0, failed: 0 }
  for (const e of entries.value) {
    if (e.status === '待翻译') c.pending++
    else if (e.status === '翻译中') c.running++
    else if (e.status === '失败') c.failed++
    else c.done++
  }
  return c
})

const summary = computed(
  () =>
    `共 ${counts.value.total} 项 · 待翻译 ${counts.value.pending} · 翻译中 ${counts.value.running} · 已完成 ${counts.value.done} · 失败 ${counts.value.failed}`,
)

/* ---------- 触发翻译（口令存 sessionStorage，不落 URL） ---------- */

const passphrase = ref('')
const triggering = ref(false)
const triggerMsg = ref('')
const triggerErr = ref('')

onMounted(() => {
  passphrase.value = sessionStorage.getItem('translate-passphrase') || ''
})

async function handleTrigger() {
  if (!passphrase.value) {
    triggerErr.value = '请输入口令'
    triggerMsg.value = ''
    return
  }
  triggering.value = true
  triggerErr.value = ''
  triggerMsg.value = ''

  try {
    const res = await fetch(`${WORKER_URL}/translate`, {
      method: 'POST',
      headers: { 'X-Passphrase': passphrase.value },
    })
    const data = await res.json()

    if (res.status === 401) {
      triggerErr.value = '口令不正确'
      sessionStorage.removeItem('translate-passphrase')
      return
    }
    if (!data.success) {
      triggerErr.value = data.error || '触发失败'
      return
    }

    sessionStorage.setItem('translate-passphrase', passphrase.value)
    triggerMsg.value = data.triggered
      ? `已触发 ${data.count} 个光影的翻译，状态会自动刷新`
      : data.message || '没有待翻译的条目'
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
        <label for="name">光影名称 <span class="required" aria-hidden="true">*</span><span class="sr-only">（必填）</span></label>
        <input id="name" v-model="form.name" type="text" name="name" placeholder="例如：Complementary Reimagined" autocomplete="off" required aria-required="true" />
      </div>
      <div class="form-group">
        <label for="url">Modrinth 链接 <span class="required" aria-hidden="true">*</span><span class="sr-only">（必填）</span></label>
        <input id="url" v-model="form.url" type="url" name="url" placeholder="https://modrinth.com/shader/..." autocomplete="off" required aria-required="true" aria-describedby="url-hint" />
        <p id="url-hint" class="hint">在 Modrinth 光影页面的地址栏复制链接</p>
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
          <span v-if="e.error" class="wb-err" :title="e.error">{{ e.error }}</span>
          <a v-if="e.quark" class="wb-mirror" :href="e.quark" target="_blank" rel="noopener noreferrer">夸克网盘镜像</a>
          <a v-if="e.baidu" class="wb-mirror" :href="e.baidu" target="_blank" rel="noopener noreferrer">百度网盘镜像</a>
        </div>
      </li>
    </ul>
    <p v-else-if="!queueLoading" class="wb-empty">队列为空，欢迎提交第一个请求。</p>
    <form class="wb-trigger" @submit.prevent="handleTrigger">
      <h3 class="wb-trigger-title">管理员操作</h3>
      <label for="passphrase" class="wb-label">管理员口令</label>
      <div class="wb-trigger-row">
        <input id="passphrase" v-model="passphrase" type="password" name="passphrase" autocomplete="current-password" placeholder="输入口令后开启翻译" />
        <button type="submit" class="btn btn-primary" :disabled="triggering" :aria-busy="triggering ? 'true' : 'false'">{{ triggering ? '触发中…' : '开启翻译' }}</button>
      </div>
      <p v-if="triggerErr" class="form-error" role="alert">{{ triggerErr }}</p>
      <p v-if="triggerMsg" class="wb-ok" role="status">{{ triggerMsg }}</p>
      <p class="hint">口令仅保存在本标签页的 sessionStorage，不会写入 URL 或发送给第三方。触发后由 GitHub Actions 自动翻译并发布。</p>
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
  font-size: 11px;
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
  font-size: 11px;
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
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
}
.wb-chip {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 4px;
  background: rgba(232, 163, 61, 0.1);
  color: var(--vp-c-brand-1);
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
.wb-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--vp-c-text-1);
  margin-bottom: 8px;
}
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
