<script setup>
import { computed, ref, watch } from 'vue'
import {
  allShaders,
  shaderCover,
  shaderStatus,
  shaderVersionRange,
} from '../data.js'
import ShaderList from './ShaderList.vue'

const numberFormat = new Intl.NumberFormat('zh-CN')

const total = allShaders.length
const translated = allShaders.filter((s) => s.langVersions?.length).length
const latestUpdate = allShaders.reduce((latest, s) => {
  for (const version of s.langVersions ?? []) {
    const date = String(version.updatedAt ?? '').slice(0, 10)
    if (date > latest) latest = date
  }
  return latest
}, '')

const query = ref('')
const sortBy = ref('downloads')
const selectedId = ref(allShaders[0]?.id ?? '')
const versionIndex = ref(0)

const selected = computed(
  () => allShaders.find((s) => s.id === selectedId.value) ?? allShaders[0] ?? null,
)
const versions = computed(() => selected.value?.langVersions ?? [])
const currentVersion = computed(() => versions.value[versionIndex.value] ?? null)
const selectedStatus = computed(() => shaderStatus(selected.value))
// 本站不再提供 /lang/... 直链下载，统一指向仓库内原始文件（GitHub raw）
const githubUrl = (file) => {
  if (!file) return ''
  const p = String(file).replace(/^\/+/, '')
  return `https://github.com/Kalloer1/shader-i18n-site/raw/main/site/public/${p}`
}
const directUrl = computed(() => githubUrl(currentVersion.value?.file || ''))
const quarkUrl = computed(() => currentVersion.value?.quark || selected.value?.quark || '')
const gameRange = computed(() => shaderVersionRange(selected.value))

watch(selectedId, () => {
  versionIndex.value = 0
})

function cover(shader) {
  return shaderCover(shader)
}

function initial(shader) {
  return (shader?.title ?? shader?.id ?? '?').trim().charAt(0).toUpperCase()
}

function formatNumber(value) {
  if (value == null || value === '') return '—'
  return numberFormat.format(Number(value) || 0)
}

function formatDate(value) {
  return value ? String(value).slice(0, 10) : '—'
}
</script>

<template>
  <div class="home-shell">
    <main class="home-wrap home-main">
      <section class="hero" aria-labelledby="home-hero-title">
        <h1 id="home-hero-title">找到光影，拿走汉化，三步丢进游戏</h1>
        <p class="hero-sub">
          下载 <code>zh_CN.lang</code>，放进光影包的 <code>shaders/lang/</code> 就行。
          不用注册，也不用看视频。
        </p>

        <div class="hero-search">
          <span class="hero-search__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </span>
          <label class="sr-only" for="home-search">搜索光影名或作者</label>
          <input
            id="home-search"
            v-model="query"
            type="search"
            placeholder="搜光影名或作者，比如 BSL、Complementary"
            autocomplete="off"
          />
        </div>

        <p class="hero-meta">
          <span><b>{{ formatNumber(total) }}</b> 个光影里，<b>{{ formatNumber(translated) }}</b> 个已有汉化</span>
          <span v-if="latestUpdate">数据更新于 <time :datetime="latestUpdate">{{ latestUpdate }}</time></span>
        </p>
      </section>

      <section v-if="selected" id="dl-panel" class="dl-bar" aria-labelledby="dl-bar-title">
        <div class="dl-bar__row">
          <span class="dl-bar__cover">
            <img
              v-if="cover(selected)"
              :src="cover(selected)"
              alt=""
              width="44"
              height="44"
              loading="lazy"
              decoding="async"
              referrerpolicy="no-referrer"
            />
            <span v-else aria-hidden="true">{{ initial(selected) }}</span>
          </span>

          <div class="dl-bar__id">
            <h2 id="dl-bar-title">{{ selected.title }}</h2>
            <p>
              作者 {{ selected.author }}
              <span v-if="gameRange"> · MC {{ gameRange }}</span>
            </p>
          </div>

          <span class="status-badge" :class="`status-badge--${selectedStatus.key}`">
            {{ selectedStatus.label }}
          </span>

          <div v-if="versions.length" class="dl-bar__versions" role="group" aria-label="选择汉化版本">
            <button
              v-for="(version, index) in versions"
              :key="version.shaderVersion"
              type="button"
              class="version-tab"
              :class="{ 'version-tab--active': versionIndex === index }"
              :aria-pressed="versionIndex === index"
              :aria-label="`选择汉化版本 ${version.shaderVersion}`"
              @click="versionIndex = index"
            >
              {{ version.shaderVersion }}
            </button>
          </div>

          <div class="dl-bar__actions">
            <a
              v-if="currentVersion && quarkUrl"
              class="dl-main"
              :href="quarkUrl"
              target="_blank"
              rel="noopener noreferrer"
            >
              国内镜像
            </a>
            <button
              v-else
              type="button"
              class="dl-main"
              :aria-describedby="currentVersion && directUrl ? 'quark-unavailable' : undefined"
              disabled
            >
              {{ currentVersion ? '国内镜像不可用' : '暂无汉化文件' }}
            </button>

            <a
              v-if="directUrl"
              class="dl-alt"
              :href="directUrl"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
            <button v-else type="button" class="dl-alt" disabled>GitHub</button>
          </div>
        </div>

        <p v-if="currentVersion && !quarkUrl" id="quark-unavailable" class="dl-bar__note">
          当前版本暂无国内镜像，请用 GitHub 直链下载。
        </p>

        <details v-if="versions.length" class="dl-bar__steps">
          <summary>装进游戏 · 三步</summary>
          <div class="dl-bar__steps-body">
            <ol>
              <li>解压光影包，找到包里的 <code>shaders</code> 文件夹。</li>
              <li>把下载的 <code>zh_CN.lang</code> 放进 <code>shaders/lang/</code>。</li>
              <li>进游戏 → 视频设置 → 光影设置 → 语言选简体中文，重进即生效。</li>
            </ol>
            <p class="dl-bar__file">
              <span>当前文件</span>
              <code>{{ directUrl || '—' }}</code>
            </p>
            <p class="dl-bar__meta">
              汉化更新 <b>{{ formatDate(currentVersion?.updatedAt) }}</b>
              · 语言版本 <b>{{ currentVersion?.langVersion || '—' }}</b>
              · Modrinth 累计下载 <b>{{ formatNumber(selected.downloads) }}</b>
            </p>
          </div>
        </details>

        <p v-else class="dl-bar__note">{{ selectedStatus.description }}</p>
      </section>

      <ShaderList
        v-model:query="query"
        v-model:sort="sortBy"
        :selected-id="selectedId"
        @select="selectedId = $event"
      />
    </main>
  </div>
</template>

<style scoped>
.home-shell {
  min-height: 100vh;
  font-size: 15px;
  line-height: 1.65;
  color: var(--mc-text);
}

.home-shell *,
.home-shell *::before,
.home-shell *::after {
  box-sizing: border-box;
}

.home-wrap {
  width: 100%;
  max-width: calc(var(--sh-content-max) + 2 * var(--sh-gutter));
  margin-inline: auto;
  padding-inline: var(--sh-gutter);
}

.home-main {
  padding-bottom: 56px;
}

/* ---------- 首屏：标题 + 搜索 ---------- */
.hero {
  padding: 44px 0 26px;
  max-width: 760px;
}

.hero h1 {
  font-family: var(--shader-display-font);
  font-size: 30px;
  font-weight: 700;
  line-height: 1.35;
  margin: 0 0 12px;
  color: var(--mc-text);
  text-shadow: 3px 3px 0 rgba(0, 0, 0, 0.6);
  text-wrap: balance;
  border: none;
  padding: 0;
}

.hero-sub {
  margin: 0 0 22px;
  font-size: 15px;
  line-height: 1.75;
  color: var(--mc-text-dim);
  max-width: 34em;
}

.hero-sub code {
  font-family: var(--shader-num-font);
  font-size: 0.86em;
  background: var(--mc-slot);
  border: 1px solid var(--mc-border);
  padding: 1px 5px;
  color: var(--mc-torch);
}

/* 搜索框：石槽 + 火把色聚焦 */
.hero-search {
  position: relative;
  display: flex;
  align-items: center;
  max-width: 620px;
}

.hero-search__icon {
  position: absolute;
  left: 16px;
  display: inline-flex;
  color: var(--mc-text-faint);
  pointer-events: none;
}

.hero-search input {
  width: 100%;
  height: 56px;
  padding: 0 18px 0 46px;
  font-family: var(--vp-font-family-base);
  font-size: 16px;
  color: var(--mc-text);
  background: var(--mc-slot);
  border: 3px solid var(--mc-border);
  border-radius: 0;
  box-shadow: var(--mc-bevel-in);
  outline: none;
}

.hero-search input::placeholder {
  color: var(--mc-text-faint);
}

.hero-search input:focus-visible {
  border-color: var(--mc-torch);
  box-shadow: var(--mc-bevel-in), 0 0 0 3px rgba(240, 164, 55, 0.25);
  outline: none;
}

.hero-search input::-webkit-search-cancel-button {
  filter: invert(0.7);
}

.hero-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  margin: 16px 0 0;
  font-size: 12.5px;
  color: var(--mc-text-faint);
}

.hero-meta b {
  font-family: var(--shader-num-font);
  font-weight: 700;
  color: var(--mc-text-dim);
  font-variant-numeric: tabular-nums;
}

/* ---------- 下载栏：粘在导航下方 ---------- */
.dl-bar {
  position: sticky;
  top: var(--vp-nav-height, 64px);
  z-index: 12;
  margin-bottom: 28px;
  background: var(--mc-stone);
  border: 2px solid var(--mc-border);
  box-shadow: var(--mc-bevel-out), 0 6px 0 var(--mc-void);
  scroll-margin-top: calc(var(--vp-nav-height, 64px) + 8px);
}

.dl-bar__row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  flex-wrap: wrap;
}

.dl-bar__cover {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  overflow: hidden;
  background: var(--mc-slot);
  border: 2px solid var(--mc-border);
  box-shadow: var(--mc-bevel-in);
  font-family: var(--shader-display-font);
  font-size: 18px;
  color: var(--mc-text-faint);
}

.dl-bar__cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.dl-bar__id {
  min-width: 0;
  flex: 1 1 200px;
}

.dl-bar__id h2 {
  font-family: var(--shader-display-font);
  font-size: 17px;
  font-weight: 700;
  line-height: 1.25;
  margin: 0;
  color: var(--mc-text);
  text-shadow: var(--mc-text-shadow-sm);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dl-bar__id p {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--mc-text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 版本标签：横向可滚，不换行挤压 */
.dl-bar__versions {
  display: flex;
  gap: 6px;
  flex: 0 1 auto;
  min-width: 0;
  overflow-x: auto;
  padding: 2px;
  scrollbar-width: thin;
  scrollbar-color: var(--mc-border) transparent;
}

.version-tab {
  flex: none;
  font-family: var(--vp-font-family-base);
  font-size: 12.5px;
  font-weight: 700;
  padding: 7px 11px;
  color: var(--mc-text-dim);
  background: var(--mc-stone-hi);
  border: 2px solid var(--mc-border);
  border-radius: 0;
  box-shadow: var(--mc-bevel-out);
  cursor: pointer;
  white-space: nowrap;
  text-shadow: var(--mc-text-shadow-sm);
}

.version-tab:hover {
  background: var(--mc-stone-raised);
  color: var(--mc-text);
}

.version-tab--active {
  background: var(--mc-torch);
  color: #2a1600;
  box-shadow: var(--mc-bevel-in);
  text-shadow: none;
}

.dl-bar__actions {
  display: flex;
  gap: 8px;
  flex: none;
  margin-left: auto;
}

.dl-main,
.dl-alt {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--shader-display-font);
  font-weight: 700;
  font-size: 13px;
  padding: 0 18px;
  height: 44px;
  border: 2px solid var(--mc-border);
  border-radius: 0;
  text-decoration: none !important;
  white-space: nowrap;
  cursor: pointer;
}

.dl-main {
  background: var(--mc-torch);
  color: #2a1600 !important;
  box-shadow: var(--mc-bevel-out);
  text-shadow: 1px 1px 0 rgba(255, 255, 255, 0.25);
}

.dl-main:hover:not(:disabled) {
  background: #ffb44f;
}

.dl-main:active:not(:disabled) {
  box-shadow: var(--mc-bevel-in);
}

.dl-main:disabled {
  background: var(--mc-stone-hi);
  color: var(--mc-text-faint) !important;
  box-shadow: var(--mc-bevel-in);
  cursor: not-allowed;
  text-shadow: none;
}

.dl-alt {
  background: var(--mc-stone-raised);
  color: var(--mc-text) !important;
  box-shadow: var(--mc-bevel-out);
  text-shadow: var(--mc-text-shadow-sm);
}

.dl-alt:hover:not(:disabled) {
  background: #3e342a;
}

.dl-alt:disabled {
  background: var(--mc-stone);
  color: var(--mc-text-faint) !important;
  box-shadow: var(--mc-bevel-in);
  cursor: not-allowed;
  text-shadow: none;
}

.dl-bar__note {
  margin: 0;
  padding: 0 14px 12px;
  font-size: 12.5px;
  color: var(--mc-text-faint);
}

/* 安装步骤折叠：整条栏的动作 */
.dl-bar__steps {
  border-top: 2px solid var(--mc-border);
  background: var(--mc-slot);
}

.dl-bar__steps summary {
  padding: 9px 14px;
  font-family: var(--shader-display-font);
  font-size: 12px;
  font-weight: 700;
  color: var(--mc-text-dim);
  cursor: pointer;
  list-style: none;
  user-select: none;
  text-shadow: var(--mc-text-shadow-sm);
}

.dl-bar__steps summary::-webkit-details-marker {
  display: none;
}

.dl-bar__steps summary::before {
  content: '';
  display: inline-block;
  width: 8px;
  height: 8px;
  background: var(--mc-torch);
  border: 2px solid var(--mc-border);
  margin-right: 10px;
}

.dl-bar__steps summary:hover {
  color: var(--mc-text);
}

.dl-bar__steps summary:focus-visible {
  outline: 3px solid var(--mc-torch);
  outline-offset: -3px;
}

.dl-bar__steps-body {
  padding: 4px 16px 16px 36px;
  font-size: 13.5px;
  color: var(--mc-text-dim);
}

.dl-bar__steps-body ol {
  margin: 0 0 12px;
  padding-left: 18px;
  line-height: 1.8;
}

.dl-bar__steps-body li {
  margin-bottom: 4px;
}

.dl-bar__steps-body code {
  font-family: var(--shader-num-font);
  font-size: 0.86em;
  background: var(--mc-stone);
  border: 1px solid var(--mc-border);
  padding: 1px 5px;
  color: var(--mc-torch);
}

.dl-bar__file {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--mc-text-faint);
}

.dl-bar__file code {
  flex: 1 1 260px;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--mc-text-dim);
}

.dl-bar__meta {
  margin: 0;
  font-size: 12px;
  color: var(--mc-text-faint);
}

.dl-bar__meta b {
  font-family: var(--shader-num-font);
  color: var(--mc-text-dim);
  font-variant-numeric: tabular-nums;
}

/* ---------- 响应式 ---------- */
@media (max-width: 900px) {
  /* 版本标签回到标题下方（order 保持在 id 之后），按钮单独占一行 */
  .dl-bar__versions {
    order: 2;
    flex-basis: 100%;
  }

  .dl-bar__actions {
    order: 3;
    flex-basis: 100%;
    margin-left: 0;
  }

  .dl-main,
  .dl-alt {
    flex: 1;
    height: 46px;
  }
}

@media (max-width: 640px) {
  .hero {
    padding: 28px 0 20px;
  }

  .hero h1 {
    font-size: 24px;
  }

  .hero-search input {
    height: 50px;
    font-size: 16px; /* 16px 起 iOS 聚焦不缩放 */
  }

  .dl-bar {
    position: static;
    box-shadow: var(--mc-bevel-out);
  }

  .dl-bar__row {
    gap: 10px;
    padding: 10px;
  }

  .dl-bar__id {
    flex: 1 1 0;
  }

  /* 窄屏允许光影名折行，截断成 "Complementary Sh…" 反而认不出是哪个 */
  .dl-bar__id h2 {
    white-space: normal;
    overflow: visible;
    font-size: 15px;
  }

  .dl-bar__id p {
    white-space: normal;
    overflow: visible;
  }
}
</style>
