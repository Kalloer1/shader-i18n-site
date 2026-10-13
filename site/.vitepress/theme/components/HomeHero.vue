<script setup>
import { computed, ref, watch } from 'vue'
import {
  allShaders,
  shaderCover,
  shaderCoverSource,
  shaderStatus,
  shaderVersionRange,
} from '../data.js'
import ShaderList from './ShaderList.vue'

const numberFormat = new Intl.NumberFormat('zh-CN')

const total = allShaders.length
const translated = allShaders.filter((s) => s.langVersions?.length).length
const maxDownloads = allShaders.reduce((max, s) => Math.max(max, Number(s.downloads) || 0), 0)
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
const directUrl = computed(() => currentVersion.value?.file || '')
const quarkUrl = computed(() => currentVersion.value?.quark || selected.value?.quark || '')
const gameRange = computed(() => shaderVersionRange(selected.value))

watch(selectedId, () => {
  versionIndex.value = 0
})

function cover(shader) {
  return shaderCover(shader)
}

function coverSource(shader) {
  return shaderCoverSource(shader)
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
    <header class="home-topbar">
      <div class="home-wrap home-topbar__inner">
        <a class="home-brand" href="/" aria-label="光影汉化下载器首页">
          <span class="home-brand__mark" aria-hidden="true">影</span>
          <span>光影汉化下载器</span>
        </a>

        <span class="home-chip">
          <b>{{ formatNumber(total) }}</b> 收录 · <b>{{ formatNumber(translated) }}</b> 已有汉化
        </span>
        <span v-if="latestUpdate" class="home-chip home-chip--date">
          数据更新于 <time :datetime="latestUpdate">{{ latestUpdate }}</time>
        </span>

        <div class="home-topsearch">
          <span class="home-search__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </span>
          <label class="sr-only" for="home-search">搜索光影名或作者</label>
          <input
            id="home-search"
            v-model="query"
            type="search"
            placeholder="搜光影名或作者，比如 BSL、EminGT"
            autocomplete="off"
          />
          <label class="sr-only" for="home-sort">排序方式</label>
          <select id="home-sort" v-model="sortBy">
            <option value="downloads">按下载量</option>
            <option value="name">按名称</option>
            <option value="newest">按汉化更新</option>
          </select>
        </div>
      </div>
    </header>

    <main class="home-wrap home-main">
      <section class="hero-section" aria-labelledby="home-hero-title">
        <div class="hero-copy">
          <p class="hero-kicker">
            <span class="hero-kicker__dot" aria-hidden="true"></span>
            只做一件事：帮你把汉化文件拿走
          </p>
          <h1 id="home-hero-title">
            找到光影，<span>拿走汉化</span>，<br />
            三步丢进游戏。
          </h1>
          <p class="hero-lede">
            下载 <code>zh_CN.lang</code> 放进光影包里的 <code>shaders/lang/</code> 就行。
            不用注册，不用看视频教程，下面这块面板就是全部流程。
          </p>
          <div class="hero-meter" aria-label="站点数据统计">
            <div>
              <b>{{ formatNumber(total) }}</b>
              <span>收录光影</span>
            </div>
            <div>
              <b>{{ formatNumber(translated) }}</b>
              <span>已有汉化版本文件</span>
            </div>
            <div>
              <b>{{ formatNumber(maxDownloads) }}</b>
              <span>最高下载</span>
            </div>
          </div>
          <div class="hero-actions">
            <a class="home-btn home-btn--solid" href="#dl-panel">直接去下载面板</a>
            <a class="home-btn home-btn--ghost" href="#shader-list">先浏览全部光影</a>
          </div>
          <p class="hero-note">点下方列表任意行，下载面板会切换到该光影。</p>
        </div>

        <figure v-if="selected" class="hero-shot">
          <img
            v-if="cover(selected)"
            :key="selected.id"
            :src="cover(selected)"
            :alt="`${selected.title} 游戏内截图`"
            width="960"
            height="540"
            loading="eager"
            fetchpriority="high"
            decoding="async"
            referrerpolicy="no-referrer"
          />
          <span v-else class="hero-shot__fallback" aria-hidden="true">{{ initial(selected) }}</span>
          <figcaption>
            <span>{{ selected.title }} · {{ selected.author }}</span>
            <code>{{ coverSource(selected) }}</code>
          </figcaption>
        </figure>
      </section>

      <section v-if="selected" id="dl-panel" class="download-panel" aria-labelledby="download-panel-title">
        <header class="download-panel__head">
          <span class="download-panel__cover">
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
          <div class="download-panel__title">
            <h2 id="download-panel-title">{{ selected.title }}</h2>
            <p>作者 {{ selected.author }} · 适配 Iris / OptiFine</p>
          </div>
          <div class="download-panel__count">
            <b>{{ formatNumber(selected.downloads) }}</b>
            <span>Modrinth 累计下载</span>
          </div>
        </header>

        <div class="download-panel__body">
          <div class="download-panel__files">
            <div class="panel-status" :class="`panel-status--${selectedStatus.key}`">
              <span class="status-badge" :class="`status-badge--${selectedStatus.key}`">
                {{ selectedStatus.label }}
              </span>
              <span>{{ selectedStatus.description }}</span>
            </div>

            <template v-if="versions.length">
              <p class="panel-label">选你的光影版本，必须和汉化版本对应：</p>
              <div class="version-tabs" role="group" aria-label="选择汉化版本">
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

              <div class="file-card">
                <code>{{ directUrl }}</code>
                <div class="file-card__meta">
                  <span>汉化更新 <b>{{ formatDate(currentVersion?.updatedAt) }}</b></span>
                  <span>MC <b>{{ gameRange || '—' }}</b></span>
                  <span>语言版本 <b>{{ currentVersion?.langVersion || '—' }}</b></span>
                </div>
              </div>
            </template>

            <p v-else class="no-lang-file">该光影暂无对应的 zh_CN.lang 文件。</p>

            <div class="download-actions">
              <a
                v-if="currentVersion && quarkUrl"
                class="download-main"
                :href="quarkUrl"
                target="_blank"
                rel="noopener noreferrer"
              >
                <span>夸克网盘下载</span>
                <small>对应光影 {{ currentVersion.shaderVersion }} · 打开网盘</small>
              </a>
              <button
                v-else
                type="button"
                class="download-main"
                :aria-describedby="currentVersion && directUrl ? 'quark-unavailable' : undefined"
                disabled
              >
                <span>{{ currentVersion ? '夸克网盘不可用' : '暂无汉化文件' }}</span>
                <small>{{ currentVersion && directUrl ? '可使用本站直链' : '没有可下载的语言文件' }}</small>
              </button>

              <a
                v-if="directUrl"
                class="download-alt"
                :href="directUrl"
                download
              >
                本站 / GitHub 直链
              </a>
              <button v-else type="button" class="download-alt" disabled>本站 / GitHub 直链</button>
            </div>

            <p v-if="currentVersion && !quarkUrl" id="quark-unavailable" class="download-tip">
              当前版本暂无夸克链接，主按钮已禁用；请使用本站 / GitHub 直链下载。
            </p>
            <p v-else-if="currentVersion" class="download-tip">
              版本对不上时请切换上方版本标签，避免设置项错位。
            </p>
          </div>

          <aside class="install-panel">
            <template v-if="versions.length">
              <h3>装进游戏 <span>三步，不用看视频教程</span></h3>
              <ol class="install-steps">
                <li>
                  <span class="step-num" aria-hidden="true">1</span>
                  <p>解压光影包，找到包里面的 <code>shaders</code> 文件夹。</p>
                </li>
                <li>
                  <span class="step-num" aria-hidden="true">2</span>
                  <p>把刚下载的 <code>zh_CN.lang</code> 放进 <code>shaders/lang/</code>。</p>
                </li>
                <li>
                  <span class="step-num" aria-hidden="true">3</span>
                  <p>进游戏后打开视频设置 → 光影设置 → 语言选简体中文，重进即生效。</p>
                </li>
              </ol>
            </template>
            <div v-else class="install-empty">
              <h3>无需下载语言文件</h3>
              <p>{{ selectedStatus.description }}</p>
            </div>
          </aside>
        </div>
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
  --home-bg: #0b0e12;
  --home-bg-soft: #0e1319;
  --home-panel: #131a22;
  --home-panel-strong: #161e28;
  --home-input: #0a0e13;
  --home-line: #242f3b;
  --home-line-soft: #1c2530;
  --home-text: #e9f0f4;
  --home-muted: #93a1ad;
  --home-faint: #64707b;
  --home-go: #3ddc84;
  --home-go-text: #062415;
  --home-font-ui: "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  --home-font-mono: "Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  min-height: 100vh;
  background: var(--home-bg);
  color: var(--home-text);
  font-family: var(--home-font-ui);
  font-size: 15px;
  line-height: 1.65;
}

.home-shell *,
.home-shell *::before,
.home-shell *::after {
  box-sizing: border-box;
}

.home-wrap {
  width: 100%;
  max-width: 1280px;
  margin-inline: auto;
  padding-inline: 32px;
}

.home-topbar {
  position: sticky;
  top: var(--vp-nav-height, 64px);
  z-index: 18;
  border-bottom: 1px solid var(--home-line-soft);
  background: var(--home-bg);
}

.home-topbar__inner {
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 60px;
}

.home-brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  flex: none;
  color: var(--home-text);
  font-size: 16px;
  font-weight: 800;
  text-decoration: none;
  white-space: nowrap;
}

.home-brand:hover {
  color: var(--home-text);
}

.home-brand__mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--home-line);
  border-radius: 7px;
  background: #1b232e;
  color: var(--home-text);
  font-size: 14px;
  line-height: 1;
}

.home-chip {
  flex: none;
  padding: 4px 12px;
  border: 1px solid var(--home-line);
  border-radius: 999px;
  color: var(--home-muted);
  font-size: 12.5px;
  white-space: nowrap;
}

.home-chip b,
.home-chip time {
  color: var(--home-text);
  font-family: var(--home-font-mono);
  font-variant-numeric: tabular-nums;
}

.home-topsearch {
  position: relative;
  display: flex;
  gap: 8px;
  align-items: center;
  margin-left: auto;
}

.home-search__icon {
  position: absolute;
  left: 12px;
  z-index: 1;
  display: inline-flex;
  color: var(--home-faint);
  pointer-events: none;
}

.home-topsearch input,
.home-topsearch select {
  height: 38px;
  border: 1px solid var(--home-line);
  border-radius: 8px;
  background: var(--home-input);
  color: var(--home-text);
  font-family: var(--home-font-ui);
  font-size: 13.5px;
}

.home-topsearch input {
  width: 300px;
  padding: 0 12px 0 36px;
  outline: none;
}

.home-topsearch input::placeholder {
  color: var(--home-faint);
}

.home-topsearch select {
  padding: 0 10px;
  color: var(--home-muted);
}

.home-topsearch input:focus,
.home-topsearch select:focus {
  border-color: #526273;
}

.home-main {
  padding-bottom: 40px;
}

.hero-section {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 48px;
  align-items: center;
  padding: 44px 0 30px;
}

.hero-copy {
  min-width: 0;
}

.hero-kicker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 16px;
  padding: 5px 13px;
  border: 1px solid var(--home-line);
  border-radius: 999px;
  background: #10161d;
  color: var(--home-muted);
  font-size: 12.5px;
}

.hero-kicker__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #8b96a1;
}

.hero-copy h1 {
  margin: 0 0 14px !important;
  padding: 0 !important;
  border: 0 !important;
  color: var(--home-text);
  font-size: 42px;
  font-weight: 900;
  line-height: 1.25;
  text-wrap: balance;
}

.hero-copy h1 span {
  color: inherit;
}

.hero-lede {
  max-width: 52ch;
  margin: 0 0 20px;
  color: var(--home-muted);
  font-size: 15.5px;
}

.hero-lede code,
.install-panel code,
.file-card code {
  border: 1px solid var(--home-line);
  border-radius: 6px;
  background: var(--home-input);
  color: var(--home-text);
  font-family: var(--home-font-mono);
}

.hero-lede code {
  padding: 1px 7px;
  font-size: 13px;
}

.hero-meter {
  display: flex;
  gap: 28px;
  margin: 6px 0 22px;
}

.hero-meter div {
  min-width: 0;
}

.hero-meter b {
  display: block;
  color: var(--home-text);
  font-family: var(--home-font-mono);
  font-size: 24px;
  font-weight: 800;
  line-height: 1.3;
  font-variant-numeric: tabular-nums;
}

.hero-meter span {
  color: var(--home-faint);
  font-size: 12.5px;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.home-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 45px;
  padding: 10px 22px;
  border: 1px solid transparent;
  border-radius: 9px;
  font-size: 14.5px;
  font-weight: 700;
  line-height: 1.2;
  text-decoration: none;
  transition: border-color 0.18s, background-color 0.18s, color 0.18s;
}

.home-btn--solid {
  background: var(--home-text);
  color: var(--home-bg);
}

.home-btn--solid:hover {
  background: #fff;
  color: var(--home-bg);
}

.home-btn--ghost {
  border-color: var(--home-line);
  color: var(--home-text);
}

.home-btn--ghost:hover {
  border-color: #526273;
  color: var(--home-text);
}

.hero-note {
  margin: 12px 0 0;
  color: var(--home-faint);
  font-size: 12.5px;
}

.hero-shot {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--home-line);
  border-radius: 14px;
  background: var(--home-bg-soft);
}

.hero-shot img {
  display: block;
  width: 100%;
  height: 340px;
  object-fit: cover;
}

.hero-shot__fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 340px;
  background: var(--home-panel);
  color: var(--home-faint);
  font-family: var(--home-font-mono);
  font-size: 56px;
}

.hero-shot figcaption {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 14px;
  border-top: 1px solid var(--home-line-soft);
  color: var(--home-muted);
  font-size: 12.5px;
}

.hero-shot figcaption span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hero-shot figcaption code {
  flex: none;
  color: var(--home-faint);
  font-family: var(--home-font-mono);
  font-size: 12px;
}

.download-panel {
  margin: 14px 0 26px;
  overflow: hidden;
  border: 1px solid var(--home-line);
  border-radius: 12px;
  background: var(--home-panel);
}

.download-panel__head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 22px;
  border-bottom: 1px solid var(--home-line-soft);
}

.download-panel__cover {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 44px;
  height: 44px;
  overflow: hidden;
  border: 1px solid var(--home-line);
  border-radius: 10px;
  background: var(--home-input);
  color: var(--home-faint);
  font-family: var(--home-font-mono);
  font-size: 18px;
}

.download-panel__cover img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.download-panel__title {
  min-width: 0;
}

.download-panel__title h2 {
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  color: var(--home-text);
  font-size: 17px;
  font-weight: 700;
  line-height: 1.35;
}

.download-panel__title p {
  margin: 2px 0 0;
  color: var(--home-muted);
  font-size: 12.5px;
}

.download-panel__count {
  flex: none;
  margin-left: auto;
  text-align: right;
  color: var(--home-faint);
  font-size: 12px;
}

.download-panel__count b {
  display: block;
  color: var(--home-text);
  font-family: var(--home-font-mono);
  font-size: 16px;
  font-variant-numeric: tabular-nums;
}

.download-panel__body {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
}

.download-panel__files {
  min-width: 0;
  padding: 22px;
  border-right: 1px solid var(--home-line-soft);
}

.panel-status {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 18px;
  color: var(--home-muted);
  font-size: 12.5px;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  flex: none;
  padding: 3px 10px;
  border: 1px solid var(--home-line);
  border-radius: 999px;
  background: var(--home-input);
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
  color: var(--home-muted);
}

.panel-label {
  margin: 0 0 10px;
  color: var(--home-muted);
  font-size: 12.5px;
}

.version-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}

.version-tab {
  padding: 9px 16px;
  border: 1px solid var(--home-line);
  border-radius: 8px;
  background: #0b1016;
  color: var(--home-muted);
  font-family: var(--home-font-mono);
  font-size: 13px;
  cursor: pointer;
}

.version-tab--active {
  border-color: #c8d2db;
  color: var(--home-text);
  font-weight: 700;
}

.file-card {
  margin-bottom: 14px;
  padding: 14px 16px;
  border: 1px solid var(--home-line);
  border-radius: 10px;
  background: var(--home-input);
}

.file-card > code {
  display: block;
  border: 0;
  background: transparent;
  color: var(--home-text);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.file-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin-top: 8px;
  color: var(--home-faint);
  font-size: 12px;
}

.file-card__meta b {
  color: var(--home-muted);
  font-family: var(--home-font-mono);
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}

.no-lang-file {
  margin: 0 0 14px;
  padding: 14px 16px;
  border: 1px solid var(--home-line);
  border-radius: 10px;
  background: var(--home-input);
  color: var(--home-muted);
  font-size: 13px;
}

.download-actions {
  display: flex;
  gap: 10px;
}

.download-main,
.download-alt {
  min-height: 54px;
  border-radius: 10px;
  font-family: var(--home-font-ui);
  cursor: pointer;
}

.download-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  padding: 9px 16px;
  border: 1px solid transparent;
  background: var(--home-go);
  color: var(--home-go-text);
  font-size: 16px;
  font-weight: 800;
  line-height: 1.2;
  text-align: left;
  text-decoration: none;
}

.download-main small {
  margin-top: 2px;
  font-size: 12px;
  font-weight: 400;
  opacity: 0.76;
}

.download-main:disabled {
  border-color: var(--home-line);
  background: var(--home-input);
  color: var(--home-faint);
  cursor: not-allowed;
}

.download-main:disabled small {
  opacity: 1;
}

.download-alt {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  padding: 0 16px;
  border: 1px solid var(--home-line);
  background: transparent;
  color: var(--home-muted);
  font-size: 13px;
  font-weight: 700;
  text-decoration: none;
  white-space: nowrap;
}

.download-alt:hover {
  border-color: #526273;
  color: var(--home-text);
}

.download-alt:disabled {
  color: var(--home-faint);
  cursor: not-allowed;
  opacity: 0.65;
}

.download-tip {
  margin: 9px 0 0;
  color: var(--home-faint);
  font-size: 12px;
}

.install-panel {
  min-width: 0;
  padding: 22px;
  background: #0f141a;
}

.install-panel h3 {
  margin: 0 0 14px !important;
  padding: 0 !important;
  border: 0 !important;
  color: var(--home-text);
  font-size: 14px;
}

.install-panel h3 span {
  color: var(--home-faint);
  font-size: 12.5px;
  font-weight: 400;
}

.install-steps {
  display: grid;
  gap: 14px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.install-steps li {
  display: flex;
  gap: 12px;
}

.step-num {
  flex: none;
  width: 22px;
  color: var(--home-muted);
  font-family: var(--home-font-mono);
  font-size: 13px;
  line-height: 1.8;
}

.install-steps p {
  margin: 0;
  color: var(--home-muted);
  font-size: 13.5px;
}

.install-steps code {
  padding: 2px 8px;
  font-size: 12.5px;
  white-space: nowrap;
}

.install-empty h3 {
  margin-bottom: 8px !important;
}

.install-empty p {
  margin: 0;
  color: var(--home-muted);
  font-size: 13.5px;
}

.home-shell :where(a, button, input, select, summary, [tabindex]):focus-visible {
  outline: 2px solid #c8d2db;
  outline-offset: 2px;
}

@media (max-width: 1040px) {
  .home-chip--date {
    display: none;
  }

  .home-topsearch input {
    width: 240px;
  }
}

@media (max-width: 860px) {
  .home-topbar__inner {
    flex-wrap: wrap;
    padding-block: 10px;
  }

  .home-topsearch {
    flex: 1 1 100%;
    margin-left: 0;
  }

  .home-topsearch input {
    flex: 1;
    width: auto;
  }

  .hero-section {
    grid-template-columns: minmax(0, 1fr);
    gap: 28px;
    padding-top: 32px;
  }

  .download-panel__body {
    grid-template-columns: minmax(0, 1fr);
  }

  .download-panel__files {
    border-right: 0;
    border-bottom: 1px solid var(--home-line-soft);
  }
}

@media (max-width: 640px) {
  .home-wrap {
    padding-inline: 20px;
  }

  .home-topbar__inner {
    align-items: stretch;
    gap: 10px;
  }

  .home-brand {
    font-size: 15px;
  }

  .home-chip {
    flex: 1 1 100%;
    margin-left: 0;
    text-align: center;
  }

  .home-topsearch {
    flex-wrap: wrap;
  }

  .home-topsearch input,
  .home-topsearch select {
    flex: 1 1 100%;
    width: 100%;
  }

  .hero-copy h1 {
    font-size: 34px;
  }

  .hero-meter {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
  }

  .hero-shot img,
  .hero-shot__fallback {
    height: 230px;
  }

  .hero-shot figcaption {
    align-items: flex-start;
    flex-direction: column;
    gap: 3px;
  }

  .download-panel__head {
    align-items: flex-start;
    flex-wrap: wrap;
    padding: 16px;
  }

  .download-panel__count {
    width: 100%;
    margin-left: 0;
    text-align: left;
  }

  .download-panel__files,
  .install-panel {
    padding: 16px;
  }

  .panel-status {
    align-items: flex-start;
    flex-direction: column;
  }

  .download-actions {
    flex-direction: column;
  }

  .download-alt {
    min-height: 46px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .home-btn,
  .version-tab,
  .download-main,
  .download-alt {
    transition: none !important;
  }
}
</style>
