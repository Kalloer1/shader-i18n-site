<script setup>
import { computed, ref, watch } from 'vue'
import { allShaders } from '../data.js'

const keyword = ref('')
const onlyWithLang = ref(false)
const sortBy = ref('downloads')
const layoutMode = ref('spacious') // spacious | dense
const selectedCategories = ref(new Set())
const PAGE_SIZE = computed(() => (layoutMode.value === 'dense' ? 30 : 18))
const page = ref(1)

// 分类标签分组 — 直接平铺在页面顶部
const categoryGroups = [
  {
    label: '性能',
    options: ['potato', 'low', 'medium', 'high'],
  },
  {
    label: '风格',
    options: ['vanilla-like', 'atmosphere', 'realistic', 'semi-realistic', 'fantasy', 'cartoon', 'cursed'],
  },
  {
    label: '特效',
    options: ['colored-lighting', 'reflections', 'bloom', 'shadows', 'pbr', 'path-tracing'],
  },
  {
    label: '加载器',
    options: ['iris', 'optifine'],
  },
]

const sortOptions = [
  { value: 'downloads', label: '按下载量' },
  { value: 'name', label: '按名称' },
  { value: 'newest', label: '按更新时间' },
]

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  let list = allShaders.filter((s) => {
    if (onlyWithLang.value && !s.langVersions.length) return false
    if (selectedCategories.value.size > 0) {
      const cats = s.categories ?? []
      const hasAny = [...selectedCategories.value].some((c) => cats.includes(c))
      if (!hasAny) return false
    }
    if (!kw) return true
    return [s.id, s.nameCN, s.title, s.author].filter(Boolean).some((v) => v.toLowerCase().includes(kw))
  })
  if (sortBy.value === 'downloads') {
    list = [...list].sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0))
  } else if (sortBy.value === 'name') {
    list = [...list].sort((a, b) => (a.title ?? a.id).localeCompare(b.title ?? b.id))
  } else if (sortBy.value === 'newest') {
    list = [...list].sort((a, b) => {
      const aDate = a.langVersions?.[0]?.updatedAt ?? ''
      const bDate = b.langVersions?.[0]?.updatedAt ?? ''
      return bDate.localeCompare(aDate)
    })
  }
  return list
})

const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE.value)))
const pageItems = computed(() =>
  filtered.value.slice((page.value - 1) * PAGE_SIZE.value, page.value * PAGE_SIZE.value),
)

watch([keyword, onlyWithLang, sortBy, layoutMode], () => {
  page.value = 1
})
watch(
  selectedCategories,
  () => {
    page.value = 1
  },
  { deep: true },
)

function toggleCategory(cat) {
  const s = new Set(selectedCategories.value)
  if (s.has(cat)) s.delete(cat)
  else s.add(cat)
  selectedCategories.value = s
}

function clearFilters() {
  selectedCategories.value = new Set()
  keyword.value = ''
  onlyWithLang.value = false
  sortBy.value = 'downloads'
  page.value = 1
}

function hasLang(s) {
  return s.langVersions.length > 0
}

function langBadge(s) {
  if (hasLang(s)) return '已有汉化'
  if (s.hasNativeZhCN) return '自带中文'
  if (s.missingSource) return '无英文源'
  return '暂无汉化'
}

function formatDownloads(n) {
  if (n == null) return '—'
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n)
}

function range(s) {
  if (!s.gameVersions?.length) return ''
  const parse = (v) => {
    const m = String(v).match(/^(\d+)\.(\d+)(?:\.(\d+))?$/)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null
  }
  let min = null
  let max = null
  for (const v of s.gameVersions) {
    const p = parse(v)
    if (!p) continue
    if (!min || p < min) min = p
    if (!max || p > max) max = p
  }
  if (!min) return ''
  const fmt = (p) => `${p[0]}.${p[1]}${p[2] ? `.${p[2]}` : ''}`
  return fmt(min) === fmt(max) ? fmt(min) : `${fmt(min)} ~ ${fmt(max)}`
}

function cover(s) {
  return s.gallery?.[0] ?? s.iconUrl ?? ''
}

function initial(s) {
  return (s.title ?? s.id ?? '?').trim().charAt(0).toUpperCase()
}

function tint(s) {
  const c = /^#[0-9a-fA-F]{6}$/.test(s.color ?? '') ? s.color : '#2A3B4D'
  return { background: `linear-gradient(135deg, ${c} 0%, #141a21 100%)` }
}
</script>

<template>
  <section class="shader-list" aria-label="光影列表">
    <!-- 分类筛选 — 平铺在最顶部 -->
    <div class="tag-bar" role="group" aria-label="按分类筛选光影">
      <div v-for="group in categoryGroups" :key="group.label" class="tag-group" role="group" :aria-label="group.label">
        <span class="tag-group__label" aria-hidden="true">{{ group.label }}</span>
        <div class="tag-group__tags">
          <button
            v-for="cat in group.options"
            :key="cat"
            type="button"
            class="tag"
            :class="{ active: selectedCategories.has(cat) }"
            :aria-pressed="selectedCategories.has(cat)"
            @click="toggleCategory(cat)"
          >
            {{ cat }}
          </button>
        </div>
      </div>
    </div>

    <!-- 工具栏：搜索 + 排序 + 切换 -->
    <div class="toolbar">
      <div class="search-wrap">
        <svg
          class="ico"
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <label class="sr-only" for="shader-search">搜索光影</label>
        <input
          id="shader-search"
          v-model="keyword"
          type="search"
          :placeholder="`搜索 ${allShaders.length} 个光影…`"
        />
      </div>

      <label class="sort-wrap">
        <span class="sr-only">排序方式</span>
        <select v-model="sortBy" class="sort-select">
          <option v-for="opt in sortOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
      </label>

      <label class="toggle">
        <input v-model="onlyWithLang" type="checkbox" />
        <span>仅看已有汉化</span>
      </label>

      <div class="layout-toggle" role="group" aria-label="列表布局">
        <button
          type="button"
          :class="{ active: layoutMode === 'spacious' }"
          :aria-pressed="layoutMode === 'spacious'"
          aria-label="分散型布局"
          title="分散型"
          @click="layoutMode = 'spacious'"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
        </button>
        <button
          type="button"
          :class="{ active: layoutMode === 'dense' }"
          :aria-pressed="layoutMode === 'dense'"
          aria-label="紧密型布局"
          title="紧密型"
          @click="layoutMode = 'dense'"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <rect x="3" y="3" width="4" height="4" rx="0.5" />
            <rect x="10" y="3" width="4" height="4" rx="0.5" />
            <rect x="17" y="3" width="4" height="4" rx="0.5" />
            <rect x="3" y="10" width="4" height="4" rx="0.5" />
            <rect x="10" y="10" width="4" height="4" rx="0.5" />
            <rect x="17" y="10" width="4" height="4" rx="0.5" />
            <rect x="3" y="17" width="4" height="4" rx="0.5" />
            <rect x="10" y="17" width="4" height="4" rx="0.5" />
            <rect x="17" y="17" width="4" height="4" rx="0.5" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 结果统计 -->
    <div class="result-bar">
      <span class="result-count" role="status" aria-live="polite">共 {{ filtered.length }} 个光影</span>
      <div v-if="selectedCategories.size > 0 || keyword || onlyWithLang" class="active-filters">
        <span v-for="cat in selectedCategories" :key="cat" class="filter-tag">
          {{ cat }}
          <button type="button" :aria-label="`移除筛选 ${cat}`" @click="toggleCategory(cat)">×</button>
        </span>
        <button type="button" class="clear-btn" @click="clearFilters">清除全部</button>
      </div>
    </div>

    <p v-if="!filtered.length" class="empty" role="status">没有匹配的光影。</p>

    <!-- 紧凑型 -->
    <div v-if="layoutMode === 'dense'" class="shader-grid shader-grid--dense">
      <a v-for="s in pageItems" :key="s.id" class="card card--dense" :href="`/shaders/${s.id}`">
        <div class="cover cover--dense" :style="!cover(s) ? tint(s) : undefined">
          <img
            v-if="cover(s)"
            :src="cover(s)"
            :alt="`${s.title} 封面图`"
            width="640"
            height="400"
            loading="lazy"
            decoding="async"
          />
          <span v-else class="fallback" aria-hidden="true">{{ initial(s) }}</span>
          <span class="badge badge--sm" :class="hasLang(s) ? 'ok' : s.hasNativeZhCN ? 'nat' : 'none'">
            {{ langBadge(s) }}
          </span>
        </div>
        <div class="body body--dense">
          <div class="name name--dense">{{ s.title }}</div>
          <div class="meta">
            <span class="m">
              <svg
                viewBox="0 0 24 24"
                width="11"
                height="11"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M12 3v12" />
                <path d="m7 10 5 5 5-5" />
                <path d="M5 21h14" />
              </svg>
              {{ formatDownloads(s.downloads) }}
            </span>
          </div>
        </div>
      </a>
    </div>

    <!-- 分散型 -->
    <div v-else class="shader-grid shader-grid--spacious">
      <a v-for="s in pageItems" :key="s.id" class="card card--spacious" :href="`/shaders/${s.id}`">
        <div class="cover cover--spacious" :style="!cover(s) ? tint(s) : undefined">
          <img
            v-if="cover(s)"
            :src="cover(s)"
            :alt="`${s.title} 封面图`"
            width="640"
            height="400"
            loading="lazy"
            decoding="async"
          />
          <span v-else class="fallback fallback--lg" aria-hidden="true">{{ initial(s) }}</span>
          <span class="badge" :class="hasLang(s) ? 'ok' : s.hasNativeZhCN ? 'nat' : 'none'">
            {{ langBadge(s) }}
          </span>
        </div>
        <div class="body body--spacious">
          <div class="name">{{ s.title }}</div>
          <div class="sub">{{ s.nameCN || s.id }}<template v-if="s.author"> · {{ s.author }}</template></div>
          <div v-if="s.categories?.length" class="cats">
            <span v-for="cat in s.categories.slice(0, 3)" :key="cat" class="cat-tag">{{ cat }}</span>
          </div>
          <div class="meta">
            <span class="m">
              <svg
                viewBox="0 0 24 24"
                width="12"
                height="12"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M12 3v12" />
                <path d="m7 10 5 5 5-5" />
                <path d="M5 21h14" />
              </svg>
              {{ formatDownloads(s.downloads) }}
            </span>
            <span v-if="range(s)" class="m">
              <svg
                viewBox="0 0 24 24"
                width="12"
                height="12"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M8 2v4M16 2v4M3 10h18" />
              </svg>
              {{ range(s) }}
            </span>
          </div>
        </div>
      </a>
    </div>

    <nav v-if="totalPages > 1" class="pagination" aria-label="分页">
      <button type="button" :disabled="page <= 1" @click="page--">← 上一页</button>
      <span aria-live="polite">第 {{ page }} / {{ totalPages }} 页</span>
      <button type="button" :disabled="page >= totalPages" @click="page++">下一页 →</button>
    </nav>
  </section>
</template>

<style scoped>
/* ============================================================
   光影列表 — 暗色画廊风
   移动优先：默认写窄屏样式，再用 min-width 逐级增强。
   ============================================================ */

.shader-list {
  max-width: 1200px;
  margin: 0 auto;
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

/* ===== 标签栏 ===== */
.tag-bar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 16px;
  padding: 14px 14px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: linear-gradient(180deg, rgba(232, 163, 61, 0.03), transparent 40%), var(--vp-c-bg-soft);
}
.tag-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tag-group__label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--vp-c-text-3);
  text-transform: uppercase;
}
.tag-group__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tag {
  padding: 5px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  background: transparent;
  color: var(--vp-c-text-2);
  font-size: 12.5px;
  font-family: inherit;
  cursor: pointer;
  transition: color 0.18s, border-color 0.18s, background-color 0.18s;
  user-select: none;
}
.tag:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}
.tag.active {
  background: var(--vp-c-brand-1);
  color: #14100a;
  border-color: var(--vp-c-brand-1);
  font-weight: 600;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}
.tag:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

/* ===== 工具栏 ===== */
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-bottom: 14px;
}
.search-wrap {
  position: relative;
  flex: 1 1 100%;
  min-width: 0;
}
.search-wrap .ico {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--vp-c-text-3);
  pointer-events: none;
}
.search-wrap input {
  width: 100%;
  padding: 10px 14px 10px 36px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 9px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-size: 13.5px;
  font-family: inherit;
  transition: border-color 0.18s, box-shadow 0.18s;
}
.search-wrap input::placeholder {
  color: var(--vp-c-text-3);
}
.search-wrap input:focus {
  outline: none;
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 0 0 3px rgba(232, 163, 61, 0.16);
}
.sort-wrap {
  display: inline-flex;
}
.sort-select {
  padding: 9px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 9px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.18s, box-shadow 0.18s;
}
.sort-select:focus {
  outline: none;
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 0 0 3px rgba(232, 163, 61, 0.16);
}
.toggle {
  display: flex;
  gap: 7px;
  align-items: center;
  padding: 8px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 9px;
  font-size: 13px;
  cursor: pointer;
  color: var(--vp-c-text-2);
  user-select: none;
  transition: border-color 0.18s;
}
.toggle:hover {
  border-color: var(--vp-c-text-3);
}
.toggle input {
  accent-color: var(--vp-c-brand-1);
}
.toggle input:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

/* ===== 布局切换 ===== */
.layout-toggle {
  display: inline-flex;
  border: 1px solid var(--vp-c-divider);
  border-radius: 9px;
  overflow: hidden;
  margin-left: auto;
}
.layout-toggle button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-3);
  cursor: pointer;
  transition: color 0.18s, background-color 0.18s;
}
.layout-toggle button + button {
  border-left: 1px solid var(--vp-c-divider);
}
.layout-toggle button:hover {
  color: var(--vp-c-text-1);
}
.layout-toggle button:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: -2px;
}
.layout-toggle button.active {
  background: var(--vp-c-brand-1);
  color: #14100a;
}

/* ===== 结果栏 ===== */
.result-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.result-count {
  font-size: 13px;
  color: var(--vp-c-text-3);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.active-filters {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.filter-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid rgba(232, 163, 61, 0.25);
  background: rgba(232, 163, 61, 0.12);
  color: var(--vp-c-brand-1);
  font-size: 12px;
}
.filter-tag button {
  border: none;
  background: none;
  color: var(--vp-c-brand-1);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
  border-radius: 4px;
  opacity: 0.7;
  transition: opacity 0.15s;
}
.filter-tag button:hover {
  opacity: 1;
}
.filter-tag button:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 1px;
}

.clear-btn {
  border: none;
  background: none;
  color: var(--vp-c-text-3);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  text-decoration: underline;
  padding: 2px 4px;
  border-radius: 4px;
}
.clear-btn:hover {
  color: #ff6b6b;
}
.clear-btn:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

.empty {
  color: var(--vp-c-text-3);
  text-align: center;
  padding: 56px 0;
}

/* ===== 卡片共用 ===== */
.card--spacious,
.card--dense {
  display: block;
  color: inherit;
  text-decoration: none;
  /* 大列表渲染优化：视口外跳过绘制，避免滚动卡顿 */
  content-visibility: auto;
  contain-intrinsic-size: auto 300px;
}
.card--spacious:focus-visible,
.card--dense:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

/* ===== 分散型网格 ===== */
.shader-grid--spacious {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px;
}
.card--spacious {
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  overflow: hidden;
  background: var(--vp-c-bg-soft);
  transition: transform 0.25s ease, border-color 0.25s, box-shadow 0.25s;
}
.card--spacious:hover {
  transform: translateY(-4px);
  border-color: rgba(232, 163, 61, 0.55);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.45);
}
.cover--spacious {
  position: relative;
  aspect-ratio: 16 / 10;
  overflow: hidden;
  background: var(--vp-c-bg);
}
.cover--spacious img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.45s ease;
}
.card--spacious:hover .cover--spacious img {
  transform: scale(1.06);
}
.body--spacious {
  padding: 14px 16px 16px;
}
.body--spacious .name {
  font-weight: 700;
  font-size: 15px;
  color: var(--vp-c-text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.body--spacious .sub {
  font-size: 13px;
  color: var(--vp-c-text-3);
  margin: 4px 0 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ===== 紧凑型网格 ===== */
.shader-grid--dense {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
}
.card--dense {
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  overflow: hidden;
  background: var(--vp-c-bg-soft);
  transition: transform 0.2s, border-color 0.2s, box-shadow 0.2s;
}
.card--dense:hover {
  transform: translateY(-2px);
  border-color: rgba(232, 163, 61, 0.55);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.4);
}
.cover--dense {
  position: relative;
  aspect-ratio: 16 / 10;
  overflow: hidden;
  background: var(--vp-c-bg);
}
.cover--dense img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.35s;
}
.card--dense:hover .cover--dense img {
  transform: scale(1.04);
}
.body--dense {
  padding: 9px 10px 10px;
}
.name--dense {
  font-weight: 600;
  font-size: 12.5px;
  color: var(--vp-c-text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ===== 共用 ===== */
.fallback {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--shader-display-font);
  font-size: 36px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.55);
}
.fallback--lg {
  font-size: 48px;
}
.badge {
  position: absolute;
  top: 10px;
  left: 10px;
  font-size: 11px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 999px;
  font-family: var(--vp-font-family-base);
  backdrop-filter: blur(6px);
}
.badge--sm {
  font-size: 10px;
  padding: 2px 7px;
  top: 7px;
  left: 7px;
}
.badge.ok {
  background: rgba(79, 178, 134, 0.92);
  color: #0c1712;
}
.badge.none {
  background: rgba(13, 17, 23, 0.72);
  color: #c3ccd6;
}
.badge.nat {
  background: rgba(80, 140, 190, 0.9);
  color: #0a1219;
}
.cats {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 10px;
}
.cat-tag {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 4px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-3);
  border: 1px solid var(--vp-c-divider);
}
.meta {
  display: flex;
  gap: 14px;
  font-family: var(--shader-display-font);
  font-size: 12px;
  color: var(--vp-c-text-3);
  font-variant-numeric: tabular-nums;
}
.m {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

/* ===== 分页 ===== */
.pagination {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 14px;
  margin-top: 32px;
  font-size: 13.5px;
  color: var(--vp-c-text-2);
}
.pagination button {
  padding: 8px 18px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: border-color 0.18s, color 0.18s, background-color 0.18s;
}
.pagination button:hover:not(:disabled) {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
  background: rgba(232, 163, 61, 0.06);
}
.pagination button:disabled {
  opacity: 0.4;
  cursor: default;
}
.pagination button:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

/* ===== 增强：平板 ===== */
@media (min-width: 640px) {
  .tag-bar {
    padding: 16px 18px 14px;
  }
  .tag-group {
    flex-direction: row;
    align-items: center;
    gap: 10px;
  }
  .tag-group__label {
    flex-shrink: 0;
    width: 42px;
    text-align: right;
  }
  .search-wrap {
    flex: 1 1 auto;
    min-width: 200px;
    max-width: 380px;
  }
  .shader-grid--spacious {
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 20px;
  }
  .shader-grid--dense {
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 12px;
  }
}

/* ===== 无障碍：尊重系统减弱动效偏好 ===== */
@media (prefers-reduced-motion: reduce) {
  .tag,
  .search-wrap input,
  .sort-select,
  .toggle,
  .layout-toggle button,
  .filter-tag button,
  .clear-btn,
  .card--spacious,
  .card--dense,
  .cover--spacious img,
  .cover--dense img,
  .pagination button {
    transition: none !important;
  }
  .card--spacious:hover,
  .card--dense:hover {
    transform: none;
  }
  .card--spacious:hover .cover--spacious img,
  .card--dense:hover .cover--dense img {
    transform: none;
  }
}
</style>
