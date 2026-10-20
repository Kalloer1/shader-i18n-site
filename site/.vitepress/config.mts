import { defineConfig } from 'vitepress'

// https://vitepress.dev/zh/reference/site-config
export default defineConfig({
  lang: 'zh-CN',
  title: '光影汉化资源站',
  description:
    'Minecraft Java 版光影包简体中文汉化文件下载站：查找你的光影包，下载对应版本的 zh_CN.lang，游戏内光影界面显示中文。',
  appearance: false, // 只有一套洞穴石材质感主题，不提供明暗切换
  head: [
    ['meta', { name: 'theme-color', content: '#0b0907' }],
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
  ],

  // /lang/ 下的汉化文件是 public 静态资源（site/public/lang/...），
  // 构建期确实存在，但 VitePress 死链检查只认 md 页面，需对该前缀豁免
  ignoreDeadLinks: [/^\/lang\//],

  themeConfig: {
    nav: [
      { text: '光影列表', link: '/#shader-list' },
      { text: '安装教程', link: '/guide/install' },
      { text: '请求翻译', link: '/request/' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: '使用指南',
          items: [
            { text: '安装教程', link: '/guide/install' },
          ],
        },
      ],
    },
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一页', next: '下一页' },
    lastUpdated: { text: '最后更新于' },
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '菜单',
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    footer: {
      message:
        '只分发 zh_CN.lang，不重分发光影本体 · 数据来自 Modrinth · 光影版权归原作者所有',
      copyright: '光影汉化资源站 · 为中文 MC 玩家服务',
    },
  },
})
