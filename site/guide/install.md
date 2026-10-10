---
title: 安装教程
description: 三步把 zh_CN.lang 汉化文件装进 Minecraft 光影包，让游戏内光影设置界面显示简体中文
---

# 安装教程

把汉化文件装进光影包只需三步，全程不需要解压光影 zip。

::: warning 前置条件
资源包/材质包**不能**替代本操作：Iris 与 OptiFine 只从光影包 zip 内部的 `shaders/lang/` 目录读取语言文件。
:::

<nav class="install-toc" aria-label="本页步骤">
  <ol>
    <li><a href="#step-download">下载汉化文件</a></li>
    <li><a href="#step-inject">注入光影 zip</a></li>
    <li><a href="#step-verify">进入游戏验证</a></li>
  </ol>
</nav>

<section aria-labelledby="step-download">

## 第一步：下载汉化文件 {#step-download}

在[光影列表](/#光影列表)找到你正在使用的光影包，进入详情页，下载**与光影版本一致**的 `zh_CN.lang`。

::: tip 版本要对应
lang 键随光影版本变动。详情页默认展示最新版汉化，旧版本折叠在「查看全部历史版本」里。
:::

</section>

<section aria-labelledby="step-inject">

## 第二步：注入光影 zip {#step-inject}

<ol class="install-steps">
  <li>找到你的光影文件，位于 <code>.minecraft/shaderpacks/</code> 目录下的一个 zip（例如 <code>BSL_v8.4.zip</code>）。</li>
  <li>用压缩软件（7-Zip、WinRAR、Bandizip 等）<strong>打开</strong>这个 zip（不要解压）。</li>
  <li>进入 zip 内的 <code>shaders/lang/</code> 目录；如果目录不存在，请依次新建 <code>shaders</code> 和 <code>lang</code> 文件夹。</li>
  <li>把下载的 <code>zh_CN.lang</code> 拖进去。</li>
</ol>

完成后 zip 内应有如下结构：

```
BSL_v8.4.zip
└── shaders/
    ├── lang/
    │   ├── en_US.lang   ← 光影自带
    │   └── zh_CN.lang   ← 你刚放进去的
    └── ...
```

</section>

<section aria-labelledby="step-verify">

## 第三步：进入游戏验证 {#step-verify}

<ol class="install-steps">
  <li><code>选项 → 视频设置 → 光影包</code>，选中该光影。</li>
  <li>确认游戏语言为<strong>简体中文</strong>。</li>
  <li>光影设置界面出现中文即成功。</li>
</ol>

::: tip 想还原成英文？
把 zip 内的 <code>shaders/lang/zh_CN.lang</code> 删掉即可，其余文件不受影响。
:::

</section>

<section aria-labelledby="faq">

## 常见问题 {#faq}

<dl class="install-faq">
  <dt>设置界面还是英文？</dt>
  <dd>检查汉化文件的光影版本是否与你下载的光影版本一致；旧版汉化在新版光影上会部分回退为英文。</dd>

  <dt>光影界面完全没变化？</dt>
  <dd>确认 <code>zh_CN.lang</code> 位于 zip 内 <code>shaders/lang/</code> 下，而不是 zip 里又套了一层文件夹。</dd>

  <dt>用的是解压过的光影文件夹？</dt>
  <dd>把 <code>zh_CN.lang</code> 放入该文件夹的 <code>shaders/lang/</code> 即可，效果相同。</dd>

  <dt>没有找到我用的光影？</dt>
  <dd>可以到<a href="/request">请求翻译</a>提交，队列登记后由管理员一键开启翻译。</dd>
</dl>

</section>

<style scoped>
/* 移动优先：小屏优先排版，宽屏再增强 */

/* 本页步骤导航 */
.install-toc {
  margin: 24px 0 8px;
  padding: 14px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
}
.install-toc ol {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding-left: 20px;
}
.install-toc li::marker {
  color: var(--vp-c-brand-1);
  font-weight: 700;
}
.install-toc a {
  color: var(--vp-c-text-2);
  font-weight: 500;
  text-decoration: none;
}
.install-toc a:hover {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
}
.install-toc a:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
  border-radius: 4px;
}

/* 步骤列表 */
.install-steps {
  padding-left: 20px;
  margin: 0 0 16px;
  line-height: 1.85;
}
.install-steps li {
  margin-bottom: 10px;
}
.install-steps li::marker {
  color: var(--vp-c-brand-1);
  font-weight: 700;
}
.install-steps code {
  font-size: 0.92em;
}

/* 常见问题 */
.install-faq {
  margin: 0;
}
.install-faq dt {
  font-weight: 700;
  color: var(--vp-c-text-1);
  margin-top: 18px;
}
.install-faq dt:first-child {
  margin-top: 0;
}
.install-faq dd {
  margin: 6px 0 0;
  padding-left: 14px;
  border-left: 2px solid var(--vp-c-divider);
  color: var(--vp-c-text-2);
  line-height: 1.8;
}
.install-faq a {
  color: var(--vp-c-brand-1);
  font-weight: 500;
}

/* 增强：平板起步骤导航横排 */
@media (min-width: 640px) {
  .install-toc ol {
    flex-direction: row;
    flex-wrap: wrap;
    gap: 10px 28px;
  }
}
</style>
