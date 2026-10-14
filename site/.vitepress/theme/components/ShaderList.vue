<script setup>
import { computed, ref } from 'vue'
import {
  allShaders,
  shaderCover,
  shaderStatus,
  shaderVersionRange,
} from '../data.js'

const props = defineProps({
  query: {
    type: String,
    default: '',
  },
  sort: {
    type: String,
    default: 'downloads',
  },
  selectedId: {
    type: String,
    default: '',
  },
})

const emit = defineEmits(['update:query', 'update:sort', 'select'])
const activeFilter = ref('all')
const viewMode = ref(
  typeof localStorage !== 'undefined' && localStorage.getItem('shader-view-mode') === 'gallery'
    ? 'gallery'
    : 'list',
)
const numberFormat = new Intl.NumberFormat('zh-CN')

const filterOptions = computed(() => [
  { value: 'all', label: '全部', count: allShaders.length },
  {
    value: 'translated',
    label: '已有汉化',
    count: allShaders.filter((s) => shaderStatus(s).key === 'translated').length,
  },
  {
    value: 'native',
    label: '自带中文',
    count: allShaders.filter((s) => shaderStatus(s).key === 'native').length,
  },
  {
    value: 'missing',
    label: '无英文源',
    count: allShaders.filter((s) => shaderStatus(s).key === 'missing').length,
  },
  {
    value: 'none',
    label: '暂无汉化',
    count: allShaders.filter((s) => shaderStatus(s).key === 'none').length,
  },
  {
    value: 'potato',
    label: '土豆机可跑',
    count: allShaders.filter((s) => s.categories?.includes('potato')).length,
  },
])

const filtered = computed(() => {
  const keyword = props.query.trim().toLowerCase()
  let list = allShaders.filter((shader) => {
    if (activeFilter.value === 'potato') {
      if (!shader.categories?.includes('potato')) return false
    } else if (activeFilter.value !== 'all') {
      if (shaderStatus(shader).key !== activeFilter.value) return false
    }

    if (!keyword) return true
    return [shader.id, shader.nameCN, shader.title, shader.author]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(keyword))
  })

  if (props.sort === 'name') {
    list = [...list].sort((a, b) => (a.title ?? a.id).localeCompare(b.title ?? b.id))
  } else if (props.sort === 'newest') {
    list = [...list].sort((a, b) => {
      const aDate = a.langVersions?.[0]?.updatedAt ?? ''
      const bDate = b.langVersions?.[0]?.updatedAt ?? ''
      return bDate.localeCompare(aDate)
    })
  } else {
    list = [...list].sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0))
  }

  return list
})

function updateQuery(event) {
  emit('update:query', event.target.value)
}

function setViewMode(mode) {
  viewMode.value = mode
  try {
    localStorage.setItem('shader-view-mode', mode)
  } catch {
    /* 隐私模式等场景下忽略持久化失败 */
  }
}

function selectShader(id) {
  emit('select', id)
}

function status(shader) {
  return shaderStatus(shader)
}

function cover(shader) {
  return shaderCover(shader)
}

function initial(shader) {
  return (shader?.title ?? shader?.id ?? '?').trim().charAt(0).toUpperCase()
}

function range(shader) {
  return shaderVersionRange(shader) || '—'
}

function formatDownloads(value) {
  if (value == null) return '—'
  return numberFormat.format(Number(value) || 0)
}

function actionLabel(shader) {
  return shaderStatus(shader).key === 'translated' ? '拿文件' : '查看'
}
</script>

<template>
  <section id="shader-list" class="shader-list" aria-labelledby="shader-list-title">
    <div class="list-head">
      <h2 id="shader-list-title">全部光影</h2>
      <p>按下载量排序 · 列表/画廊可切换 · 点行切换上方下载面板</p>
    </div>

    <div class="filter-bar" role="group" aria-label="筛选光影状态">
      <button
        v-for="option in filterOptions"
        :key="option.value"
        type="button"
        class="filter-button"
        :class="{ 'filter-button--active': activeFilter === option.value }"
        :aria-pressed="activeFilter === option.value"
        @click="activeFilter = option.value"
      >
        {{ option.label }}
        <span>{{ formatDownloads(option.count) }}</span>
      </button>
    </div>

    <div class="list-toolbar">
      <label class="list-search">
        <span class="sr-only">搜索光影名或作者</span>
        <input
          :value="query"
          type="search"
          placeholder="搜索光影名或作者"
          autocomplete="off"
          @input="updateQuery"
        />
      </label>
      <div class="view-toggle" role="group" aria-label="切换视图">
        <button
          type="button"
          class="view-toggle__btn"
          :class="{ 'view-toggle__btn--active': viewMode === 'list' }"
          :aria-pressed="viewMode === 'list'"
          @click="setViewMode('list')"
        >
          列表
        </button>
        <button
          type="button"
          class="view-toggle__btn"
          :class="{ 'view-toggle__btn--active': viewMode === 'gallery' }"
          :aria-pressed="viewMode === 'gallery'"
          @click="setViewMode('gallery')"
        >
          画廊
        </button>
      </div>
      <span class="result-count" role="status" aria-live="polite">
        当前显示 <b>{{ formatDownloads(filtered.length) }}</b> 个光影
      </span>
    </div>

    <p v-if="!filtered.length" class="empty-state" role="status">没有匹配的光影，请调整搜索或筛选条件。</p>

    <div v-else-if="viewMode === 'list'" class="table-scroll" tabindex="0" aria-label="光影列表，可横向滚动">
      <table>
        <thead>
          <tr>
            <th scope="col">光影</th>
            <th scope="col">下载量</th>
            <th scope="col">汉化版本</th>
            <th scope="col">MC 版本</th>
            <th scope="col">状态</th>
            <th scope="col"><span class="sr-only">操作</span></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="shader in filtered"
            :key="shader.id"
            :class="{ 'row-selected': selectedId === shader.id }"
            :aria-selected="selectedId === shader.id"
            :aria-label="`${shader.title}，${status(shader).label}，选择查看下载信息`"
            tabindex="0"
            @click="selectShader(shader.id)"
            @keydown.enter.prevent="selectShader(shader.id)"
            @keydown.space.prevent="selectShader(shader.id)"
          >
            <td>
              <div class="cell-main">
                <span class="cell-thumb">
                  <img
                    v-if="cover(shader)"
                    :src="cover(shader)"
                    alt=""
                    width="32"
                    height="32"
                    loading="lazy"
                    decoding="async"
                    referrerpolicy="no-referrer"
                  />
                  <span v-else aria-hidden="true">{{ initial(shader) }}</span>
                </span>
                <span class="cell-title">
                  <b>{{ shader.title }}</b>
                  <span>{{ shader.author }}</span>
                </span>
              </div>
            </td>
            <td class="num">{{ formatDownloads(shader.downloads) }}</td>
            <td class="version">{{ shader.langVersions?.[0]?.shaderVersion || '—' }}</td>
            <td class="version">{{ range(shader) }}</td>
            <td>
              <span
                class="status-badge"
                :class="`status-badge--${status(shader).key}`"
                :title="status(shader).description"
              >
                {{ status(shader).label }}
              </span>
            </td>
            <td class="action-cell">
              <a
                class="row-action"
                :href="`/shaders/${shader.id}`"
                :aria-label="`${actionLabel(shader)}：${shader.title}`"
                @click.stop
              >
                {{ actionLabel(shader) }}
              </a>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else class="shader-grid">
      <a
        v-for="shader in filtered"
        :key="shader.id"
        class="shader-card"
        :href="`/shaders/${shader.id}`"
        :aria-label="`${shader.title}${shader.nameCN ? '（' + shader.nameCN + '）' : ''}，${status(shader).label}，进入详情页`"
      >
        <span v-if="cover(shader)" class="shader-card__cover">
          <img
            :src="cover(shader)"
            alt=""
            width="1600"
            height="900"
            loading="lazy"
            decoding="async"
            referrerpolicy="no-referrer"
          />
        </span>
        <span v-else class="shader-card__cover shader-card__cover--empty" aria-hidden="true">
          {{ initial(shader) }}
        </span>
        <span class="shader-card__body">
          <span class="shader-card__title">
            <b>{{ shader.title }}</b>
            <span v-if="shader.nameCN" class="shader-card__cn">{{ shader.nameCN }}</span>
          </span>
          <span class="shader-card__meta">
            <span
              class="status-badge"
              :class="`status-badge--${status(shader).key}`"
              :title="status(shader).description"
            >
              {{ status(shader).label }}
            </span>
            <span class="shader-card__downloads">{{ formatDownloads(shader.downloads) }} 下载</span>
            <span class="shader-card__range">{{ range(shader) }}</span>
          </span>
        </span>
      </a>
    </div>
  </section>
</template>

<style scoped>
.shader-list {
  min-width: 0;
  color: var(--home-text, #e9f0f4);
  font-family: var(--home-font-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
}

.list-head {
  display: flex;
  align-items: baseline;
  gap: 14px;
  margin: 26px 0 12px;
}

.list-head h2 {
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  color: var(--home-text, #e9f0f4);
  font-size: 19px;
  font-weight: 800;
  line-height: 1.35;
}

.list-head p {
  margin: 0;
  color: var(--home-faint, #64707b);
  font-size: 12.5px;
}

.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.filter-button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 15px;
  border: 1px solid var(--home-line, #242f3b);
  border-radius: 999px;
  background: transparent;
  color: var(--home-muted, #93a1ad);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: border-color 0.16s, background-color 0.16s, color 0.16s;
}

.filter-button span {
  color: var(--home-faint, #64707b);
  font-family: var(--home-font-mono, Consolas, monospace);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.filter-button:hover {
  border-color: #526273;
  color: var(--home-text, #e9f0f4);
}

.filter-button--active {
  border-color: var(--home-text, #e9f0f4);
  background: var(--home-text, #e9f0f4);
  color: var(--home-bg, #0b0e12);
  font-weight: 700;
}

.filter-button--active span {
  color: var(--home-bg, #0b0e12);
}

.list-toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 12px;
}

.list-search {
  flex: 1 1 auto;
  max-width: 420px;
}

.list-search input {
  width: 100%;
  height: 38px;
  padding: 0 12px;
  border: 1px solid var(--home-line, #242f3b);
  border-radius: 8px;
  background: var(--home-input, #0a0e13);
  color: var(--home-text, #e9f0f4);
  font-family: inherit;
  font-size: 13.5px;
}

.list-search input::placeholder {
  color: var(--home-faint, #64707b);
}

.result-count {
  margin-left: auto;
  color: var(--home-faint, #64707b);
  font-size: 12.5px;
}

.result-count b {
  color: var(--home-text, #e9f0f4);
  font-family: var(--home-font-mono, Consolas, monospace);
  font-variant-numeric: tabular-nums;
}

.view-toggle {
  display: inline-flex;
  flex: none;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--home-line, #242f3b);
  border-radius: 8px;
  background: var(--home-input, #0a0e13);
}

.view-toggle__btn {
  padding: 5px 12px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--home-muted, #93a1ad);
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 700;
  cursor: pointer;
}

.view-toggle__btn--active {
  background: var(--home-text, #e9f0f4);
  color: var(--home-bg, #0b0e12);
}

.shader-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.shader-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--home-line, #242f3b);
  border-radius: 12px;
  background: var(--home-bg-soft, #0e1319);
  color: inherit;
  text-decoration: none;
  transition: border-color 0.16s, transform 0.16s;
}

.shader-card:hover {
  border-color: #526273;
}

.shader-card__cover {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  background: var(--home-input, #0a0e13);
}

.shader-card__cover img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.shader-card__cover--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--home-faint, #64707b);
  font-family: var(--home-font-mono, Consolas, monospace);
  font-size: 28px;
  font-weight: 700;
}

.shader-card__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  min-width: 0;
}

.shader-card__title {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.shader-card__title b {
  overflow: hidden;
  color: var(--home-text, #e9f0f4);
  font-size: 13.5px;
  font-weight: 700;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shader-card__cn {
  overflow: hidden;
  color: var(--home-faint, #64707b);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shader-card__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  min-width: 0;
}

.shader-card__downloads,
.shader-card__range {
  color: var(--home-muted, #93a1ad);
  font-family: var(--home-font-mono, Consolas, monospace);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

@media (min-width: 600px) {
  .shader-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (min-width: 900px) {
  .shader-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (min-width: 1200px) {
  .shader-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

.empty-state {
  margin: 0;
  padding: 52px 20px;
  border: 1px solid var(--home-line-soft, #1c2530);
  border-radius: 10px;
  background: var(--home-bg-soft, #0e1319);
  color: var(--home-muted, #93a1ad);
  text-align: center;
}

.table-scroll {
  overflow-x: auto;
  border: 1px solid var(--home-line-soft, #1c2530);
  border-radius: 10px;
  background: var(--home-bg-soft, #0e1319);
  scrollbar-width: thin;
  scrollbar-color: var(--home-line, #242f3b) transparent;
}

table {
  width: 100%;
  min-width: 840px;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 13.5px;
}

thead th {
  padding: 10px 14px;
  border-bottom: 1px solid var(--home-line-soft, #1c2530);
  background: #0d1218;
  color: var(--home-faint, #64707b);
  font-size: 12px;
  font-weight: 400;
  text-align: left;
  white-space: nowrap;
}

tbody td {
  padding: 10px 14px;
  border-bottom: 1px solid var(--home-line-soft, #1c2530);
  vertical-align: middle;
}

tbody tr:last-child td {
  border-bottom: 0;
}

tbody tr {
  cursor: pointer;
  transition: background-color 0.14s, box-shadow 0.14s;
}

tbody tr:hover,
tbody tr.row-selected {
  background: #141b24;
}

tbody tr.row-selected {
  box-shadow: inset 3px 0 0 #8b96a1;
}

tbody tr:focus-visible {
  outline: 2px solid #c8d2db;
  outline-offset: -2px;
}

.cell-main {
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 0;
}

.cell-thumb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 32px;
  height: 32px;
  overflow: hidden;
  border: 1px solid var(--home-line, #242f3b);
  border-radius: 8px;
  background: var(--home-input, #0a0e13);
  color: var(--home-faint, #64707b);
  font-family: var(--home-font-mono, Consolas, monospace);
  font-size: 12px;
}

.cell-thumb img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cell-title {
  min-width: 0;
}

.cell-title b {
  display: block;
  overflow: hidden;
  color: var(--home-text, #e9f0f4);
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-title span {
  display: block;
  overflow: hidden;
  color: var(--home-faint, #64707b);
  font-size: 12px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.num,
.version {
  font-family: var(--home-font-mono, Consolas, monospace);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.num {
  color: var(--home-muted, #93a1ad);
}

.version {
  color: var(--home-text, #e9f0f4);
  font-size: 12.5px;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  padding: 3px 11px;
  border: 1px solid var(--home-line, #242f3b);
  border-radius: 999px;
  background: var(--home-input, #0a0e13);
  color: var(--home-muted, #93a1ad);
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

.status-badge--translated {
  border-color: rgba(216, 166, 87, 0.55);
  color: #d8a657;
}

.status-badge--native {
  border-color: rgba(111, 168, 220, 0.5);
  color: #8fc4ee;
}

.status-badge--missing {
  border-color: rgba(224, 122, 95, 0.52);
  color: #ef9b82;
}

.status-badge--none {
  color: var(--home-faint, #64707b);
}

.action-cell {
  text-align: right;
}

.row-action {
  display: inline-flex;
  align-items: center;
  padding: 7px 15px;
  border: 1px solid var(--home-line, #242f3b);
  border-radius: 8px;
  background: #0b1016;
  color: var(--home-text, #e9f0f4);
  font-family: inherit;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  text-decoration: none;
  white-space: nowrap;
}

.row-action:hover {
  border-color: #526273;
}

.shader-list :where(button, input, [tabindex]):focus-visible {
  outline: 2px solid #c8d2db;
  outline-offset: 2px;
}

@media (max-width: 720px) {
  .list-head {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
  }

  .filter-bar {
    flex-wrap: nowrap;
    overflow-x: auto;
    padding-bottom: 4px;
    scrollbar-width: none;
  }

  .filter-bar::-webkit-scrollbar {
    display: none;
  }

  .filter-button {
    flex: none;
  }

  .list-toolbar {
    align-items: stretch;
    flex-direction: column;
    gap: 8px;
  }

  .list-search {
    max-width: none;
  }

  .result-count {
    margin-left: 0;
  }

  .row-action {
    min-height: var(--tap-min);
    padding: 10px 15px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .filter-button,
  tbody tr {
    transition: none !important;
  }
}
</style>
