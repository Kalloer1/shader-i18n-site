<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
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

// 无限循环轮播：1-2-3-1-2-3，一直往左滑
const currentIndex = ref(0)
let intervalId = null
const TRANSITION_MS = 600
const HOLD_MS = 4000

function nextSlide() {
  currentIndex.value++
}

onMounted(() => {
  intervalId = setInterval(nextSlide, HOLD_MS)
})

onUnmounted(() => {
  if (intervalId) clearInterval(intervalId)
})
</script>

<template>
  <div class="home-hero">
    <div class="home-hero-copy">
      <p class="kicker">SHADERPACK · 简体中文本地化</p>
      <h1 class="title">光影汉化<br /><em>资源站</em></h1>
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
    <div class="home-hero-carousel">
      <p class="carousel-label">今日推荐光影</p>
      <div class="carousel-viewport">
        <div
          class="carousel-track"
          :style="{
            transform: `translateX(${-currentIndex * 100}%)`,
            transition: currentIndex > 0 ? `transform ${TRANSITION_MS}ms ease` : 'none'
          }"
          @transitionend="() => { if (currentIndex >= 3) { currentIndex = 0 } }"
        >
          <a
            v-for="(s, i) in collage"
            :key="`real-${s.id}`"
            :href="`/shaders/${s.id}`"
            class="carousel-slide"
          >
            <img :src="s.gallery[0]" :alt="s.title" loading="eager" />
            <div class="carousel-slide-overlay">
              <span class="carousel-slide-title">{{ s.title }}</span>
              <span class="carousel-slide-dl">⬇ {{ s.downloads >= 10000 ? (s.downloads / 10000).toFixed(1) + ' 万' : s.downloads }}</span>
            </div>
          </a>
          <!-- 复制第一张做无缝衔接 -->
          <a
            v-if="collage.length"
            :key="`clone-${collage[0].id}`"
            :href="`/shaders/${collage[0].id}`"
            class="carousel-slide"
          >
            <img :src="collage[0].gallery[0]" :alt="collage[0].title" loading="eager" />
            <div class="carousel-slide-overlay">
              <span class="carousel-slide-title">{{ collage[0].title }}</span>
              <span class="carousel-slide-dl">⬇ {{ collage[0].downloads >= 10000 ? (collage[0].downloads / 10000).toFixed(1) + ' 万' : collage[0].downloads }}</span>
            </div>
          </a>
        </div>
      </div>
      <div class="carousel-dots">
        <button
          v-for="i in 3"
          :key="i"
          class="carousel-dot"
          :class="{ active: currentIndex % 3 === i - 1 }"
          @click="currentIndex = i - 1"
          :aria-label="`切换到第 ${i} 个光影`"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.home-hero {
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 6fr);
  gap: 40px;
  align-items: center;
  padding: 48px 0 24px;
}
@media (max-width: 960px) {
  .home-hero {
    grid-template-columns: 1fr;
  }
  .home-hero-carousel {
    display: none;
  }
}
.kicker {
  font-family: 'Chakra Petch', var(--vp-font-family-base);
  font-size: 13px;
  letter-spacing: 0.28em;
  color: var(--vp-c-brand-1);
  margin-bottom: 14px;
}
.title {
  font-size: 56px;
  line-height: 1.08;
  font-weight: 800;
  letter-spacing: 0.02em;
  margin: 0 0 18px !important;
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
  font-size: 16px;
  color: var(--vp-c-text-2);
  max-width: 30em;
  line-height: 1.8;
  margin-bottom: 26px;
}
.tagline code {
  color: var(--vp-c-brand-1);
}
.actions {
  display: flex;
  gap: 14px;
  margin-bottom: 22px;
}
.btn {
  font-family: 'Chakra Petch', var(--vp-font-family-base);
  font-weight: 600;
  font-size: 15px;
  padding: 10px 22px;
  border-radius: 4px;
  border: 1px solid transparent;
  transition: transform 0.2s, box-shadow 0.2s;
}
.btn.primary {
  background: var(--vp-c-brand-1);
  color: #14100a;
}
.btn.primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 24px rgba(232, 163, 61, 0.35);
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
  outline-offset: 2px;
}
.stats {
  font-size: 13px;
  color: var(--vp-c-text-3);
}
.stats strong {
  color: var(--vp-c-brand-1);
  font-family: 'Chakra Petch', var(--vp-font-family-base);
}
.modrinth-note {
  font-size: 12px;
  color: var(--vp-c-text-3);
  margin-top: 6px;
  opacity: 0.7;
}

/* 今日推荐光影 — 水平无限循环轮播 */
.home-hero-carousel {
  position: relative;
  height: 380px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.carousel-label {
  font-family: 'Chakra Petch', var(--vp-font-family-base);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--vp-c-brand-1);
  margin-bottom: 14px;
}
.carousel-viewport {
  width: 100%;
  height: 300px;
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid var(--vp-c-divider);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
}
.carousel-track {
  display: flex;
  height: 100%;
  will-change: transform;
}
.carousel-slide {
  flex: 0 0 100%;
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
  transition: transform 0.6s ease;
}
.carousel-slide:hover img {
  transform: scale(1.04);
  filter: brightness(1.08);
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
  transition: background 0.4s ease;
}
.carousel-slide-title {
  font-family: 'Chakra Petch', var(--vp-font-family-base);
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
  font-family: 'Chakra Petch', var(--vp-font-family-base);
}

/* 指示器点点 */
.carousel-dots {
  display: flex;
  justify-content: center;
  gap: 10px;
  margin-top: 16px;
}
.carousel-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  cursor: pointer;
  transition: background 0.3s, border-color 0.3s, transform 0.2s;
  padding: 0;
}
.carousel-dot:hover {
  border-color: var(--vp-c-brand-1);
  transform: scale(1.2);
}
.carousel-dot.active {
  background: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  transform: scale(1.1);
}
.carousel-dot:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 3px;
}
</style>
