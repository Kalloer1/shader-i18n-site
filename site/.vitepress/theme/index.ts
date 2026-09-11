import DefaultTheme from 'vitepress/theme'
import { onMounted, watch, nextTick } from 'vue'
import { useRoute } from 'vitepress'
import mediumZoom from 'medium-zoom'
import HomeHero from './components/HomeHero.vue'
import FeatureRow from './components/FeatureRow.vue'
import ShaderList from './components/ShaderList.vue'
import './style.css'

// 图片加载失败时的全局占位：Modrinth CDN 不可达时，用本地 SVG 占位图替代裂图。
// 捕获阶段监听才能拿到 <img> 的资源加载错误。
if (typeof window !== 'undefined') {
  const PLACEHOLDER =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">` +
        `<rect width="320" height="180" fill="#141a21"/>` +
        `<g fill="none" stroke="#e8a33d" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity="0.75">` +
        `<rect x="128" y="62" width="64" height="48" rx="6"/><circle cx="146" cy="80" r="6"/><path d="M132 104l16-14 12 10 12-12 14 16"/></g>` +
        `<text x="160" y="140" text-anchor="middle" font-size="13" fill="#6e7c8a" font-family="sans-serif">截图暂时加载不出来 · 不影响下载</text>` +
        `</svg>`,
    )
  window.addEventListener(
    'error',
    (e) => {
      const el = e.target as HTMLElement | null
      if (el && el.tagName === 'IMG' && !(el as HTMLImageElement).dataset.fb) {
        ;(el as HTMLImageElement).dataset.fb = '1'
        ;(el as HTMLImageElement).src = PLACEHOLDER
        el.classList.add('img-fallback')
      }
    },
    true,
  )
}

// medium-zoom lightbox：为光影详情页的截图画廊和介绍正文图片提供全屏查看
const setupMediumZoom = () => {
  mediumZoom('.sp-gallery__item img, .sp-body img', {
    background: 'rgba(13, 17, 23, 0.92)',
    margin: 40,
  })
}

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('HomeHero', HomeHero)
    app.component('FeatureRow', FeatureRow)
    app.component('ShaderList', ShaderList)
  },
  setup() {
    const route = useRoute()
    onMounted(() => {
      setupMediumZoom()
    })
    watch(
      () => route.path,
      () => nextTick(() => setupMediumZoom()),
    )
  },
}

