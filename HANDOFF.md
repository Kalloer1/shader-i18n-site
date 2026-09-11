# 项目交接文档

> 最后更新：2026-09-11
> 本文档供接手的 Agent 或开发者快速了解项目全貌。

---

## 一、项目概述

**光影汉化资源站**：Minecraft Java 版光影包（Shaderpack）的简体中文 `zh_CN.lang` 下载站。

用户流程：在站内找到光影 → 下载对应版本的汉化文件 → 放进光影 zip 的 `shaders/lang/` → 游戏内光影菜单变中文。

**核心原则**：只分发语言文件，不重分发光影本体（版权原因）。光影本体一律外链 Modrinth / CurseForge。

---

## 二、仓库结构（单仓）

| 仓库 | 地址 | 内容 |
|------|------|------|
| `shader-i18n-site` | [github.com/Kalloer1/shader-i18n-site](https://github.com/Kalloer1/shader-i18n-site) | VitePress 站点 + 翻译管线 + 同步脚本 + 887 个详情页 + 462 个 zh_CN.lang |

**本地路径**：`C:\Users\Sora\Desktop\shader\shader-i18n-site`

---

## 三、技术栈

| 层 | 技术 |
|---|---|
| 框架 | VitePress 1.6.x（Vue 3） |
| 样式 | 自定义 CSS（暗色画廊风：深炭底 #0d1117 + 火把琥珀 #e8a33d） |
| 展示字体 | Chakra Petch（Google Fonts） |
| 图片灯箱 | medium-zoom |
| 部署 | Cloudflare Pages（GitHub Actions 自动构建） |
| 数据源 | Modrinth API（主）、CurseForge API（辅，元数据） |
| 翻译模型 | MiMo-v2.5 / grok-4.6 / GLM-4.7-flash |

---

## 四、关键文件索引

### 文件结构

```
site/
├── index.md                          # 首页（HomeHero + FeatureRow + ShaderList）
├── guide/install.md                  # 安装教程
├── shaders/<id>.md                   # 887 个详情页（构建期自动生成，勿手改）
├── public/lang/<id>/<ver>/zh_CN.lang # 462 个汉化文件（静态资源）
├── data/
│   ├── modrinth-catalog.json         # Modrinth 全量目录（887 条）
│   ├── shaders.json                  # 光影映射（465 条，462 有翻译 + 夸克链接）
│   ├── glossary.json                 # 翻译记忆（21,537 条骨架→中文映射）
│   └── missing-source.json           # 缺少英文源的光影列表
├── .vitepress/
│   ├── config.mts                    # VitePress 配置
│   └── theme/
│       ├── style.css                 # 全局样式
│       ├── data.js                   # 数据合并（catalog + shaders.json）
│       ├── modrinth-api.js           # 客户端 Modrinth API 加载器
│       └── components/
│           ├── HomeHero.vue          # 首页 Hero
│           ├── FeatureRow.vue        # 三格特性说明
│           └── ShaderList.vue        # 光影列表（标签筛选/布局切换/搜索）
scripts/
├── gen-shader-pages.mjs              # 构建期生成 887 个详情页
├── validate-lang.mjs                 # lang 文件校验
├── fetch-catalog.mjs                 # 拉取 Modrinth 全量目录
├── sync-metadata.mjs                 # 同步 CurseForge 精选元数据
├── pipeline.mjs                      # 翻译管线（MiMo/grok/GLM）
├── fetch-lang-sources.mjs            # 拉取英文语言源文件
└── release.mjs                       # 发布脚本（git add/commit/push）
sources/
└── <shader-id>/<version>/en_US.lang  # 英文语言源文件（.gitignore 排除）
.github/workflows/
├── deploy.yml                        # Cloudflare Pages 部署（push main 触发）
└── sync.yml                          # 每日目录同步（UTC 21:00）
```

---

## 五、当前状态

### 数据

| 指标 | 数值 |
|------|------|
| Modrinth 全量目录 | 887 个光影 |
| 已有 zh_CN.lang | 462 个 |
| shaders.json 条目 | 465 条（462 有翻译 + 夸克链接） |
| langVersions 总数 | 462 个版本映射 |
| 夸克网盘永久分享链接 | 462 条 |
| 待翻译（无英文源） | 3 个（photon-shader, bliss-shader, makeup-ultra-fast-shaders） |

### 部署

- **站点地址**：https://shader-i18n-site.pages.dev/
- **部署方式**：GitHub Actions → Cloudflare Pages
- **触发条件**：公开仓 `main` 分支推送
- **最新提交**：请查看 `git log --oneline -1`

### 自动化工作流

- **每日 UTC 21:00**（`sync.yml`）：`fetch-catalog` → `sync-metadata` → 自动 commit
- **翻译流程**：玩家请求 + 自动检测 → 智能表格 → 手动触发翻译 → release 脚本发布
- **冷启动翻译**：已完成（MiMo-v2.5，150/150 通过）。

---

## 六、密钥管理

- **GitHub Secrets**：`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`、`CURSEFORGE_API_KEY`（可选）
- **本地环境变量**：LLM API key（`XIAOMI_API_KEY` / `LVYRIX_API_KEY` / `ZHIPU_API_KEY`）
- **夸克网盘**：Cookie 存储在本地 MCP 配置中
- **全部密钥通过 GitHub Secrets 或环境变量管理，不入版本库。**

---

## 七、构建与开发

```bash
cd C:\Users\Sora\Desktop\shader\shader-i18n-site
npm install
npm run dev              # 本地开发（http://localhost:5173）
npm run build            # 生成详情页 + 静态站（~85s）
npm run catalog          # 拉取 Modrinth 全量目录
npm run sync             # 同步 CurseForge 元数据
npm run translate        # 翻译（需 LLM API key）
npm run validate:lang -- <en_US.lang> <zh_CN.lang>
```

---

## 八、已知问题与待办

### 高优先级

1. ~~shaders.json 条目太少~~ ✅ 已补全至 465 条（462 有翻译）。

2. ~~翻译管线未自动化~~ ✅ MiMo-v2.5 + glossary 翻译已完成 150 个 shader，全部验证通过。

3. ~~Cloudflare API Token~~ ✅ 已更新并部署成功。

### 中优先级

4. ~~夸克/国内镜像链接~~ ✅ 462/462 已上传夸克网盘并回填 shaders.json。

5. **Git 历史已清理**：所有 commit 已压缩为单次提交。

### 低优先级

6. **类似光影推荐基于随机**：当前从热门光影池随机抽取，无 categories 精准匹配。

7. **首页轮播动画**：无限循环左滑实现（1-2-3-1-2-3），`transitionend` 事件处理无缝跳转。移动端隐藏。

---

## 九、设计语言

| 元素 | 值 |
|------|---|
| 底色 | #0d1117（深炭） |
| 主色 | #e8a33d（火把琥珀） |
| 成功色 | #4fb286（苔绿，已校对标签） |
| AI 标签色 | #e8a33d（琥珀，AI 初翻标签） |
| 展示字体 | Chakra Petch |
| 导航 | 玻璃模糊（backdrop-filter: blur(8px)） |
| 氛围层 | 双色辐射光晕 + 颗粒噪点 |
| 详情页风格 | Steam/Epic 游戏平台风格 |
| Hero | 全宽大图 65vh（移动端 50vh） |
| 标签页 | 下载 / 图库 / 介绍 / 安装方法 |

---

## 十、术语速查

| 术语 | 含义 |
|------|------|
| 光影包 (Shaderpack) | 原作者发布的光影压缩包，设置界面文字来自 `shaders/lang/*.lang` |
| 汉化文件 | `zh_CN.lang`，放入光影 zip 的 `shaders/lang/` 后游戏显示中文 |
| 版本映射 | 光影版本 ↔ 汉化版本的精确对应关系 |
| 自带中文 | 光影包内已含 `zh_CN.lang`，标记 `hasNativeZhCN: true` |
| AI 初翻 | 由 AI 模型自动生成、未经人工校对的汉化文件 |
| 全量目录 | Modrinth API 自动同步的站内光影清单（873 个） |
| 收录门槛 | Modrinth 已审核发布的全部 shader 类型项目均收录 |

完整术语表见 [CONTEXT.md](CONTEXT.md)。

---

## 十一、ADR 索引

| ADR | 决策 |
|-----|------|
| [0001](docs/adr/0001-only-distribute-lang-files.md) | 只分发 lang，不重分发光影本体 |
| [0002](docs/adr/0002-vitepress-static-site.md) | VitePress 静态站 |
| [0003](docs/adr/0003-github-primary-quark-mirror.md) | GitHub 为主渠道 |
| [0004](docs/adr/0004-catalog-threshold-and-native-zh.md) | 全量目录；自带中文打标仍展示 |
| [0005](docs/adr/0005-auto-translation-pipeline.md) | 翻译流水线 |
| [0006](docs/adr/0006-two-phase-translation-and-dual-repo.md) | ~~双仓 + 冷启动与日更分开~~（已合并为单仓） |

---

## 十二、安全约定

- **API key / token 一律不入库**。密钥只用 GitHub Secrets 或环境变量。
- **密钥存储在本地，不入库。**
- **已清理**：旧 Git 历史中的明文 key 已通过 squash 清除。

---

## 十三、联系方式

- GitHub：[Kalloer1](https://github.com/Kalloer1)
- 站点：https://shader-i18n-site.pages.dev/
