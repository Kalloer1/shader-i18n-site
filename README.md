# 光影汉化资源站 (shader-i18n-site)

Minecraft Java 版光影包简体中文 `zh_CN.lang` 下载站。

用户在站内找到光影 → 下载对应版本汉化文件 → 放进光影 zip 的 `shaders/lang/` → 游戏内光影菜单显示中文。

**核心原则**：只分发语言文件，不重分发光影本体（版权原因）。

## 在线

- 站点：https://shader-i18n-site.pages.dev
- 仓库：https://github.com/Kalloer1/shader-i18n-site

## 本地开发

```bash
npm install
npm run dev              # VitePress，http://localhost:5173
npm run build            # 生成详情页 + 静态站 → site/.vitepress/dist
npm run catalog          # 拉取 Modrinth 全量目录
npm run sync             # 同步 CurseForge 元数据
npm run translate        # AI 翻译（需 LLM API key 环境变量）
npm run release <id>     # 翻译完成后一键发布
npm run validate:lang -- <en_US.lang> <zh_CN.lang>
```

## 目录结构

| 路径 | 用途 |
|------|------|
| `site/public/lang/` | 462 个 zh_CN.lang 汉化文件 |
| `site/data/shaders.json` | 光影映射（465 条，含夸克链接） |
| `site/data/modrinth-catalog.json` | Modrinth 全量目录（887 条） |
| `site/data/glossary.json` | 翻译记忆（21,537 条） |
| `scripts/` | 翻译管线、同步、发布脚本 |
| `worker/` | Cloudflare Worker（前端→智能表格代理） |

## 自动化

| 工作流 | 触发方式 | 作用 |
|--------|---------|------|
| `deploy.yml` | push main | 构建 + 部署到 Cloudflare Pages |
| `sync.yml` | 每日 UTC 21:00 | 拉取 Modrinth 目录 + 检测新增光影 |

## 决策

| ADR | 内容 |
|---|---|
| [0001](docs/adr/0001-only-distribute-lang-files.md) | 只分发 lang，不重分发光影本体 |
| [0002](docs/adr/0002-vitepress-static-site.md) | VitePress 静态站 |
| [0003](docs/adr/0003-github-primary-quark-mirror.md) | GitHub 为主渠道 + 夸克网盘国内镜像 |
| [0004](docs/adr/0004-catalog-threshold-and-native-zh.md) | 全量目录；自带中文打标仍展示 |
| [0005](docs/adr/0005-auto-translation-pipeline.md) | 翻译流水线 |

## 安全

API key / token 不入库，全部通过 GitHub Secrets 或环境变量管理。
