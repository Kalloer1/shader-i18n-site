---
title: "请求翻译"
description: "提交你想要翻译的 Minecraft 光影包"
layout: page
---

<script setup>
import { ref } from 'vue'

const form = ref({
  name: '',
  url: '',
  contact: '',
  note: '',
})

const submitting = ref(false)
const submitted = ref(false)
const error = ref('')

// Worker URL - 部署后替换
const WORKER_URL = 'https://shader-i18n-api.wqclo.workers.dev'

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
    } else {
      error.value = data.error || '提交失败，请稍后重试'
    }
  } catch (e) {
    error.value = '网络错误，请检查连接后重试'
  } finally {
    submitting.value = false
  }
}
</script>

<div class="request-page">
  <div class="request-hero">
    <h1>请求翻译</h1>
    <p>找到你喜欢的光影包，告诉我们你想翻译它</p>
  </div>

  <!-- 成功状态 -->
  <div v-if="submitted" class="request-success">
    <div class="success-icon">✅</div>
    <h2>提交成功！</h2>
    <p>你的翻译请求已收到，我们会尽快处理。</p>
    <p class="success-hint">你可以在 <a href="https://docs.qq.com/smartsheet/DQnB1dnZKaE9RSGJX" target="_blank">收集表</a> 中查看请求状态。</p>
    <button class="btn btn-primary" @click="submitted = false; form = { name: '', url: '', contact: '', note: '' }">
      继续提交
    </button>
  </div>

  <!-- 表单 -->
  <form v-else class="request-form" @submit.prevent="handleSubmit">
    <div class="form-group">
      <label for="name">光影名称 <span class="required">*</span></label>
      <input
        id="name"
        v-model="form.name"
        type="text"
        placeholder="例如：Complementary Reimagined"
        required
      />
    </div>

    <div class="form-group">
      <label for="url">Modrinth 链接 <span class="required">*</span></label>
      <input
        id="url"
        v-model="form.url"
        type="url"
        placeholder="https://modrinth.com/shader/..."
        required
      />
      <p class="hint">在 Modrinth 光影页面的地址栏复制链接</p>
    </div>

    <div class="form-group">
      <label for="contact">联系方式 <span class="optional">选填</span></label>
      <input
        id="contact"
        v-model="form.contact"
        type="text"
        placeholder="QQ / 邮箱，翻译完成后通知你"
      />
    </div>

    <div class="form-group">
      <label for="note">备注 <span class="optional">选填</span></label>
      <textarea
        id="note"
        v-model="form.note"
        rows="3"
        placeholder="特殊需求或说明..."
      ></textarea>
    </div>

    <div v-if="error" class="form-error">{{ error }}</div>

    <button type="submit" class="btn btn-primary" :disabled="submitting">
      {{ submitting ? '提交中...' : '提交请求' }}
    </button>
  </form>

  <!-- 说明 -->
  <div class="request-info">
    <h3>📋 工作流程</h3>
    <ol>
      <li>提交你想要翻译的光影包</li>
      <li>管理员审核并翻译</li>
      <li>翻译完成后通知你</li>
      <li>在站点下载中文语言文件</li>
    </ol>
  </div>
</div>

<style scoped>
.request-page {
  max-width: 640px;
  margin: 0 auto;
  padding: 20px;
}

.request-hero {
  text-align: center;
  margin-bottom: 32px;
}

.request-hero h1 {
  font-size: 28px;
  font-weight: 700;
  margin-bottom: 8px;
}

.request-hero p {
  color: var(--vp-c-text-3);
  font-size: 15px;
}

.request-form {
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  padding: 24px;
}

.form-group {
  margin-bottom: 20px;
}

.form-group label {
  display: block;
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 6px;
}

.required {
  color: #e55;
}

.optional {
  font-weight: 400;
  color: var(--vp-c-text-3);
  font-size: 12px;
}

.form-group input,
.form-group textarea {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 14px;
  font-family: inherit;
}

.form-group input:focus,
.form-group textarea:focus {
  outline: none;
  border-color: var(--vp-c-brand-1);
}

.hint {
  font-size: 12px;
  color: var(--vp-c-text-3);
  margin-top: 4px;
}

.form-error {
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(229, 85, 85, 0.1);
  color: #e55;
  font-size: 13px;
  margin-bottom: 16px;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 10px 24px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-primary {
  background: var(--vp-c-brand-1);
  color: #fff;
}

.btn-primary:hover:not(:disabled) {
  opacity: 0.9;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.request-success {
  text-align: center;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  padding: 40px 24px;
}

.success-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.request-success h2 {
  font-size: 20px;
  margin-bottom: 8px;
}

.request-success p {
  color: var(--vp-c-text-3);
  margin-bottom: 8px;
}

.success-hint {
  font-size: 13px;
}

.success-hint a {
  color: var(--vp-c-brand-1);
}

.request-info {
  margin-top: 32px;
  padding: 20px 24px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
}

.request-info h3 {
  font-size: 16px;
  margin-bottom: 12px;
}

.request-info ol {
  padding-left: 20px;
  color: var(--vp-c-text-2);
  font-size: 14px;
}

.request-info li {
  margin-bottom: 6px;
}
</style>
