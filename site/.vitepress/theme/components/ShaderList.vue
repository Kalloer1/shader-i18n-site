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
      <p>点任意一行，上方下载栏会切换到它</p>
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
      <span class="result-count" role="status" aria-live="polite">
        显示 <b>{{ formatDownloads(filtered.length) }}</b> / {{ formatDownloads(allShaders.length) }} 个光影
      </span>
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
            <td class="num" data-label="下载量">{{ formatDownloads(shader.downloads) }}</td>
            <td class="version" data-label="汉化版本">{{ shader.langVersions?.[0]?.shaderVersion || '—' }}</td>
            <td class="version" data-label="MC 版本">{{ range(shader) }}</td>
            <td data-label="状态">
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
  color: var(--mc-text);
}

.list-head {
  display: flex;
  align-items: baseline;
  gap: 14px;
  margin: 0 0 14px;
}

.list-head h2 {
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  color: var(--mc-text);
  font-family: var(--shader-display-font);
  font-size: 18px;
  font-weight: 700;
  line-height: 1.35;
  text-shadow: var(--mc-text-shadow);
}

.list-head p {
  margin: 0;
  color: var(--mc-text-faint);
  font-size: 12.5px;
}

/* 筛选：物品槽里的一排石按钮 */
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 14px;
}

.filter-button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 12px;
  border: 2px solid var(--mc-border);
  border-radius: 0;
  background: var(--mc-stone);
  color: var(--mc-text-dim);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: var(--mc-bevel-out);
}

.filter-button span {
  color: var(--mc-text-faint);
  font-family: var(--shader-num-font);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.filter-button:hover {
  background: var(--mc-stone-hi);
  color: var(--mc-text);
}

.filter-button--active {
  background: var(--mc-torch);
  color: #2a1600;
  box-shadow: var(--mc-bevel-in);
  font-weight: 700;
}

.filter-button--active span {
  color: #6b3d00;
}

.list-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.result-count {
  color: var(--mc-text-faint);
  font-size: 12.5px;
}

.result-count b {
  color: var(--mc-text-dim);
  font-family: var(--shader-num-font);
  font-variant-numeric: tabular-nums;
}

.view-toggle {
  display: inline-flex;
  flex: none;
  gap: 0;
  margin-left: auto;
  border: 2px solid var(--mc-border);
  box-shadow: var(--mc-bevel-out);
}

.view-toggle__btn {
  padding: 6px 14px;
  border: 0;
  border-radius: 0;
  background: var(--mc-stone);
  color: var(--mc-text-faint);
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 700;
  cursor: pointer;
}

.view-toggle__btn + .view-toggle__btn {
  border-left: 2px solid var(--mc-border);
}

.view-toggle__btn--active {
  background: var(--mc-torch);
  color: #2a1600;
}

/* ---------- 画廊 ---------- */
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
  border: 2px solid var(--mc-border);
  border-radius: 0;
  background: var(--mc-stone);
  color: inherit;
  text-decoration: none;
  box-shadow: var(--mc-bevel-out);
}

.shader-card:hover {
  border-color: var(--mc-torch-deep);
  background: var(--mc-stone-hi);
}

.shader-card__cover {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  background: var(--mc-slot);
  border-bottom: 2px solid var(--mc-border);
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
  color: var(--mc-text-faint);
  font-family: var(--shader-display-font);
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
  color: var(--mc-text);
  font-size: 13.5px;
  font-weight: 700;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shader-card__cn {
  overflow: hidden;
  color: var(--mc-text-faint);
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
  color: var(--mc-text-faint);
  font-family: var(--shader-num-font);
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
  border: 2px solid var(--mc-border);
  border-radius: 0;
  background: var(--mc-slot);
  box-shadow: var(--mc-bevel-in);
  color: var(--mc-text-dim);
  text-align: center;
}

/* ---------- 列表 ---------- */
.table-scroll {
  overflow-x: auto;
  border: 2px solid var(--mc-border);
  border-radius: 0;
  background: var(--mc-stone);
  box-shadow: var(--mc-bevel-out);
  scrollbar-width: thin;
  scrollbar-color: var(--mc-border) transparent;
}

table {
  width: 100%;
  min-width: 840px;
  border-collapse: collapse;
  font-size: 13.5px;
}

thead th {
  padding: 10px 14px;
  border-bottom: 2px solid var(--mc-border);
  background: var(--mc-slot);
  color: var(--mc-text-faint);
  font-family: var(--shader-display-font);
  font-size: 11px;
  font-weight: 700;
  text-align: left;
  white-space: nowrap;
}

tbody td {
  padding: 10px 14px;
  border-bottom: 1px solid #2a231d;
  vertical-align: middle;
}

tbody tr:last-child td {
  border-bottom: 0;
}

tbody tr {
  cursor: pointer;
}

tbody tr:hover {
  background: var(--mc-stone-hi);
}

/* 选中行：像被放进物品槽里一样凹下去，左侧一条火把色 */
tbody tr.row-selected {
  background: var(--mc-slot);
  box-shadow: inset 4px 0 0 var(--mc-torch);
}

tbody tr:focus-visible {
  outline: 3px solid var(--mc-torch);
  outline-offset: -3px;
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
  width: 34px;
  height: 34px;
  overflow: hidden;
  border: 2px solid var(--mc-border);
  border-radius: 0;
  background: var(--mc-slot);
  box-shadow: var(--mc-bevel-in);
  color: var(--mc-text-faint);
  font-family: var(--shader-display-font);
  font-size: 13px;
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
  color: var(--mc-text);
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-title span {
  display: block;
  overflow: hidden;
  color: var(--mc-text-faint);
  font-size: 12px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.num,
.version {
  font-family: var(--shader-num-font);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.num {
  color: var(--mc-text-faint);
  font-size: 12px;
}

.version {
  color: var(--mc-text-dim);
  font-size: 12px;
}

/* 状态徽章：矿石色，方块形 */
.status-badge {
  display: inline-flex;
  align-items: center;
  padding: 3px 9px;
  border: 2px solid var(--mc-border);
  border-radius: 0;
  background: var(--mc-stone-hi);
  color: var(--mc-text-faint);
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
  box-shadow: var(--mc-bevel-out);
  text-shadow: var(--mc-text-shadow-sm);
}

.status-badge--translated {
  background: var(--mc-emerald-deep);
  color: #eafff0;
}

.status-badge--native {
  background: var(--mc-lapis-deep);
  color: #ecf5ff;
}

.status-badge--missing {
  background: var(--mc-redstone-deep);
  color: #ffe9e6;
}

.status-badge--none {
  background: var(--mc-stone);
  color: var(--mc-text-faint);
  box-shadow: var(--mc-bevel-in);
  text-shadow: none;
}

.action-cell {
  text-align: right;
}

.row-action {
  display: inline-flex;
  align-items: center;
  padding: 6px 14px;
  border: 2px solid var(--mc-border);
  border-radius: 0;
  background: var(--mc-stone-raised);
  color: var(--mc-text);
  font-family: var(--shader-display-font);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  text-decoration: none;
  white-space: nowrap;
  box-shadow: var(--mc-bevel-out);
  text-shadow: var(--mc-text-shadow-sm);
}

.row-action:hover {
  background: var(--mc-torch);
  color: #2a1600;
  text-shadow: none;
}

.shader-list :where(button, input, [tabindex]):focus-visible {
  outline: 3px solid var(--mc-torch);
  outline-offset: 2px;
}

@media (max-width: 720px) {
  .list-head {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
  }

  .filter-bar {
    flex-wrap: wrap;
  }

  .filter-button {
    flex: none;
    min-height: var(--tap-min);
  }

  .view-toggle__btn {
    min-height: var(--tap-min);
  }

  /* 表格 → 卡片堆叠 */
  table {
    display: block;
    min-width: 0;
  }

  thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }

  tbody {
    display: block;
  }

  tbody tr {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    padding: 12px 14px;
    border-bottom: 1px solid #2a231d;
  }

  tbody tr:last-child {
    border-bottom: 0;
  }

  tbody tr.row-selected {
    box-shadow: inset 4px 0 0 var(--mc-torch);
  }

  tbody td {
    display: block;
    padding: 0;
    border-bottom: 0;
  }

  tbody td:first-child {
    flex: 1 1 100%;
  }

  tbody td[data-label]::before {
    content: attr(data-label) ' ';
    color: var(--mc-text-faint);
    font-size: 12px;
  }

  .action-cell {
    flex: 1 1 100%;
    text-align: left;
  }

  .list-toolbar {
    align-items: stretch;
    flex-direction: column;
    gap: 8px;
  }

  .result-count {
    margin-left: 0;
  }

  .view-toggle {
    margin-left: 0;
    align-self: flex-start;
  }

  .row-action {
    width: 100%;
    min-height: var(--tap-min);
    justify-content: center;
    padding: 10px 15px;
  }
}
</style>
