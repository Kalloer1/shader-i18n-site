#!/usr/bin/env node
/**
 * 构建前生成每个光影的静态详情页 site/shaders/<id>.md。
 *
 * Steam/Epic 游戏平台风格：全宽 Hero + 折叠版本时间线 + 截图画廊 + 类似光影推荐。
 *
 * ⚠️ HTML 块不能缩进：Markdown 会把 4 空格缩进的 HTML 当代码块处理。
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
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|')
const escHtml = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function versionRange(versions) {
  const parse = (v) => {
    const m = String(v).match(/^(\d+)\.(\d+)(?:\.(\d+))?$/)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null
  }
  let min = null, max = null, count = 0
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
const popularPool = catalog.shaders
  .filter((s) => s.gallery?.length && s.downloads >= 5000)
  .slice(0, 80)

function getSimilarShaders(currentId, count = 6) {
  const pool = popularPool.filter((s) => s.id !== currentId)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]]
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
  const iconUrl = manual?._meta?.modrinth?.iconUrl ?? e.iconUrl ?? ''
  const cf = manual?._meta?.curseforge ?? null
  const langVersions = manual?.langVersions ?? []
  const vr = versionRange(e.gameVersions)
  const gallery = (e.gallery ?? []).slice(0, 6)
  const heroImg = gallery[0] ?? ''
  const similar = getSimilarShaders(e.id, 6)

  // ⚠️ 所有 HTML 块顶格写，不能缩进（Markdown 4 空格 = 代码块）
  const L = []
  L.push('---')
  L.push(`title: ${JSON.stringify(title)}`)
  L.push(`description: ${JSON.stringify(`${nameCN || title} 的简体中文汉化文件下载`)}`)
  L.push('aside: false')
  L.push('editLink: false')
  L.push('layout: page')
  L.push('---')
  L.push('')

  // ===== Hero =====
  L.push(`<div class="sp-hero">`)
  if (heroImg) L.push(`<img class="sp-hero__bg" src="${escHtml(heroImg)}" alt="${escHtml(title)}" />`)
  L.push(`<div class="sp-hero__scrim"></div>`)
  L.push(`<div class="sp-hero__content">`)
  L.push(`<h1 class="sp-hero__title">${escHtml(title)}</h1>`)
  if (nameCN) L.push(`<p class="sp-hero__namecn">${escHtml(nameCN)}</p>`)
  L.push(`<div class="sp-hero__meta">`)
  if (author) L.push(`<span class="sp-hero__author">${escHtml(author)}</span>`)
  L.push(`<span class="sp-hero__downloads">${fmtW(downloads)} 下载</span>`)
  if (vr) L.push(`<span class="sp-hero__mcver">MC ${vr.min} ~ ${vr.max}</span>`)
  L.push(`</div>`) // meta
  L.push(`<div class="sp-hero__badges">`)
  if (langVersions.length) {
    const isNewestAI = (langVersions[0]?.contributors?.[0] ?? '').startsWith('AI')
    if (isNewestAI) {
      L.push(`<span class="sp-badge sp-badge--ai">AI 初翻 · 未校对</span>`)
    } else {
      L.push(`<span class="sp-badge sp-badge--ok">已校对</span>`)
    }
    L.push(`<span class="sp-badge sp-badge--count">${langVersions.length} 个版本已汉化</span>`)
  } else if (e.hasNativeZhCN) {
    L.push(`<span class="sp-badge sp-badge--native">自带中文</span>`)
  } else if (missingSet.has(e.id)) {
    L.push(`<span class="sp-badge sp-badge--none">无英文源，暂不可译</span>`)
  } else {
    L.push(`<span class="sp-badge sp-badge--none">暂无汉化</span>`)
  }
  L.push(`</div>`) // badges
  L.push(`<div class="sp-hero__actions">`)
  if (pageUrl) L.push(`<a class="sp-btn sp-btn--primary" href="${escHtml(pageUrl)}" target="_blank" rel="noopener">获取光影本体 →</a>`)
  if (cf?.pageUrl) L.push(`<a class="sp-btn sp-btn--ghost" href="${escHtml(cf.pageUrl)}" target="_blank" rel="noopener">CurseForge</a>`)
  L.push(`</div>`) // actions
  L.push(`</div>`) // content
  L.push(`</div>`) // hero
  L.push('')

  // ===== 标签页导航 =====
  const hasGallery = gallery.length > 1

  L.push(`<div class="sp-tabs">`)
  L.push(`<input type="radio" name="sp-tab" id="sp-tab-download" class="sp-tabs__radio" checked />`)
  L.push(`<input type="radio" name="sp-tab" id="sp-tab-gallery" class="sp-tabs__radio" />`)
  L.push(`<input type="radio" name="sp-tab" id="sp-tab-desc" class="sp-tabs__radio" />`)
  L.push(`<input type="radio" name="sp-tab" id="sp-tab-install" class="sp-tabs__radio" />`)
  L.push(`<div class="sp-tabs__nav">`)
  L.push(`<label for="sp-tab-download" class="sp-tabs__btn">下载</label>`)
  if (hasGallery) L.push(`<label for="sp-tab-gallery" class="sp-tabs__btn">图库</label>`)
  L.push(`<label for="sp-tab-desc" class="sp-tabs__btn">介绍</label>`)
  L.push(`<label for="sp-tab-install" class="sp-tabs__btn">安装方法</label>`)
  L.push(`</div>`) // tabs nav
  L.push('')

  // ===== Tab 1: 下载 =====
  L.push(`<div class="sp-tabs__panel sp-tabs__panel--download">`)

  // 汉化文件下载
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
    L.push(`</div>`) // featured-top
    L.push(`<div class="sp-download__featured-meta">`)
    L.push(`<span>适配光影 v${escHtml(newest.shaderVersion)}</span>`)
    L.push(`<span>${escHtml(newest.updatedAt)}</span>`)
    L.push(`</div>`) // featured-meta
    L.push(`<p class="sp-download__hint">💡 lang 键随光影版本变动，请选择与光影版本一致的汉化文件。</p>`)
    L.push(`<div class="sp-download__featured-actions">`)
    if (newestHasFile) {
      L.push(`<a class="sp-btn sp-btn--primary sp-btn--dl" href="${escHtml(newest.file)}" download>下载 zh_CN.lang</a>`)
    } else {
      L.push(`<span class="sp-btn sp-btn--disabled sp-btn--dl">zh_CN.lang（待上传）</span>`)
    }
    const quarkUrl = manual?.quark
    if (quarkUrl) L.push(`<a class="sp-btn sp-btn--ghost sp-btn--dl" href="${escHtml(quarkUrl)}" target="_blank" rel="noopener">国内镜像</a>`)
    L.push(`</div>`) // featured-actions
    L.push(`</div>`) // featured

    if (langVersions.length > 1) {
      L.push(`<details class="sp-history">`)
      L.push(`<summary>查看全部 ${langVersions.length} 个历史版本</summary>`)
      L.push(`<table class="sp-version-table">`)
      L.push(`<thead><tr><th>光影版本</th><th>汉化版本</th><th>汉化下载</th><th>国内镜像</th><th>光影下载</th><th>状态</th><th>日期</th></tr></thead>`)
      L.push(`<tbody>`)
      for (const [idx, v] of langVersions.entries()) {
        const vPath = join(ROOT, 'site/public', String(v.file ?? '').replace(/^\/+/, ''))
        const vHasFile = v.file && existsSync(vPath)
        const isAI = (v.contributors?.[0] ?? '').startsWith('AI')
        const dl = vHasFile ? `<a href="${escHtml(v.file)}" download>zh_CN.lang</a>` : '<code>待上传</code>'
        const qk = (idx === 0 && manual?.quark) ? `<a href="${escHtml(manual.quark)}" target="_blank" rel="noopener">国内镜像</a>` : '—'
        // 光影本体下载已改为客户端动态加载，此处显示占位
        const shaderDl = '—'
        const badge = isAI
          ? '<span class="sp-badge sp-badge--ai sp-badge--xs">AI 初翻</span>'
          : '<span class="sp-badge sp-badge--ok sp-badge--xs">已校对</span>'
        L.push(`<tr><td><code>${escHtml(v.shaderVersion)}</code></td><td><code>${escHtml(v.langVersion)}</code></td><td>${dl}</td><td>${qk}</td><td>${shaderDl}</td><td>${badge}</td><td>${escHtml(v.updatedAt)}</td></tr>`)
      }
      L.push(`</tbody>`)
      L.push(`</table>`)
      L.push(`</details>`)
    }
    L.push(`</div>`) // download
  } else if (e.hasNativeZhCN) {
    L.push(`<div class="sp-download">`)
    L.push(`<h2 class="sp-section-title">汉化文件下载</h2>`)
    L.push(`<div class="sp-callout sp-callout--info">`)
    L.push(`<p>该光影官方包内已自带简体中文（<code>shaders/lang/zh_CN.lang</code>），通常无需额外下载。若游戏内未显示中文，请确认游戏语言已设为简体中文。</p>`)
    L.push(`</div>`)
    L.push(`</div>`)
  } else {
    L.push(`<div class="sp-download">`)
    L.push(`<h2 class="sp-section-title">汉化文件下载</h2>`)
    L.push(`<div class="sp-callout sp-callout--empty">`)
    if (missingSet.has(e.id)) {
      L.push(`<p>该光影没有英文语言文件（<code>en_US.lang</code>），无法自动生成汉化。若光影作者后续添加了英文语言文件，汉化将自动跟进。</p>`)
    } else {
      L.push(`<p>该光影暂无汉化文件，敬请期待。</p>`)
    }
    L.push(`</div>`)
    L.push(`</div>`)
  }

  // 光影本体下载（客户端动态加载）
  L.push(`<div id="modrinth-versions" data-project-id="${escHtml(e.projectId)}"></div>`)

  L.push(`</div>`) // panel download
  L.push('')

  // ===== Tab 2: 图库 =====
  L.push(`<div class="sp-tabs__panel sp-tabs__panel--gallery">`)
  L.push(`<div class="sp-gallery">`)
  for (const url of gallery.slice(1)) {
    L.push(`<figure class="sp-gallery__item"><img src="${escHtml(url)}" alt="${escHtml(title)} 游戏效果图" loading="lazy" /></figure>`)
  }
  L.push(`</div>`)
  L.push(`</div>`) // panel gallery
  L.push('')

  // ===== Tab 3: 介绍（客户端动态加载）=====
  L.push(`<div class="sp-tabs__panel sp-tabs__panel--desc">`)
  L.push(`<div class="sp-desc-card">`)
  L.push(`<div id="modrinth-desc" data-project-id="${escHtml(e.projectId)}"></div>`)
  L.push(`</div>`) // desc-card
  L.push(`</div>`) // panel desc
  L.push('')

  // ===== Tab 4: 安装方法 =====
  L.push(`<div class="sp-tabs__panel sp-tabs__panel--install">`)
  L.push(`<div class="sp-install-content">`)
  L.push(`<h2 class="sp-section-title">安装方法</h2>`)
  L.push(`<p class="sp-install-hint">三步让游戏内光影界面显示中文</p>`)
  L.push(`<ol class="sp-install-steps">`)
  L.push(`<li><strong>下载</strong>：点击上方「下载 zh_CN.lang」按钮。</li>`)
  L.push(`<li><strong>注入</strong>：用压缩软件打开光影 zip（位于 <code>.minecraft/shaderpacks/</code>），进入 <code>shaders/lang/</code>（没有就新建），把 <code>zh_CN.lang</code> 拖进去。</li>`)
  L.push(`<li><strong>验证</strong>：游戏内选中该光影，确认语言为简体中文，光影设置界面出现中文即成功。</li>`)
  L.push(`</ol>`)
  L.push(`<p>详细图文教程见 <a href="/guide/install">安装教程</a>。</p>`)
  L.push(`</div>`)
  L.push(`</div>`) // panel install

  L.push(`</div>`) // sp-tabs
  L.push('')

  // ===== 类似光影 =====
  if (similar.length) {
    L.push(`<div class="sp-similar">`)
    L.push(`<h2 class="sp-section-title">你可能还喜欢</h2>`)
    L.push(`<div class="sp-similar__scroll">`)
    for (const s of similar) {
      const sTitle = escHtml(s.title)
      const sImg = s.gallery?.[0] ?? s.iconUrl ?? ''
      const sDl = fmtW(s.downloads)
      L.push(`<a class="sp-similar__card" href="/shaders/${escHtml(s.id)}">`)
      if (sImg) {
        L.push(`<div class="sp-similar__cover"><img src="${escHtml(sImg)}" alt="${sTitle}" loading="lazy" /></div>`)
      } else {
        L.push(`<div class="sp-similar__cover sp-similar__cover--empty"><span>${sTitle.charAt(0)}</span></div>`)
      }
      L.push(`<div class="sp-similar__info"><span class="sp-similar__name">${sTitle}</span><span class="sp-similar__dl">⬇ ${sDl}</span></div>`)
      L.push(`</a>`)
    }
    L.push(`</div>`) // scroll
    L.push(`</div>`) // similar
  }
  L.push('')

  // ===== 客户端脚本：懒加载 Modrinth 数据 =====
  L.push(`<script setup>`)
  L.push(`import { onMounted } from 'vue'`)
  L.push(`import { renderDescription, renderVersions } from '../.vitepress/theme/modrinth-api.js'`)
  L.push('')
  L.push(`onMounted(() => {`)
  L.push(`  // 监听标签页切换，懒加载内容`)
  L.push(`  const descTab = document.querySelector('label[for="sp-tab-desc"]')`)
  L.push(`  const downloadTab = document.querySelector('label[for="sp-tab-download"]')`)
  L.push('')
  L.push(`  // 介绍标签页`)
  L.push(`  const descContainer = document.getElementById('modrinth-desc')`)
  L.push(`  if (descContainer && descTab) {`)
  L.push(`    const projectId = descContainer.dataset.projectId`)
  L.push(`    let loaded = false`)
  L.push(`    descTab.addEventListener('click', () => {`)
  L.push(`      if (!loaded) { loaded = true; renderDescription(projectId, descContainer) }`)
  L.push(`    })`)
  L.push(`  }`)
  L.push('')
  L.push(`  // 下载标签页（版本列表）`)
  L.push(`  const versionsContainer = document.getElementById('modrinth-versions')`)
  L.push(`  if (versionsContainer && downloadTab) {`)
  L.push(`    const projectId = versionsContainer.dataset.projectId`)
  L.push(`    let loaded = false`)
  L.push(`    // 下载标签默认选中，立即加载`)
  L.push(`    loaded = true`)
  L.push(`    renderVersions(projectId, versionsContainer)`)
  L.push(`  }`)
  L.push(`})`)
  L.push(`</script>`)

  writeFileSync(join(SHADERS_DIR, `${e.id}.md`), L.join('\n'))
  generated++
}

console.log(`已生成 ${generated} 个光影详情页 -> site/shaders/`)
