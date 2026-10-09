# 光影汉化资源站

Minecraft Java 版光影包简体中文 `zh_CN.lang` 下载站（仓库名：`shader-i18n-site`）。

用户在站内找到光影 → 下载与光影版本匹配的汉化文件 → 放进光影 zip 的 `shaders/lang/` → 游戏内光影设置界面显示中文。

> 本文件是项目唯一的正式项目说明文档。项目历史上分散在多个根目录说明和 ADR 文件中的内容，已于 2026-09-11 合并到这里。
>
> `AGENTS.md` 是本地 Agent 环境配置，不属于产品文档；`site/` 下的 Markdown 是网站页面源文件，继续保留。

## 在线地址

- 站点：<https://shader-i18n-site.pages.dev>
- GitHub：<https://github.com/Kalloer1/shader-i18n-site>

## 项目边界

- 只分发独立的 `zh_CN.lang` 文件，不重分发光影本体。
- 光影本体只通过 Modrinth 外链获取。
- 汉化文件必须精确对应光影版本；`lang` 键会随光影版本变化，不能只按光影名称模糊匹配。
- 资源包/材质包不能替代语言文件注入。文件应放在光影包内部的 `shaders/lang/zh_CN.lang`。
- 语言文件输出为 UTF-8 无 BOM，键名、占位符（如 `%s`、`%value%`）和格式码（如 `§`）必须保留。

## 当前状态（数据快照：2026-09-11）

| 项目 | 当前值 | 说明 |
|---|---:|---|
| Modrinth 光影目录 | 887 个 | `site/data/modrinth-catalog.json`，由同步脚本更新 |
| `shaders.json` 条目 | 463 个 | 人工维护的版本映射及同步元数据 |
| 已有 `langVersions` 的光影 | 460 个 | 对应 460 个可下载的 `zh_CN.lang`；自带中文项目不重复分发 |
| GitHub 中的 `zh_CN.lang` 文件 | 460 个 | 位于 `site/public/lang/` |
| 夸克镜像链接 | 460 个 | 字段名为 `quark` |
| 自带中文的目录项目 | 8 个 | `site/data/modrinth-catalog.json` 中标记为 `hasNativeZhCN: true` |
| 明确缺少 `en_US.lang` | 405 个 | 记录在 `site/data/missing-source.json` |
| 尚未登记翻译的可处理项目 | 14 个 | 目录中既没有 `langVersions`，也不在缺源清单中，并排除自带中文项目 |
| 翻译术语记忆 | 21,537 条 | `site/data/glossary.json` |
| 生成的详情页 | 887 个 | `site/shaders/`，由构建脚本生成 |

这些数字是当前快照，不是永久承诺；Modrinth 目录会在每日同步后变化。

### 翻译状态说明

- 新的翻译统一使用 SiliconFlow 上的 `tencent/Hunyuan-MT-7B` 生成，并标记为“AI 初翻”，除非已经人工校对。历史记录中的模型名称保留作为历史来源信息。
- 自带中文的项目应优先使用光影包自身的 `zh_CN.lang`，正常情况下跳过本站翻译。
- 目录中 8 个自带中文项目优先使用光影包本体自带的 `shaders/lang/zh_CN.lang`；其中原先误登记本站翻译的 2 个项目已清理。
- “缺少 `en_US.lang`”与“尚未登记”是两种不同状态，不能合并写成一个待翻译数量。

## 用户安装方法

1. 从站内详情页下载与光影版本一致的 `zh_CN.lang`。
2. 用 7-Zip、WinRAR 或 Bandizip 打开 `.minecraft/shaderpacks/` 下的光影 zip，不要解压。
3. 打开或创建完整路径 `shaders/lang/`，将 `zh_CN.lang` 放入其中。
4. 进入游戏，选择该光影，并确认游戏语言是简体中文。

如果使用的是已经解压的光影文件夹，仍然把文件放入该文件夹的 `shaders/lang/`，效果相同。详细页面见 [`site/guide/install.md`](site/guide/install.md)。

## 本地开发

```bash
npm install
npm run dev              # VitePress 开发服务器：http://localhost:5173
npm run build            # 先生成详情页，再构建 site/.vitepress/dist
npm run preview          # 预览已构建的静态站点
npm run catalog          # 拉取 Modrinth 全量光影目录
npm run sync             # 只同步 Modrinth 元数据
npm run translate        # 启动翻译流水线，需要 LLM API key
npm run release <id>     # 检查指定光影后，提交并推送当前工作区全部变更
npm run detect-changes   # 检测目录新增项并尝试写入腾讯文档
npm run validate:lang -- <en_US.lang> <zh_CN.lang>
```

`npm run build` 通过 npm 的 `prebuild` 钩子执行一次 `scripts/gen-shader-pages.mjs`，然后执行 VitePress 构建；详情页不会重复生成。

### 如何手动启动翻译

不需要直接点击 `pipeline.mjs`。推荐双击仓库根目录的 `start-translation.cmd`：

1. 如果当前 PowerShell 环境已经有 `SILICONFLOW_API_KEY`，脚本直接使用它；否则会在窗口中临时询问 API Key。
2. API Key 只保存在本次进程内，不会写入仓库文件。
3. 脚本会询问是否开始；确认后按 `--top` 数量处理候选。默认 `start-translation.cmd` 只处理 1 个候选，适合先做小规模测试。
4. 也可以在终端执行：`npm run translate -- --top 1`（先处理一个）或 `npm run translate -- --top 50`。
5. 翻译完成后仍需人工检查，再执行 `npm run release <shader-id>` 发布。

如果要长期使用，建议把 `SILICONFLOW_API_KEY` 配置为 Windows 用户环境变量；不要把 Key 写进 `.mjs`、`.cmd`、README 或 GitHub 仓库。

## 运行流程与自动化边界

当前系统不是“所有步骤全自动”：目录/元数据同步和 Cloudflare 部署自动化程度较高；翻译启动、Git 发布确认、夸克上传仍需要人工操作。

### 1. GitHub 每日同步流（自动，也可手动触发）

文件：`.github/workflows/sync.yml`

触发方式：

- GitHub Actions 定时触发：每天 UTC 21:00，即北京时间次日 05:00。
- GitHub Actions 页面中的 `workflow_dispatch` 手动触发。

逐步流程：

1. Actions checkout 当前 `main` 分支。
2. 安装 Node.js 22。
3. 执行 `npm run catalog`，请求 Modrinth API 的全量 shader 项目目录，更新 `site/data/modrinth-catalog.json`。
4. 执行 `npm run sync`，逐条读取 `site/data/shaders.json` 中的 Modrinth slug，请求项目详情和成员信息，只更新同步字段；`nameCN`、`quark`、`langVersions` 等人工维护字段不会被覆盖。
5. 执行 `scripts/detect-changes.mjs`，用 `modrinth-catalog.prev.json` 与新目录比较新增项目；如果配置了 `TENCENT_DOCS_TOKEN`，则把待翻译记录写入腾讯文档智能表格，否则仅打印跳过提示。
6. 保存本次目录快照 `site/data/modrinth-catalog.prev.json`。
7. 如果 JSON 有变化，Actions 自动执行 `git add`、commit、push；没有变化则不产生提交。

该流只负责“发现项目、同步 Modrinth 元数据、登记新增项”，**不会执行 `npm run translate`，也不会调用任何 LLM**。当前已移除 CurseForge/CosForge 集成，因此不需要 `CURSEFORGE_API_KEY` 或 CosForge API Key。

本次隔离实测结果（不修改生产数据）：Modrinth 目录成功拉取 886 个项目；抽取 `complementary-reimagined`、`complementary-unbound`、`bsl-shaders` 三个项目后，三者元数据均成功写入，未设置 CurseForge API Key 也能完成同步，并成功生成 catalog 快照。生产仓库当前目录快照为 887 个项目，数量会随 Modrinth 变化。

### 2. 翻译流水线（内容自动化，但启动是手动的）

入口：`npm run translate`，实现：`scripts/pipeline.mjs`。当前没有 GitHub Actions 定时调用它；因此它不是每日自动翻译。

前置条件：至少配置一个本地环境变量：`SILICONFLOW_API_KEY`。模型固定为 `tencent/Hunyuan-MT-7B`；接口地址可通过 `SILICONFLOW_BASE_URL` 覆盖。

逐步流程：

1. 读取 `site/data/modrinth-catalog.json`、`site/data/shaders.json`、`site/data/missing-source.json` 和 `site/data/glossary.json`。
2. 筛选候选项目：排除已自带 `zh_CN.lang` 的项目、已有最新汉化映射的项目，以及缺少 `en_US.lang` 的项目；当前快照为 887 个目录项目，其中 8 个自带中文、460 个已有本站汉化、405 个缺少英文源，剩余 14 个进入候选范围。
3. 对候选项目请求 Modrinth 最新版本，下载主文件，并在 zip 内查找 `shaders/lang/en_US.lang` 与 `shaders/lang/zh_CN.lang`。
4. 如果检测到官方 `zh_CN.lang`，标记 `hasNativeZhCN` 并跳过；如果找不到英文源，写入缺源记录并跳过。
5. 读取术语记忆 `glossary.json`；完全匹配的英文值直接复用已有中文，未命中的值交给模型翻译，新的映射在处理后写回术语记忆。
6. 解析英文语言文件，按约 60 行拆分为多个块。当前实现按顺序逐块请求；每个块失败时会自动重试，避免免费接口并发限流和同一文件术语不一致。
7. 使用 SiliconFlow 的 `tencent/Hunyuan-MT-7B`；当前只保留这一个翻译模型，并按候选顺序处理，避免免费接口并发限流和同一文件术语不一致。
8. 要求模型只翻译等号右侧，保留 key、占位符（如 `%s`、`%value%`）、`§` 格式码、注释和文件结构。
9. 生成 `site/public/lang/<shader-id>/<shader-version>/zh_CN.lang`，文件头会明确写入“AI 初翻，未人工校对”。
10. 调用 `scripts/validate-lang.mjs` 校验 key 集合、占位符、格式码、编码和结构；失败或回退率过高时不上线、不登记，留待下次重试。
11. 校验通过后更新 `site/data/shaders.json` 的 `langVersions`，并持久化 `modrinth-catalog.json` 与 `glossary.json`。
12. 人工检查翻译质量；人工检查不是脚本自动完成的。确认后再进入发布步骤。

所以，翻译内容生成是自动的，但“开始运行”必须由用户在本地手动执行，API key、额度和人工质量确认也都由用户负责。

### 3. Git 发布与 Cloudflare 部署（半自动）

入口：`npm run release <shader-id>`，实现：`scripts/release.mjs`。

1. 脚本检查该光影目录下是否存在 `site/public/lang/<shader-id>/<version>/zh_CN.lang`。
2. 执行 `git add -A`，把当前工作区全部变更加入暂存区；因此运行前必须先检查 `git status`，它并不只提交参数对应的光影。
3. 创建提交，提交信息为 `发布 <shader-id> 汉化文件`。
4. 执行 `git push` 推送到 `main`；脚本本身没有人工审批、夸克上传或回滚逻辑。
5. 推送后触发 `.github/workflows/deploy.yml`（也可在 Actions 页面使用 `workflow_dispatch` 手动触发）。
6. Deploy workflow 安装依赖并执行 `npm run build`：先生成详情页，再构建 VitePress 静态产物到 `site/.vitepress/dist`。
7. 使用 Wrangler 将构建目录部署到 Cloudflare Pages 项目 `shader-i18n-site`。

当前边界：Git push 后 Cloudflare 部署是自动的；`release.mjs` 的启动仍然是手动的；夸克字段 `quark` 仍需手动维护和上传，项目中没有夸克上传 API/脚本。

### 4. 请求翻译链路（独立于批量翻译）

站内 `/request` 页面提交请求后，前端调用 Cloudflare Worker，Worker 再调用腾讯文档智能表格 API。它只登记用户请求，不会自动下载光影、调用 LLM 或生成 `zh_CN.lang`。

## 目录结构

```text
site/
├── index.md                          # 首页页面源文件
├── guide/install.md                  # 安装教程页面
├── shaders/<id>.md                   # 构建期生成的详情页
├── public/lang/<id>/<ver>/zh_CN.lang # 可分发汉化文件
├── data/
│   ├── modrinth-catalog.json         # Modrinth 目录
│   ├── shaders.json                  # 人工维护的版本映射
│   ├── glossary.json                 # 翻译记忆
│   └── missing-source.json           # 缺少英文源的项目 ID
scripts/
├── fetch-catalog.mjs                 # 拉取 Modrinth 目录
├── sync-metadata.mjs                 # 同步元数据
├── pipeline.mjs                      # Hunyuan-MT-7B 翻译流水线
├── validate-lang.mjs                 # lang 结构校验
├── gen-shader-pages.mjs              # 生成详情页
├── detect-changes.mjs                # 检测新增目录项目
└── release.mjs                       # 提交并推送发布
worker/index.js                       # 请求翻译表单的 Cloudflare Worker
.github/workflows/
├── deploy.yml                        # 构建并部署 Cloudflare Pages
└── sync.yml                          # 每日目录/元数据同步
```

`sources/` 是本地英文源文件目录，已加入 `.gitignore`，不会进入公开仓库。

## 自动化工作流

### Deploy to Cloudflare Pages

- 文件：`.github/workflows/deploy.yml`
- 触发：推送到 `main` 或手动触发
- 步骤：安装依赖 → `npm run build` → 使用 Wrangler 部署到 Cloudflare Pages
- Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`

### 每日同步

- 文件：`.github/workflows/sync.yml`
- 触发：每天 UTC 21:00，即北京时间次日 05:00；也支持手动触发
- 步骤：同步 Modrinth 目录 → 同步元数据 → 检测新增目录项目 → 尝试写入腾讯文档 → 自动提交变更
- Secret：`TENCENT_DOCS_TOKEN`（可选；仅用于写入腾讯文档智能表格）
- 注意：此工作流不执行翻译，不会自动调用 LLM。

### 请求翻译链路

站内 `/request` 页面将请求发送到 Cloudflare Worker，Worker 再调用腾讯文档智能表格 API。Worker 使用的 Secret 是 `TENCENT_DOCS_TOKEN`。

## 密钥与安全

- API key、token、Cookie 不入库，也不要写进 Markdown、JSON 或 GitHub Actions 日志。
- GitHub Actions 使用 GitHub Secrets。
- 翻译流水线的本地密钥：`SILICONFLOW_API_KEY`；模型固定为 `tencent/Hunyuan-MT-7B`。
- 本机 Wrangler 可使用 Cloudflare Global API Key + 邮箱环境变量 `CLOUDFLARE_API_KEY`、`CLOUDFLARE_EMAIL`；已验证可读取账户和 Pages 项目。不要把 Global API Key 提交到仓库。
- GitHub 的 Deploy workflow 当前使用更适合 CI 的 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID` Secrets；这与本机 Global API Key + Email 是两套认证方式。
- Worker 使用 Wrangler Secret 配置 `TENCENT_DOCS_TOKEN`；每日同步中的同名 GitHub Secret 是可选的。
- `sources/`、依赖目录和构建缓存均不应提交。

## 历史决策摘要

1. **只分发语言文件**：避免重分发光影本体；本项目只提供独立 `zh_CN.lang`。
2. **使用 VitePress 静态站**：数据以 JSON 进入仓库，详情页在构建期生成，部署到 Cloudflare Pages。
3. **GitHub 主渠道 + 夸克镜像**：GitHub 用于版本化和主下载，夸克用于国内访问备用。
4. **全量目录**：从 Modrinth 拉取已发布的 shader 项目，不再使用下载量门槛；自带中文项目仍展示在目录中。
5. **自动翻译但醒目标注**：AI 初翻可以直接提供下载，但必须明确标记“未人工校对”；人工校对后再登记新版本。
6. **双仓方案已废弃**：早期曾计划将数据和公开站点分仓，2026-09-11 已合并为单仓；当前不再按双仓方案维护。

## 待办事项

### 中优先级

- 将 `release.mjs` 与夸克上传流程整合；当前 release 只负责 git add/commit/push。
- 完成 Worker 端到端测试：前端表单 → Worker → 腾讯文档智能表格。
- 继续观察 `sync.yml` 的定时运行结果；主链路已在隔离目录完成实测。
- 处理 14 个尚未登记翻译、且已有可获取英文源的目录项目。

### 低优先级

- 复核剩余英文值、专有名词及无 key 文本；这些不一定是格式错误。
- 评估 `§` 标记位置偏差的人工复核流程。
- 将类似光影推荐从随机热门池改为基于 categories 的匹配。

## 术语

- **光影包（Shaderpack）**：放入 `shaderpacks` 目录的光影压缩包。
- **光影本体**：原作者发布的完整光影 zip，本项目不重分发。
- **汉化文件**：针对特定光影版本生成的 `zh_CN.lang`。
- **语言文件注入**：把文件放入光影包内部 `shaders/lang/` 的操作。
- **版本映射**：光影版本与对应汉化文件之间的精确关系。
- **自带中文**：光影包自身已经包含 `shaders/lang/zh_CN.lang`。
- **AI 初翻**：由 LLM 生成、尚未人工校对的汉化文件。
- **全量目录**：由 Modrinth API 同步的站内项目列表，不代表每个项目都有本站汉化文件。

## 文档边界

- 本文件：项目架构、状态、流程、决策和待办的唯一来源。
- `site/guide/install.md`、`site/request/index.md` 等：网站面向用户的页面内容，不与本文件重复维护项目状态。
- `AGENTS.md`：本地 Agent/MCP 环境配置，不是产品说明。
