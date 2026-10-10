<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { allShaders } from '../data.js'

// 热门光影池：下载量前 80 个有截图的光影
const popularPool = allShaders.filter((s) => s.gallery?.length).slice(0, 80)

// 今日推荐：用日期作 seed，同一天所有人看到相同的 3 个
function pickDaily(pool, count = 3) {
  const today = new Date()
  const seed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate()
  const shuffled = [...pool]
  let s = seed
  for (let i = shuffled.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const j = s % (i + 1)
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, count)
}

const collage = ref(pickDaily(popularPool))
const total = allShaders.length
const translated = allShaders.filter((s) => s.langVersions.length).length

const slideCount = computed(() => collage.value.length)

// 无限循环轮播：1-2-3-1-2-3，一直往左滑
const currentIndex = ref(0)

// 当前高亮的下标（轮播轨道用克隆首帧实现无缝衔接，所以取模）
const activeIndex = computed(() => (slideCount.value ? currentIndex.value % slideCount.value : 0))

let intervalId = null
const TRANSITION_MS = 600
const HOLD_MS = 4000

// 尊重系统「减弱动效」偏好：不自动轮播，只在用户手动切换时才过渡
const prefersReducedMotion =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false

function startAutoplay() {
  if (prefersReducedMotion || intervalId) return
  intervalId = setInterval(() => {
    currentIndex.value++
  }, HOLD_MS)
}

function stopAutoplay() {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
}

function goToSlide(i) {
  currentIndex.value = i
}

onMounted(() => {
  startAutoplay()
})

onUnmounted(() => {
  stopAutoplay()
})

function formatDownloads(n) {
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n)
}
</script>

<template>
  <section class="home-hero" aria-labelledby="home-hero-title">
    <div class="home-hero-copy">
      <p class="kicker">SHADERPACK · 简体中文本地化</p>
      <h1 id="home-hero-title" class="title">光影汉化<br /><em>资源站</em></h1>
      <p class="tagline">
        找到你的光影包，下载对应版本的 <code>zh_CN.lang</code>，
        拖进光影 zip 的 <code>shaders/lang/</code>，游戏内光影菜单变中文。
      </p>
      <div class="actions">
        <a class="btn primary" href="#光影列表">浏览 {{ total }} 个光影</a>
        <a class="btn ghost" href="/guide/install">安装教程</a>
      </div>
      <p class="stats">
        <strong>{{ translated }}</strong> 个光影已有汉化 · 数据来自 Modrinth · 只分发语言文件，不重分发光影本体
      </p>
      <p class="modrinth-note">目前仅支持 Modrinth 平台收录的光影包，CurseForge 光影暂未接入。</p>
    </div>

    <!-- 今日推荐：水平无限循环轮播 -->
    <div
      class="home-hero-carousel"
      role="group"
      aria-roledescription="轮播"
      aria-label="今日推荐光影"
      @mouseenter="stopAutoplay"
      @mouseleave="startAutoplay"
      @focusin="stopAutoplay"
      @focusout="startAutoplay"
    >
      <p class="carousel-label" aria-hidden="true">今日推荐光影</p>
      <div class="carousel-viewport">
        <ul
          class="carousel-track"
          :style="{
            transform: `translateX(${-currentIndex * 100}%)`,
            transition: currentIndex > 0 ? `transform ${TRANSITION_MS}ms ease` : 'none',
          }"
          @transitionend="
            () => {
              if (currentIndex >= slideCount) currentIndex = 0
            }
          "
        >
          <li v-for="(s, i) in collage" :key="`real-${s.id}`" class="carousel-slide-item">
            <a
              class="carousel-slide"
              :href="`/shaders/${s.id}`"
              :tabindex="activeIndex === i ? 0 : -1"
              :aria-hidden="activeIndex === i ? undefined : 'true'"
            >
              <img
                :src="s.gallery[0]"
                :alt="`${s.title} 游戏截图`"
                width="960"
                height="600"
                :loading="i === 0 ? 'eager' : 'lazy'"
                :fetchpriority="i === 0 ? 'high' : 'auto'"
                decoding="async"
              />
              <span class="carousel-slide-overlay">
                <span class="carousel-slide-title">{{ s.title }}</span>
                <span class="carousel-slide-dl">⬇ {{ formatDownloads(s.downloads) }}</span>
              </span>
            </a>
          </li>
          <!-- 复制第一张做无缝衔接；纯装饰，不参与键盘导航与朗读 -->
          <li v-if="collage.length" class="carousel-slide-item" aria-hidden="true">
            <a class="carousel-slide" :href="`/shaders/${collage[0].id}`" tabindex="-1">
              <img
                :src="collage[0].gallery[0]"
                :alt="`${collage[0].title} 游戏截图`"
                width="960"
                height="600"
                loading="lazy"
                decoding="async"
              />
              <span class="carousel-slide-overlay">
                <span class="carousel-slide-title">{{ collage[0].title }}</span>
                <span class="carousel-slide-dl">⬇ {{ formatDownloads(collage[0].downloads) }}</span>
              </span>
            </a>
          </li>
        </ul>
      </div>
      <div class="carousel-dots" role="group" aria-label="选择推荐光影">
        <button
          v-for="i in slideCount"
          :key="i"
          type="button"
          class="carousel-dot"
          :class="{ active: activeIndex === i - 1 }"
          :aria-label="`切换到第 ${i} 个光影`"
          :aria-current="activeIndex === i - 1 ? 'true' : undefined"
          @click="goToSlide(i - 1)"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 移动优先：默认单列，宽屏再分两栏 */
.home-hero {
  display: grid;
  grid-template-columns: 1fr;
  gap: 28px;
  align-items: center;
  padding: 32px 0 16px;
}

.kicker {
  font-family: var(--shader-display-font);
  font-size: 12px;
  letter-spacing: 0.26em;
  color: var(--vp-c-brand-1);
  margin-bottom: 12px;
  text-transform: uppercase;
}
.title {
  font-size: 38px;
  line-height: 1.1;
  font-weight: 800;
  letter-spacing: 0.02em;
  margin: 0 0 16px !important;
  border: none !important;
  padding: 0 !important;
}
.title em {
  font-style: normal;
  background: linear-gradient(100deg, #f2b95c 10%, #e8a33d 45%, #cf7f2a 90%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.tagline {
  font-size: 15px;
  color: var(--vp-c-text-2);
  max-width: 30em;
  line-height: 1.8;
  margin-bottom: 24px;
}
.tagline code {
  color: var(--vp-c-brand-1);
  background: rgba(232, 163, 61, 0.1);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.9em;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 22px;
}
.btn {
  font-family: var(--shader-display-font);
  font-weight: 600;
  font-size: 15px;
  padding: 11px 24px;
  border-radius: 6px;
  border: 1px solid transparent;
  transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s, color 0.2s;
}
.btn.primary {
  background: var(--vp-c-brand-1);
  color: #14100a;
}
.btn.primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 26px rgba(232, 163, 61, 0.4);
}
.btn.ghost {
  border-color: var(--vp-c-divider);
  color: var(--vp-c-text-1);
}
.btn.ghost:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}
.btn:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 3px;
}
.stats {
  font-size: 13px;
  color: var(--vp-c-text-3);
}
.stats strong {
  color: var(--vp-c-brand-1);
  font-family: var(--shader-display-font);
}
.modrinth-note {
  font-size: 12px;
  color: var(--vp-c-text-3);
  margin-top: 6px;
  opacity: 0.75;
}

/* ---- 今日推荐光影：水平无限循环轮播 ---- */
.home-hero-carousel {
  position: relative;
}
.carousel-label {
  font-family: var(--shader-display-font);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--vp-c-brand-1);
  margin-bottom: 12px;
}
.carousel-viewport {
  width: 100%;
  aspect-ratio: 16 / 10;
  max-height: 320px;
  overflow: hidden;
  border-radius: 14px;
  border: 1px solid var(--vp-c-divider);
  box-shadow: 0 6px 26px rgba(0, 0, 0, 0.3);
}
.carousel-track {
  display: flex;
  height: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
  will-change: transform;
}
.carousel-slide-item {
  flex: 0 0 100%;
  height: 100%;
  position: relative;
  overflow: hidden;
}
.carousel-slide {
  display: block;
  height: 100%;
  position: relative;
  overflow: hidden;
  text-decoration: none;
  color: inherit;
}
.carousel-slide img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.6s ease, filter 0.4s ease;
}
.carousel-slide:hover img {
  transform: scale(1.04);
  filter: brightness(1.08);
}
.carousel-slide:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: -3px;
  border-radius: 12px;
}
.carousel-slide-overlay {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 40px 20px 16px;
  background: linear-gradient(transparent 0%, rgba(0, 0, 0, 0.5) 40%, rgba(0, 0, 0, 0.92) 100%);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.carousel-slide-title {
  font-family: var(--shader-display-font);
  font-size: 18px;
  font-weight: 700;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.5);
}
.carousel-slide-dl {
  font-size: 13px;
  color: var(--vp-c-brand-1);
  font-family: var(--shader-display-font);
}

/* 指示器点点 */
.carousel-dots {
  display: flex;
  justify-content: center;
  gap: 10px;
  margin-top: 16px;
}
.carousel-dot {
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  position: relative;
}
.carousel-dot::after {
  content: '';
  position: absolute;
  inset: 7px;
  border-radius: 50%;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  transition: background-color 0.3s, border-color 0.3s, transform 0.2s;
}
.carousel-dot:hover::after {
  border-color: var(--vp-c-brand-1);
  transform: scale(1.15);
}
.carousel-dot.active::after {
  background: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  transform: scale(1.1);
}
.carousel-dot:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
  border-radius: 50%;
}

/* ---- 增强：宽屏两栏 ---- */
@media (min-width: 960px) {
  .home-hero {
    grid-template-columns: minmax(0, 5fr) minmax(0, 6fr);
    gap: 40px;
    padding: 48px 0 24px;
  }
  .title {
    font-size: 56px;
  }
  .carousel-viewport {
    aspect-ratio: auto;
    height: 300px;
    max-height: none;
  }
}

/* ---- 无障碍：减弱动效 ---- */
@media (prefers-reduced-motion: reduce) {
  .btn,
  .carousel-slide img,
  .carousel-dot::after {
    transition: none !important;
  }
  .btn.primary:hover {
    transform: none;
  }
  .carousel-slide:hover img {
    transform: none;
    filter: none;
  }
  .carousel-dot:hover::after {
    transform: none;
  }
}
</style>
