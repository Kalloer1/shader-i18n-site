<script setup>
import { computed, ref, watch } from 'vue'
import { allShaders } from '../data.js'

const keyword = ref('')
const onlyWithLang = ref(false)
const sortBy = ref('downloads')
const layoutMode = ref('spacious') // spacious | dense
const selectedCategories = ref(new Set())
const PAGE_SIZE = computed(() => layoutMode.value === 'dense' ? 30 : 18)
const page = ref(1)

// 分类标签分组 — 直接平铺在页面顶部
const categoryGroups = [
  {
    label: '性能',
    options: ['potato', 'low', 'medium', 'high']
  },
  {
    label: '风格',
    options: ['vanilla-like', 'atmosphere', 'realistic', 'semi-realistic', 'fantasy', 'cartoon', 'cursed']
  },
  {
    label: '特效',
    options: ['colored-lighting', 'reflections', 'bloom', 'shadows', 'pbr', 'path-tracing']
  },
  {
    label: '加载器',
    options: ['iris', 'optifine']
  }
]

const sortOptions = [
  { value: 'downloads', label: '按下载量' },
  { value: 'name', label: '按名称' },
  { value: 'newest', label: '按更新时间' }
]

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  let list = allShaders.filter((s) => {
    if (onlyWithLang.value && !s.langVersions.length) return false
    if (selectedCategories.value.size > 0) {
      const cats = s.categories ?? []
      const hasAny = [...selectedCategories.value].some(c => cats.includes(c))
      if (!hasAny) return false
    }
    if (!kw) return true
    return [s.id, s.nameCN, s.title, s.author]
      .filter(Boolean)
      .some((v) => v.toLowerCase().includes(kw))
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

watch([keyword, onlyWithLang, sortBy, layoutMode], () => { page.value = 1 })
watch(selectedCategories, () => { page.value = 1 }, { deep: true })

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
  let min = null, max = null
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
  <div class="shader-list">
    <!-- 分类标签 — 直接平铺在最顶部 -->
    <div class="tag-bar">
      <div v-for="group in categoryGroups" :key="group.label" class="tag-group">
        <span class="tag-group__label">{{ group.label }}</span>
        <div class="tag-group__tags">
          <button
            v-for="cat in group.options"
            :key="cat"
            class="tag"
            :class="{ active: selectedCategories.has(cat) }"
            @click="toggleCategory(cat)"
          >{{ cat }}</button>
        </div>
      </div>
    </div>

    <!-- 工具栏：搜索 + 排序 + 切换 -->
    <div class="toolbar">
      <div class="search-wrap">
        <svg class="ico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input v-model="keyword" type="search" :placeholder="`搜索 ${allShaders.length} 个光影…`" />
      </div>

      <select v-model="sortBy" class="sort-select">
        <option v-for="opt in sortOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>

      <label class="toggle">
        <input v-model="onlyWithLang" type="checkbox" />
        <span>仅看已有汉化</span>
      </label>

      <div class="layout-toggle">
        <button :class="{ active: layoutMode === 'spacious' }" @click="layoutMode = 'spacious'" title="分散型">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
        </button>
        <button :class="{ active: layoutMode === 'dense' }" @click="layoutMode = 'dense'" title="紧密型">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="4" height="4" rx="0.5" /><rect x="10" y="3" width="4" height="4" rx="0.5" /><rect x="17" y="3" width="4" height="4" rx="0.5" /><rect x="3" y="10" width="4" height="4" rx="0.5" /><rect x="10" y="10" width="4" height="4" rx="0.5" /><rect x="17" y="10" width="4" height="4" rx="0.5" /><rect x="3" y="17" width="4" height="4" rx="0.5" /><rect x="10" y="17" width="4" height="4" rx="0.5" /><rect x="17" y="17" width="4" height="4" rx="0.5" /></svg>
        </button>
      </div>
    </div>

    <!-- 结果统计 -->
    <div class="result-bar">
      <span class="result-count">共 {{ filtered.length }} 个光影</span>
      <div v-if="selectedCategories.size > 0 || keyword || onlyWithLang" class="active-filters">
        <span v-for="cat in selectedCategories" :key="cat" class="filter-tag">
          {{ cat }}
          <button @click="toggleCategory(cat)">×</button>
        </span>
        <button class="clear-btn" @click="clearFilters">清除全部</button>
      </div>
    </div>

    <p v-if="!filtered.length" class="empty">没有匹配的光影。</p>

    <!-- 紧凑型 -->
    <div v-if="layoutMode === 'dense'" class="shader-grid shader-grid--dense">
      <a v-for="s in pageItems" :key="s.id" class="card card--dense" :href="`/shaders/${s.id}`">
        <div class="cover cover--dense" :style="!cover(s) ? tint(s) : undefined">
          <img v-if="cover(s)" :src="cover(s)" :alt="s.title" loading="lazy" />
          <span v-else class="fallback">{{ initial(s) }}</span>
          <span class="badge badge--sm" :class="hasLang(s) ? 'ok' : s.hasNativeZhCN ? 'nat' : 'none'">{{ langBadge(s) }}</span>
        </div>
        <div class="body body--dense">
          <div class="name name--dense">{{ s.title }}</div>
          <div class="meta">
            <span class="m">
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></svg>
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
          <img v-if="cover(s)" :src="cover(s)" :alt="s.title" loading="lazy" />
          <span v-else class="fallback fallback--lg">{{ initial(s) }}</span>
          <span class="badge" :class="hasLang(s) ? 'ok' : s.hasNativeZhCN ? 'nat' : 'none'">{{ langBadge(s) }}</span>
        </div>
        <div class="body body--spacious">
          <div class="name">{{ s.title }}</div>
          <div class="sub">{{ s.nameCN || s.id }}<template v-if="s.author"> · {{ s.author }}</template></div>
          <div class="cats" v-if="s.categories?.length">
            <span v-for="cat in s.categories.slice(0, 3)" :key="cat" class="cat-tag">{{ cat }}</span>
          </div>
          <div class="meta">
            <span class="m">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></svg>
              {{ formatDownloads(s.downloads) }}
            </span>
            <span v-if="range(s)" class="m">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 2v4M16 2v4M3 10h18" /></svg>
              {{ range(s) }}
            </span>
          </div>
        </div>
      </a>
    </div>

    <div v-if="totalPages > 1" class="pagination">
      <button :disabled="page <= 1" @click="page--">← 上一页</button>
      <span>第 {{ page }} / {{ totalPages }} 页</span>
      <button :disabled="page >= totalPages" @click="page++">下一页 →</button>
    </div>
  </div>
</template>

<style scoped>
.shader-list {
  max-width: 1200px;
  margin: 0 auto;
}

/* ===== 标签栏 — 平铺在顶部 ===== */
.tag-bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
  padding: 14px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
}
.tag-group {
  display: flex;
  align-items: center;
  gap: 10px;
}
.tag-group__label {
  flex-shrink: 0;
  width: 42px;
  font-size: 12px;
  font-weight: 600;
  color: var(--vp-c-text-3);
  text-align: right;
}
.tag-group__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tag {
  padding: 4px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: transparent;
  color: var(--vp-c-text-2);
  font-size: 12.5px;
  cursor: pointer;
  transition: all 0.2s;
  user-select: none;
}
.tag:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}
.tag.active {
  background: var(--vp-c-brand-1);
  color: #fff;
  border-color: var(--vp-c-brand-1);
}
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);

/* ===== 工具栏 ===== */
.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.search-wrap {
  position: relative;
  flex: 1;
  min-width: 200px;
  max-width: 380px;
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
  padding: 9px 14px 9px 36px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-size: 13px;
}
.search-wrap input:focus {
  outline: none;
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 0 0 3px rgba(232, 163, 61, 0.15);
}
.sort-select {
  padding: 9px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-size: 13px;
  cursor: pointer;
}
.sort-select:focus {
  outline: none;
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 0 0 3px rgba(232, 163, 61, 0.15);
}
.toggle {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 13px;
  cursor: pointer;
  color: var(--vp-c-text-3);
  user-select: none;
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
  border-radius: 8px;
  overflow: hidden;
}
.layout-toggle button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-3);
  cursor: pointer;
  transition: all 0.2s;
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
  color: #fff;
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
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(232, 163, 61, 0.15);
  color: var(--vp-c-brand-1);
  font-size: 12px;
}
  border: 1px solid rgba(232, 163, 61, 0.25);
.filter-tag button {
  border: none;
  background: none;
  color: var(--vp-c-brand-1);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0;
  opacity: 0.7;
  transition: opacity 0.15s;
}
.filter-tag button:hover {
  opacity: 1;
}

.clear-btn {
  border: none;
  background: none;
  color: var(--vp-c-text-3);
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
}
.clear-btn:hover {
  color: #e55;
}
.card--spacious:focus-visible,
.card--dense:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

.empty {
  color: var(--vp-c-text-3);
  text-align: center;
  padding: 48px 0;
}

/* ===== 分散型网格 ===== */
.shader-grid--spacious {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 20px;
}
.card--spacious {
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  overflow: hidden;
  background: var(--vp-c-bg-soft);
  transition: transform 0.25s ease, border-color 0.25s, box-shadow 0.25s;
}
.card--spacious:hover {
  transform: translateY(-4px);
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.4);
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
  transition: transform 0.4s ease;
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
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
}
.card--dense {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  overflow: hidden;
  background: var(--vp-c-bg-soft);
  transition: transform 0.2s, border-color 0.2s, box-shadow 0.2s;
}
.card--dense:hover {
  transform: translateY(-2px);
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
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
  transition: transform 0.3s;
}
.card--dense:hover .cover--dense img {
  transform: scale(1.04);
}
.body--dense {
  padding: 8px 10px 10px;
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
  font-family: 'Chakra Petch', var(--vp-font-family-base);
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
  border-radius: 4px;
  font-family: var(--vp-font-family-base);
  backdrop-filter: blur(6px);
}
.badge--sm {
  font-size: 10px;
  padding: 2px 7px;
}
.badge.ok {
  background: rgba(79, 178, 134, 0.92);
  color: #0c1712;
}
.badge.none {
  background: rgba(13, 17, 23, 0.72);
  color: #aab4c0;
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
  font-family: 'Chakra Petch', var(--vp-font-family-base);
  font-size: 12px;
  color: var(--vp-c-text-3);
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
  gap: 16px;
  margin-top: 28px;
  font-size: 14px;
  color: var(--vp-c-text-2);
}
.pagination button {
  padding: 6px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  cursor: pointer;
  transition: all 0.2s;
}
.pagination button:hover:not(:disabled) {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}
.pagination button:disabled {
  opacity: 0.4;
  cursor: default;
}
.pagination button:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

/* ===== 响应式 ===== */
@media (max-width: 768px) {
  .shader-list {
    padding: 0 2px;
  }
  .shader-grid--spacious {
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 14px;
  }
  .shader-grid--dense {
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 8px;
  }
  .tag-bar {
    padding: 10px 12px;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .tag-bar::-webkit-scrollbar {
    display: none;
  }
  .tag-group {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }
  .tag-group__label {
    width: auto;
    text-align: left;
  }
  .tag {
    font-size: 11px;
    padding: 3px 9px;
  }
  .toolbar {
    gap: 6px;
  }
  .search-wrap {
    min-width: 150px;
    max-width: none;
    flex: 1 1 100%;
  }
}
</style>
