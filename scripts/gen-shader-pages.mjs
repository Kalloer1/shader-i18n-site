#!/usr/bin/env node
/**
 * 构建前生成每个光影的静态详情页 site/shaders/<id>.md。
 *
 * Steam/Epic 游戏平台风格：全宽 Hero + 标签分栏（下载 / 图库 / 介绍 / 安装）+ 类似光影推荐。
 *
 * ⚠️ 两个 Markdown 陷阱（踩过）：
 *   1. HTML 块必须顶格写，不能整体缩进 —— 4 空格缩进会被当成代码块。
 *   2. HTML 块内「空行之后紧跟 4 空格以上缩进」会提前终止 HTML 块，
 *      余下内容被转义成 <pre><code>（页面出现转义标签、SSR 直接崩）。
 *      因此块内分隔用顶格注释行，不写空行。
 *
 * 用法：npm run prebuild（已挂到 npm run build 前置）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHADERS_DIR = join(ROOT, 'site/shaders')
const catalog = JSON.parse(readFileSync(join(ROOT, 'site/data/modrinth-catalog.json'), 'utf8'))
const db = JSON.parse(readFileSync(join(ROOT, 'site/data/shaders.json'), 'utf8'))
const missingSource = JSON.parse(readFileSync(join(ROOT, 'site/data/missing-source.json'), 'utf8'))
const missingSet = new Set(missingSource)

// 清掉旧的生成物
mkdirSync(SHADERS_DIR, { recursive: true })
for (const f of readdirSync(SHADERS_DIR)) {
  if (f !== 'index.md') rmSync(join(SHADERS_DIR, f), { recursive: true, force: true })
}

const manualBySlug = new Map(db.shaders.map((s) => [s.id, s]))
const escHtml = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function versionRange(versions) {
  const parse = (v) => {
    const m = String(v).match(/^(\d+)\.(\d+)(?:\.(\d+))?$/)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null
  }
  let min = null,
    max = null,
    count = 0
  for (const v of versions ?? []) {
    const p = parse(v)
    if (!p) continue
    count++
    if (!min || p < min) min = p
    if (!max || p > max) max = p
  }
  if (!count) return null
  return { min: min.join('.'), max: max.join('.'), count }
}

const fmtW = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n))

// ---------- 类似光影推荐 ----------
const popularPool = catalog.shaders.filter((s) => s.gallery?.length && s.downloads >= 5000).slice(0, 80)

function getSimilarShaders(currentId, count = 6) {
  const pool = popularPool.filter((s) => s.id !== currentId)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, count)
}

// ---------- 生成页面 ----------
let generated = 0
for (const e of catalog.shaders) {
  const manual = manualBySlug.get(e.id) ?? manualBySlug.get(e.projectId)
  const title = manual?._meta?.modrinth?.title ?? e.title
  const nameCN = manual?.nameCN ?? ''
  const author = manual?._meta?.modrinth?.author ?? e.author ?? ''
  const downloads = manual?._meta?.modrinth?.downloads ?? e.downloads
  const pageUrl = manual?._meta?.modrinth?.pageUrl ?? e.pageUrl
  const langVersions = manual?.langVersions ?? []
  const vr = versionRange(e.gameVersions)
  const gallery = (e.gallery ?? []).slice(0, 6)
  const heroImg = gallery[0] ?? ''
  const similar = getSimilarShaders(e.id, 6)

  // ⚠️ 所有 HTML 块顶格写；块内不写空行（见文件头说明）
  const L = []
  L.push('---')
  L.push(`title: ${JSON.stringify(title)}`)
  L.push(`description: ${JSON.stringify(`${nameCN || title} 的简体中文汉化文件下载`)}`)
  L.push('aside: false')
  L.push('editLink: false')
  L.push('layout: page')
  L.push('---')
  L.push('')
  L.push(`<article class="sp-detail" aria-labelledby="sp-hero-title">`)

  // ===== Hero =====
  L.push(`<header class="sp-hero">`)
  if (heroImg) {
    // 首屏大图：eager + 高优先级，尺寸属性避免布局抖动（容器本身固定高度，CLS 为 0）
    L.push(
      `<img class="sp-hero__bg" src="${escHtml(heroImg)}" alt="${escHtml(title)} 游戏截图" width="1600" height="900" fetchpriority="high" decoding="async" />`,
    )
  }
  L.push(`<div class="sp-hero__scrim" aria-hidden="true"></div>`)
  L.push(`<div class="sp-hero__content">`)
  L.push(`<h1 id="sp-hero-title" class="sp-hero__title">${escHtml(title)}</h1>`)
  if (nameCN) L.push(`<p class="sp-hero__namecn">${escHtml(nameCN)}</p>`)
  L.push(`<ul class="sp-hero__meta">`)
  if (author) L.push(`<li class="sp-hero__author">作者 ${escHtml(author)}</li>`)
  L.push(`<li class="sp-hero__downloads">${fmtW(downloads)} 下载</li>`)
  if (vr) L.push(`<li class="sp-hero__mcver">MC ${vr.min} ~ ${vr.max}</li>`)
  L.push(`</ul>`)
  L.push(`<ul class="sp-hero__badges">`)
  if (langVersions.length) {
    const isNewestAI = (langVersions[0]?.contributors?.[0] ?? '').startsWith('AI')
    if (isNewestAI) {
      L.push(`<li class="sp-badge sp-badge--ai">AI 初翻 · 未校对</li>`)
    } else {
      L.push(`<li class="sp-badge sp-badge--ok">已校对</li>`)
    }
    L.push(`<li class="sp-badge sp-badge--count">${langVersions.length} 个版本已汉化</li>`)
  } else if (e.hasNativeZhCN) {
    L.push(`<li class="sp-badge sp-badge--native">自带中文</li>`)
  } else if (missingSet.has(e.id)) {
    L.push(`<li class="sp-badge sp-badge--none">无英文源，暂不可译</li>`)
  } else {
    L.push(`<li class="sp-badge sp-badge--none">暂无汉化</li>`)
  }
  L.push(`</ul>`)
  L.push(`<div class="sp-hero__actions">`)
  if (pageUrl) {
    L.push(
      `<a class="sp-btn sp-btn--primary" href="${escHtml(pageUrl)}" target="_blank" rel="noopener noreferrer">获取光影本体<span aria-hidden="true"> →</span></a>`,
    )
  }
  L.push(`<a class="sp-btn sp-btn--ghost" href="/guide/install">安装教程</a>`)
  L.push(`</div>`)
  L.push(`</div>`)
  L.push(`</header>`)

  // ===== 标签分栏（原生 radio 组：Tab 进入，方向键切换，无需 JS） =====
  const hasGallery = gallery.length > 1

  L.push(`<div class="sp-tabs">`)
  L.push(`<input type="radio" name="sp-tab" id="sp-tab-download" class="sp-tabs__radio" checked />`)
  L.push(`<input type="radio" name="sp-tab" id="sp-tab-gallery" class="sp-tabs__radio" />`)
  L.push(`<input type="radio" name="sp-tab" id="sp-tab-desc" class="sp-tabs__radio" />`)
  L.push(`<input type="radio" name="sp-tab" id="sp-tab-install" class="sp-tabs__radio" />`)
  L.push(`<nav class="sp-tabs__nav" aria-label="光影详情分栏">`)
  L.push(`<label for="sp-tab-download" class="sp-tabs__btn">下载</label>`)
  if (hasGallery) L.push(`<label for="sp-tab-gallery" class="sp-tabs__btn">图库</label>`)
  L.push(`<label for="sp-tab-desc" class="sp-tabs__btn">介绍</label>`)
  L.push(`<label for="sp-tab-install" class="sp-tabs__btn">安装方法</label>`)
  L.push(`</nav>`)

  // ===== Tab 1: 下载 =====
  L.push(`<section class="sp-tabs__panel sp-tabs__panel--download" aria-label="下载">`)

  if (langVersions.length) {
    L.push(`<div class="sp-download">`)
    L.push(`<h2 class="sp-section-title">汉化文件下载</h2>`)
    const newest = langVersions[0]
    const newestPath = join(ROOT, 'site/public', String(newest.file ?? '').replace(/^\/+/, ''))
    const newestHasFile = newest.file && existsSync(newestPath)
    const isNewestAI = (newest.contributors?.[0] ?? '').startsWith('AI')
    L.push(`<div class="sp-download__featured">`)
    L.push(`<div class="sp-download__featured-top">`)
    L.push(`<span class="sp-download__ver">v${escHtml(newest.langVersion)}</span>`)
    if (isNewestAI) {
      L.push(`<span class="sp-badge sp-badge--ai sp-badge--sm">AI 初翻</span>`)
    } else {
      L.push(`<span class="sp-badge sp-badge--ok sp-badge--sm">已校对</span>`)
    }
    L.push(`</div>`)
    L.push(`<div class="sp-download__featured-meta">`)
    L.push(`<span>适配光影 v${escHtml(newest.shaderVersion)}</span>`)
    L.push(`<span>更新于 ${escHtml(newest.updatedAt)}</span>`)
    L.push(`</div>`)
    L.push(`<p class="sp-download__hint">lang 键随光影版本变动，请选择与光影版本一致的汉化文件。</p>`)
    L.push(`<div class="sp-download__featured-actions">`)
    if (newestHasFile) {
      L.push(
        `<a class="sp-btn sp-btn--primary sp-btn--dl" href="${escHtml(newest.file)}" download>下载 zh_CN.lang</a>`,
      )
    } else {
      L.push(`<span class="sp-btn sp-btn--disabled sp-btn--dl">zh_CN.lang（待上传）</span>`)
    }
    const quarkUrl = manual?.quark
    if (quarkUrl) {
      L.push(
        `<a class="sp-btn sp-btn--ghost sp-btn--dl" href="${escHtml(quarkUrl)}" target="_blank" rel="noopener noreferrer">国内镜像</a>`,
      )
    }
    L.push(`</div>`)
    L.push(`</div>`)

    if (langVersions.length > 1) {
      L.push(`<details class="sp-history">`)
      L.push(`<summary>查看全部 ${langVersions.length} 个历史版本</summary>`)
      L.push(`<table class="sp-version-table">`)
      L.push(`<caption class="sr-only">各光影版本的汉化文件记录</caption>`)
      L.push(
        `<thead><tr><th scope="col">光影版本</th><th scope="col">汉化版本</th><th scope="col">汉化下载</th><th scope="col">国内镜像</th><th scope="col">状态</th><th scope="col">日期</th></tr></thead>`,
      )
      L.push(`<tbody>`)
      for (const [idx, v] of langVersions.entries()) {
        const vPath = join(ROOT, 'site/public', String(v.file ?? '').replace(/^\/+/, ''))
        const vHasFile = v.file && existsSync(vPath)
        const isAI = (v.contributors?.[0] ?? '').startsWith('AI')
        const dl = vHasFile
          ? `<a href="${escHtml(v.file)}" download>zh_CN.lang</a>`
          : '<code>待上传</code>'
        const qk =
          idx === 0 && manual?.quark
            ? `<a href="${escHtml(manual.quark)}" target="_blank" rel="noopener noreferrer">国内镜像</a>`
            : '—'
        const badge = isAI
          ? '<span class="sp-badge sp-badge--ai sp-badge--xs">AI 初翻</span>'
          : '<span class="sp-badge sp-badge--ok sp-badge--xs">已校对</span>'
        L.push(
          `<tr><th scope="row"><code>${escHtml(v.shaderVersion)}</code></th><td><code>${escHtml(v.langVersion)}</code></td><td>${dl}</td><td>${qk}</td><td>${badge}</td><td>${escHtml(v.updatedAt)}</td></tr>`,
        )
      }
      L.push(`</tbody>`)
      L.push(`</table>`)
      L.push(`</details>`)
    }
    L.push(`</div>`)
  } else if (e.hasNativeZhCN) {
    L.push(`<div class="sp-download">`)
    L.push(`<h2 class="sp-section-title">汉化文件下载</h2>`)
    L.push(`<div class="sp-callout sp-callout--info">`)
    L.push(
      `<p>该光影官方包内已自带简体中文（<code>shaders/lang/zh_CN.lang</code>），通常无需额外下载。若游戏内未显示中文，请确认游戏语言已设为简体中文。</p>`,
    )
    L.push(`</div>`)
    L.push(`</div>`)
  } else {
    L.push(`<div class="sp-download">`)
    L.push(`<h2 class="sp-section-title">汉化文件下载</h2>`)
    L.push(`<div class="sp-callout sp-callout--empty">`)
    if (missingSet.has(e.id)) {
      L.push(
        `<p>该光影没有英文语言文件（<code>en_US.lang</code>），无法自动生成汉化。若光影作者后续添加了英文语言文件，汉化将自动跟进。</p>`,
      )
    } else {
      L.push(`<p>该光影暂无汉化文件，敬请期待。</p>`)
    }
    L.push(`</div>`)
    L.push(`</div>`)
  }

  // 光影本体下载（客户端动态加载）
  L.push(`<div id="modrinth-versions" data-project-id="${escHtml(e.projectId)}"></div>`)
  L.push(`</section>`)

  // ===== Tab 2: 图库 =====
  L.push(`<section class="sp-tabs__panel sp-tabs__panel--gallery" aria-label="图库">`)
  L.push(`<div class="sp-gallery">`)
  for (const url of gallery.slice(1)) {
    L.push(
      `<figure class="sp-gallery__item"><img src="${escHtml(url)}" alt="${escHtml(title)} 游戏效果图" width="1280" height="720" loading="lazy" decoding="async" /></figure>`,
    )
  }
  L.push(`</div>`)
  L.push(`</section>`)

  // ===== Tab 3: 介绍（客户端动态加载）=====
  L.push(`<section class="sp-tabs__panel sp-tabs__panel--desc" aria-label="介绍">`)
  L.push(`<div class="sp-desc-card">`)
  L.push(`<div id="modrinth-desc" data-project-id="${escHtml(e.projectId)}"></div>`)
  L.push(`</div>`)
  L.push(`</section>`)

  // ===== Tab 4: 安装方法 =====
  L.push(`<section class="sp-tabs__panel sp-tabs__panel--install" aria-label="安装方法">`)
  L.push(`<div class="sp-install-content">`)
  if (e.hasNativeZhCN) {
    L.push(`<h2 class="sp-section-title">使用方法</h2>`)
    L.push(`<p class="sp-install-hint">官方包已自带中文语言文件，无需额外下载或注入。</p>`)
    L.push(`<ol class="sp-install-steps">`)
    L.push(`<li><strong>保留</strong>：不要删除光影 zip 内的 <code>shaders/lang/zh_CN.lang</code>。</li>`)
    L.push(`<li><strong>选择</strong>：游戏内选中该光影，并确认游戏语言为简体中文。</li>`)
    L.push(`<li><strong>验证</strong>：打开光影设置界面，出现中文即成功。</li>`)
    L.push(`</ol>`)
  } else {
    L.push(`<h2 class="sp-section-title">安装方法</h2>`)
    L.push(`<p class="sp-install-hint">三步让游戏内光影界面显示中文</p>`)
    L.push(`<ol class="sp-install-steps">`)
    L.push(`<li><strong>下载</strong>：点击上方「下载 zh_CN.lang」按钮。</li>`)
    L.push(
      `<li><strong>注入</strong>：用压缩软件打开光影 zip（位于 <code>.minecraft/shaderpacks/</code>），进入 <code>shaders/lang/</code>；如果目录不存在，请依次新建 <code>shaders</code> 和 <code>lang</code> 文件夹，再把 <code>zh_CN.lang</code> 拖进去。</li>`,
    )
    L.push(
      `<li><strong>验证</strong>：游戏内选中该光影，确认语言为简体中文，光影设置界面出现中文即成功。</li>`,
    )
    L.push(`</ol>`)
    L.push(`<p>详细图文教程见 <a href="/guide/install">安装教程</a>。</p>`)
  }
  L.push(`</div>`)
  L.push(`</section>`)
  L.push(`</div>`)

  // ===== 类似光影 =====
  if (similar.length) {
    L.push(`<section class="sp-similar" aria-labelledby="sp-similar-title">`)
    L.push(`<h2 id="sp-similar-title" class="sp-section-title">你可能还喜欢</h2>`)
    L.push(`<ul class="sp-similar__scroll">`)
    for (const s of similar) {
      const sTitle = escHtml(s.title)
      const sImg = s.gallery?.[0] ?? s.iconUrl ?? ''
      const sDl = fmtW(s.downloads)
      L.push(`<li class="sp-similar__item">`)
      L.push(`<a class="sp-similar__card" href="/shaders/${escHtml(s.id)}">`)
      if (sImg) {
        L.push(
          `<span class="sp-similar__cover"><img src="${escHtml(sImg)}" alt="${sTitle} 封面图" width="640" height="360" loading="lazy" decoding="async" /></span>`,
        )
      } else {
        L.push(
          `<span class="sp-similar__cover sp-similar__cover--empty" aria-hidden="true"><span>${sTitle.charAt(0)}</span></span>`,
        )
      }
      L.push(
        `<span class="sp-similar__info"><span class="sp-similar__name">${sTitle}</span><span class="sp-similar__dl">${sDl} 下载</span></span>`,
      )
      L.push(`</a>`)
      L.push(`</li>`)
    }
    L.push(`</ul>`)
    L.push(`</section>`)
  }

  L.push(`</article>`)
  L.push('')

  // ===== 客户端脚本：懒加载 Modrinth 数据 =====
  L.push(`<script setup>`)
  L.push(`import { onMounted } from 'vue'`)
  L.push(`import { renderDescription, renderVersions } from '../.vitepress/theme/modrinth-api.js'`)
  L.push('')
  L.push(`onMounted(() => {`)
  L.push(`  // 监听原生 radio 的 change：鼠标点标签与键盘方向键切换都会触发`)
  L.push(`  const descRadio = document.getElementById('sp-tab-desc')`)
  L.push('')
  L.push(`  // 介绍标签页：首次切换时再拉取，避免无谓请求`)
  L.push(`  const descContainer = document.getElementById('modrinth-desc')`)
  L.push(`  if (descContainer && descRadio) {`)
  L.push(`    const projectId = descContainer.dataset.projectId`)
  L.push(`    let loaded = false`)
  L.push(`    const load = () => {`)
  L.push(`      if (loaded) return`)
  L.push(`      loaded = true`)
  L.push(`      renderDescription(projectId, descContainer)`)
  L.push(`    }`)
  L.push(`    descRadio.addEventListener('change', load)`)
  L.push(`    // 直接以 #sp-tab-desc 锚点进入时立即加载`)
  L.push(`    if (descRadio.checked) load()`)
  L.push(`  }`)
  L.push('')
  L.push(`  // 下载标签页默认选中，立即加载光影本体版本列表`)
  L.push(`  const versionsContainer = document.getElementById('modrinth-versions')`)
  L.push(`  if (versionsContainer) {`)
  L.push(`    renderVersions(versionsContainer.dataset.projectId, versionsContainer)`)
  L.push(`  }`)
  L.push(`})`)
  L.push(`</script>`)

  writeFileSync(join(SHADERS_DIR, `${e.id}.md`), L.join('\n'))
  generated++
}

console.log(`已生成 ${generated} 个光影详情页 -> site/shaders/`)
