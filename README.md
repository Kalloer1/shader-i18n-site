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

## 当前状态（数据快照：2026-10-16）

| 项目 | 当前值 | 说明 |
|---|---:|---|
| Modrinth 光影目录 | 1000 个 | `site/data/modrinth-catalog.json`，由同步脚本更新 |
| CurseForge 目录 | 749 个 | `site/data/curseforge-catalog.json`，由同步脚本更新（采集失败不影响主链） |
| `shaders.json` 条目 | 547 个 | 人工维护的版本映射及同步元数据 |
| 已有 `langVersions` 的光影 | 542 个 | 含目录外的历史精选条目 |
| GitHub 中的 `zh_CN.lang` 文件 | 601 个 | 位于 `site/public/lang/`，一个光影可有多个历史版本 |
| 自带中文的目录项目 | 33 个 | 以 `modrinth-catalog.json` 条目的 `hasNativeZhCN` 标记为准 |
| 明确缺少 `en_US.lang` | 439 个 | 以 `modrinth-catalog.json` 条目的 `noEnUsLang` 标记为准 |
| 尚未登记翻译的可处理项目 | 1 个 | 目录中既没有 `langVersions`，也不在缺源清单中，并排除自带中文项目 |
| 翻译术语记忆 | 39,448 条 | `site/data/glossary.json` |
| 生成的详情页 | 构建期生成 | `site/shaders/`（**未入库**，`.gitignore` 排除）；只展示已有本站汉化或自带中文的项目 |

这些数字是当前快照，不是永久承诺；Modrinth 目录会在每日同步后变化。

### 翻译状态说明

- 新的翻译默认由**免费层**（bilibili Index-Translate 公开 API）生成，失败才落到自建网关模型池；两者都标记为“AI 初翻”，除非已经人工校对。`langVersions[].contributors` 会写明实际产出方（「免费层 X」或「回退池 Y」），混合产出两边都写。历史记录中的模型名称保留作为历史来源信息。见《历史决策摘要》第 7 条。
- 自带中文的项目应优先使用光影包自身的 `zh_CN.lang`，正常情况下跳过本站翻译。
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
npm run translate        # 启动翻译流水线（--top N 按候选取前 N 个；--ids a,b,c 只处理指定光影）
npm run mirror -- --ids a,b,c  # 把已产出的 lang 镜像到夸克网盘，并回写分享链接
npm run release <id>     # 检查指定光影后，提交并推送当前工作区全部变更
npm run detect-changes   # 检测目录新增项并尝试写入腾讯文档
npm run validate:lang    # 全量闸门：批量校验 site/public/lang 下所有 zh_CN.lang
npm run validate:lang -- <en_US.lang> <zh_CN.lang>   # 单文件模式
npm run fix:lang         # 修复译文引入的畸形 § 序列（--dry-run 只报告）
npm run pack:lang        # 重打包英文源到 data/lang-sources.json.gz（合并式）
```

`npm run build` 通过 npm 的 `prebuild` 钩子执行一次 `scripts/gen-shader-pages.mjs`，然后执行 VitePress 构建；详情页不会重复生成。

### 语言校验闸门

`npm run validate:lang`（`scripts/validate-lang.mjs`）在本地与 CI 都会跑，不传参时批量校验 `site/public/lang` 下全部 601 个 `zh_CN.lang` 文件。

- **失败（退出码 1）**：缺键/多键、译文引入的畸形 `§` 序列、非 `%%` 占位符差异、BOM、翻译新增的重复键、找不到英文源。
- **警告（不阻断）**：`§` 格式码数量差异、`%%` 差异、上游 EN 自带的乱码、继承自上游的重复键、值与英文相同。
- **英文源解析顺序**：同目录 `en_US.lang` → `sources/<id>/<version>/en_US.lang` → `data/lang-sources.json.gz`。
  `sources/` 不入库（版权属原作者），因此 CI 靠 `data/lang-sources.json.gz`（约 2 MB）做**真实比对**；三处都没有会**判失败**，绝不退回“自检”产生假绿灯。
- 写入 `sources/` 后（`npm run translate` 会写）记得跑 `npm run pack:lang` 刷新压缩包，否则 CI 看不到新英文源。

### 如何启动翻译

两条路径：

**A. 站点触发（推荐）** —— 玩家在 `/request` 页提交请求后，管理员在该页的「翻译工作台」输入口令点「开启翻译」；Worker 校验口令后调用 GitHub Actions 触发 `.github/workflows/translate.yml`，逐条翻译、自动校验、自动提交发布。

**B. 本地手动** —— 双击仓库根目录的 `start-translation.cmd`，或执行 `npm run translate -- --top 1` / `npm run translate -- --ids a,b,c`：

1. **已实现**：免费层不需要任何 key，**无 key 也能跑**（以「免费层单跑」模式运行，缺 key 时只打印警告）；只在落到网关回退池时才需要 `LLM_API_KEY`（或别名 `SILICONFLOW_API_KEY`）。同时用 `FREE_TIER_ENABLED=0` 关掉免费层且没有 key 时，仍然报错退出。
2. 有 key 时脚本会在窗口中临时询问 API Key。
3. API Key 只保存在本次进程内，不会写入仓库文件。
4. 脚本以 10 并发处理候选，单条光影内的分块并发默认 3。
5. 产出后由自动校验闸门判定是否可上线，不再需要人工确认。

如果要长期使用回退池，建议把 `LLM_API_KEY` 配置为 Windows 用户环境变量；不要把 Key 写进 `.mjs`、`.cmd`、README 或 GitHub 仓库。

## 运行流程与自动化边界

目录/元数据同步、翻译、校验、Git 提交、Cloudflare 部署与网盘镜像均已自动化；唯一需要人工的是「点一下开启翻译」（在 `/request` 工作台输入口令），以及网盘凭证到期后的重新授权。

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

该流只负责“发现项目、同步 Modrinth 元数据、登记新增项”，**不会执行 `npm run translate`，也不会调用任何 LLM**。

CurseForge 目录采集是 `continue-on-error: true` 的可选步骤（`scripts/fetch-curseforge-catalog.mjs`，写 `site/data/curseforge-catalog.json`）：CF 挂了绝不能影响 Modrinth 主链，因此需要 `CURSEFORGE_API_KEY`；未配置时该步骤失败但整条 workflow 仍为绿。

**写者耦合**：`sync.yml` 与 `translate.yml` 都会 commit + push `main`，两者共用 `concurrency: group: repo-write`（`cancel-in-progress: false`）以避免互相挤掉；两个 workflow 都用**显式路径** `git add`，禁止 `git add -A`。

### 2. 翻译流水线（站点触发或本地手动）

入口：`npm run translate`，实现：`scripts/pipeline.mjs`。由 `.github/workflows/translate.yml` 在站点 `/request` 点「开启翻译」时调用；也可在本地手动运行。

前置条件（**当前已实现的行为**）：翻译提供方是**两层**。

1. **免费层**：bilibili 官方免费公网 API `https://index-translate.bilibili.com/v1`，**无需 API key**。默认模型 `index-mt-9b-syllable`（2026-10-20 起；原 `Index-Translate-35B-A3B` 持续 504）。用独立环境变量配置（`FREE_TIER_ENABLED` / `FREE_TIER_BASE_URL` / `FREE_TIER_MODEL` / `FREE_TIER_CONCURRENCY`）。它不参与 `LLM_MODELS`，但**会出现在站点 `/request` 的模型勾选里**（单独一组，由 Worker 实测探测存活）。逐句模型自动走一行一请求的路径，详见《历史决策摘要》第 9 条。
2. **回退池（兜底）**：自建中转站 `https://api.888424.xyz/v1`（OpenAI 兼容），需要 `LLM_API_KEY`（或别名 `SILICONFLOW_API_KEY`），换站时用 `LLM_BASE_URL` 覆盖。默认模型池 `kilo/kilo-auto/free,kilo/poolside/laguna-s-2.1:free`（来自 `.github/workflows/translate.yml`，2026-10-20 实测更新；旧的 `opencode-zen-free/*` 三个模型已从网关下架）。

**没有 `LLM_API_KEY` 时不再报错退出**：回退池留空，以「免费层单跑」模式运行（缺 key 时打印警告）。但若同时用 `FREE_TIER_ENABLED=0` 关掉了免费层，则仍然报错退出——没有任何可用提供方时不该假装能干活。

> 免费层是无 SLA 的公开服务，可能随时变化或下线，因此**不替代**回退池。选它的依据是实测：用本站真实英文源跑 60 行分块，键 60/60 保留、`§` 零差异、回退 0~1 行、1.0~4.4 秒。详细决定见《历史决策摘要》第 7 条。

并发默认 10（`LLM_CONCURRENCY`）；单条光影内的分块并发默认 3、上限 4（`LLM_CHUNK_CONCURRENCY`）。

> ⚠️ **回退池是“轮班”，不是优先级链**：`nextProviderOrder` 按 `providerCursor++ % list.length` 轮转，因此列表里每个模型都会分到约 1/N 的分块。**只有「格式严格遵守 + 零丢键」的模型才能进这个列表**——「能用」不是入选理由，弱模型放进来会实打实拉低 1/N 的产出。历史已实测淘汰：`tencent/Hunyuan-MT-7B`（改写键名、丢键）、`hy3`（推理 token 吃光预算、正文全空）、`muse-spark-*` / `mimo-v2.6-flash-free`（网关上已不存在）、`deepseek-v4.1-flash` / `deepseek-v4-flash` / `u2-flash`（2026-10-17 网关账号池空，全部 503）、`opencode-zen-free/nemotron-3.5-lightning-free`（90 秒超时）。

> ⚠️ **免费层的失败处理与回退池刻意不同**：单次尝试、**无退避重试**、单请求 **60 秒超时**（回退池仍是 `MAX_RETRIES=10` 带退避）。另外免费层**连续 2 次**失败才熔断——单次抖动只降级当前分块，不熔断整轮。实测免费层会把键名一起翻掉（`option.A` → `选项A`），因此它的回话**键集合必须完整**，否则直接判失败（那种回话不能当「翻得差」）。回话完整但回退率 >10% 时转交回退池再试，但**不**记失败。

逐步流程：

1. 读取 `site/data/modrinth-catalog.json`、`site/data/curseforge-catalog.json`、`site/data/shaders.json` 和 `site/data/glossary.json`。
2. 筛选候选项目：排除已自带 `zh_CN.lang` 的项目、已有最新汉化映射的项目，以及 `noEnUsLang === true`（缺少 `en_US.lang`）的项目。
3. 跨平台去重：若同一光影在 Modrinth 侧已有汉化，直接判完成，不消耗任何 LLM 预算。
4. 对候选项目请求最新版本，下载主文件，并在 zip 内查找 `shaders/lang/en_US.lang` 与 `shaders/lang/zh_CN.lang`（CurseForge 分支按 release 优先 + fileDate 倒序逐个候选文件尝试）。
5. 如果检测到官方 `zh_CN.lang`，标记 `hasNativeZhCN` 并跳过；如果找不到英文源，置 `noEnUsLang` 标记并跳过。
6. 读取术语记忆 `glossary.json`；按剥离 `§` 格式码后的英文骨架完全匹配的直接复用已有中文，未命中的值交给模型翻译，新的映射在处理后写回术语记忆。
7. 解析英文语言文件，按 60 行（`CHUNK_LINES`）拆分为多个块。每个块**先走免费层**；失败（超时 / 非 2xx / 空正文 / 键集合不完整）或回退率 >10% 才落到回退池。回退池内按分块轮转调用，单个模型失败或回退率过高时自动尝试下一个模型。
8. 要求模型只翻译等号右侧，保留 key、占位符（如 `%s`、`%value%`）、`§` 格式码、注释和文件结构。
9. 生成 `site/public/lang/<shader-id>/<shader-version>/zh_CN.lang`，文件头会明确写入“AI 初翻，未人工校对”。
10. 调用 `scripts/validate-lang.mjs` 校验 key 集合、占位符、格式码、编码和结构；失败或回退率过高时不上线、不登记，留待下次重试。
11. 校验通过后更新 `site/data/shaders.json` 的 `langVersions`，并持久化 `modrinth-catalog.json` 与 `glossary.json`。
12. 产出后立即进入发布链路（Git commit/push → Cloudflare 部署），不再有「人工确认」这一步。

**质量来源**：唯一的质量闸门是自动校验（`scripts/validate-lang.mjs`：键集合、`§` 格式码数量、占位符种类与数量、UTF-8 无 BOM），加上玩家反馈。校验不通过则**不写文件、不登记、不上线**。玩家反馈触发重译。

**已知漂移（免费层）**：免费层会把 `%%`（转义的字面百分号）压成 `%`，实测约 0.01% 的行。`validate-lang.mjs` 已把 `%%` 差异归为**只警告不阻断**，故不会卡发布；此处如实记录，不做后处理。

所以，翻译内容生成与启动都是自动的：站点 `/request` 页点「开启翻译」→ Worker 触发 GitHub Actions → 逐条翻译 → 自动校验 → 自动提交发布。API key 与额度由仓库 Secrets 负责。

### 3. Git 发布与 Cloudflare 部署（自动）

正常情况下无需手动跑 `release.mjs`：`.github/workflows/translate.yml` 在翻译结束后直接 commit + push，推送即触发部署。

手动补发布时入口为 `npm run release <shader-id>`，实现：`scripts/release.mjs`。

1. 脚本检查该光影目录下是否存在 `site/public/lang/<shader-id>/<version>/zh_CN.lang`。
2. 暂存**显式路径**（`site/public/lang/<shader-id>`、`site/data/shaders.json`、`glossary.json`、`modrinth-catalog.json`），不再使用 `git add -A`。
3. 创建提交，提交信息为 `发布 <shader-id> 汉化文件`。
4. 执行 `git push` 推送到 `main`。
5. 推送后触发 `.github/workflows/deploy.yml`（也可在 Actions 页面使用 `workflow_dispatch` 手动触发）。
6. Deploy workflow 先跑测试与全量 lang 校验（质量闸门），再执行 `npm run build`：先生成详情页，再构建 VitePress 静态产物到 `site/.vitepress/dist`。
7. 用 Wrangler 先 `deploy` Worker，再部署 Pages 项目 `shader-i18n-site`。

当前边界：整条发布链路（翻译 → 校验 → commit → push → 部署）已自动化；网盘镜像失败只让对应链接留空，不阻断发布。

### 4. 请求翻译链路（提交 + 触发）

站内 `/request` 页面提交请求后，前端调用 Cloudflare Worker：Worker 校验 Modrinth 链接后写入 KV 队列（权威状态源），并尽力镜像到腾讯文档智能表格。

同一页面的「翻译工作台」会轮询 `GET /queue` 显示队列与状态；管理员输入口令后 `POST /translate`，Worker 调 GitHub Actions 的 `translate.yml` 触发翻译。翻译结束后 `mirror.mjs` 把 lang 上传到夸克网盘并写回分享链接。

## 目录结构

```text
site/
├── index.md                          # 首页页面源文件
├── guide/install.md                  # 安装教程页面
├── shaders/<id>.md                   # 构建期生成的详情页（未入库，.gitignore 排除）
├── public/lang/<id>/<ver>/zh_CN.lang # 可分发汉化文件
├── data/
│   ├── modrinth-catalog.json         # Modrinth 目录
│   ├── curseforge-catalog.json       # CurseForge 目录
│   ├── shaders.json                  # 人工维护的版本映射
│   └── glossary.json                 # 翻译记忆
├── .vitepress/                       # VitePress 配置与主题（data.js 的展示判据必须与生成器逐字一致）
scripts/
├── fetch-catalog.mjs                 # 拉取 Modrinth 目录
├── fetch-curseforge-catalog.mjs      # 拉取 CurseForge 目录（可选）
├── sync-metadata.mjs                 # 同步元数据
├── pipeline.mjs                      # 翻译流水线（--top / --ids）
├── lib/                              # 纯函数模块：providers / provider-chain / llm-guard / pool / glossary / cross-platform / cf-api
├── validate-lang.mjs                 # lang 结构校验（唯一质量闸门）
├── pack-lang-sources.mjs             # 合并式重打包英文源 → data/lang-sources.json.gz
├── mirror.mjs                        # 上传 lang 到夸克网盘并写回分享链接
├── gen-shader-pages.mjs              # 生成详情页
├── detect-changes.mjs                # 检测新增目录项目
└── release.mjs                       # 提交并推送发布
shared/                               # Worker 与 Node 共用：tencent-docs / submit-limit / zip-range
tests/                                # node --test：数据契约 + 校验器回归
data/lang-sources.json.gz             # 英文源压缩包（CI 校验用，sources/ 未入库）
worker/index.js                       # 请求表单 + KV 队列 + 翻译触发的 Cloudflare Worker
.github/workflows/
├── deploy.yml                        # 测试/校验 → 构建 → 部署 Worker 与 Pages
├── sync.yml                          # 每日目录/元数据同步
├── translate.yml                     # 站点触发的翻译 + 镜像 + 自动提交
└── sync-worker-secrets.yml           # GitHub secret → Worker（含空值闸门）
```

`sources/` 是本地英文源文件目录，已加入 `.gitignore`，不会进入公开仓库。

## 自动化工作流

### Deploy to Cloudflare Pages

- 文件：`.github/workflows/deploy.yml`
- 触发：推送到 `main` 或手动触发
- 步骤：安装依赖 → `npm test` → `npm run validate:lang` → `npm run build` → **先** Deploy Worker（wrangler）→ **再** Deploy Pages
- Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`
- 顺序不能颠倒：Worker 必须先于 Pages 部署，否则线上 API 仍是旧版本。删除人工质量确认后，这里的测试 + 全量 lang 校验是唯一的质量防线。

### 每日同步

- 文件：`.github/workflows/sync.yml`
- 触发：每天 UTC 21:00，即北京时间次日 05:00；也支持手动触发
- 步骤：同步 Modrinth 目录 → 同步元数据 → 检测新增目录项目 → 尝试写入腾讯文档 → 拉取 CurseForge 目录（可选）→ 自动提交变更
- Secret：`TENCENT_DOCS_TOKEN`（可选；仅用于写入腾讯文档智能表格）、`CURSEFORGE_API_KEY`（可选；仅用于拉取 CurseForge 目录，缺失时该步骤失败但整条 workflow 仍为绿）
- 注意：此工作流不执行翻译，不会自动调用 LLM。
- 写者耦合：本工作流与 `translate.yml` 共用 `concurrency: group: repo-write`，因为两者都会 commit + push `main`。

### 请求翻译链路

站内 `/request` 页面将请求发送到 Cloudflare Worker，Worker 写入 KV 队列（权威状态源）并**尽力**镜像到腾讯文档智能表格；管理区口令校验后 `POST /translate` 触发 GitHub Actions。Worker 使用的 Secret 包括 `TENCENT_DOCS_TOKEN`、`TRANSLATE_PASSPHRASE`、`INTERNAL_STATUS_TOKEN`、`GITHUB_PAT`、`BREVO_API_KEY`、`EMAIL_FROM`、`LLM_API_KEY`（经 `sync-worker-secrets.yml` 从 GitHub secret 同步）。

## 密钥与安全

- API key、token、Cookie 不入库，也不要写进 Markdown、JSON 或 GitHub Actions 日志。
- GitHub Actions 使用 GitHub Secrets。
- 翻译流水线的本地密钥：`LLM_API_KEY`（或别名 `SILICONFLOW_API_KEY`）；接口默认指向自建中转站 `https://api.888424.xyz/v1`，换站时用 `LLM_BASE_URL` 覆盖（优先级最高）；默认模型池并发 10。
- 本机 Wrangler 可使用 Cloudflare Global API Key + 邮箱环境变量 `CLOUDFLARE_API_KEY`、`CLOUDFLARE_EMAIL`；已验证可读取账户和 Pages 项目。不要把 Global API Key 提交到仓库。
- GitHub 的 Deploy workflow 当前使用更适合 CI 的 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID` Secrets；这与本机 Global API Key + Email 是两套认证方式。
- Worker 使用 Wrangler Secret 配置 `TENCENT_DOCS_TOKEN`；每日同步中的同名 GitHub Secret 是可选的。
- `sources/`、依赖目录和构建缓存均不应提交。

## 历史决策摘要

1. **只分发语言文件**：避免重分发光影本体；本项目只提供独立 `zh_CN.lang`。
2. **使用 VitePress 静态站**：数据以 JSON 进入仓库，详情页在构建期生成，部署到 Cloudflare Pages。
3. **GitHub 主渠道 + 夸克镜像**：GitHub 用于版本化和主下载，夸克用于国内访问备用。
4. **全量目录**：从 Modrinth 拉取已发布的 shader 项目，不再使用下载量门槛；自带中文项目仍展示在目录中。
5. **自动翻译直接发布**：AI 初翻经自动校验闸门通过后直接提供下载，文件头醒目标注“未人工校对”；不再有人工确认环节，玩家反馈触发重译。
6. **双仓方案已废弃**：早期曾计划将数据和公开站点分仓，2026-09-11 已合并为单仓；当前不再按双仓方案维护。
7. **翻译提供方分层：免费层优先、自建网关回退**（**已实现**，2026-10-17）。主路为 bilibili 官方免费公网 API（`https://index-translate.bilibili.com/v1`，`Index-Translate-35B-A3B`，无需 key），自建网关降为回退池。它**不替代**回退池：免费层是无 SLA 的公开服务，可能随时变化或下线。免费层用独立环境变量，**不参与 `LLM_MODELS` 与站点管理员勾选**（否则管理员一勾模型就会静默关掉免费层）。免费层失败快速降级（单次尝试、无退避、60 秒超时），不占满每条光影的 15 分钟预算。**附带决定**：没有 `LLM_API_KEY` 时不再硬失败，改为以「免费层单跑」模式运行——这有意打破了「不设任何 `LLM_*` 环境变量时行为逐字一致」的原不变量，用户已明确同意。
8. **不再新增 ADR 目录**：`docs/adr/` 已于 2026-10-09 随文档合并删除（提交 `1540269`），本项目正式说明文档就是本 README；后续决策追加到本节，不重新拆目录。
9. **免费层改用逐句模型 + 元数据端点不可信**（**已实现**，2026-10-20）。第 7 条的前提已部分失效：主模型 `Index-Translate-35B-A3B` **持续 504**（服务端推理卡死；`/health` 仍报 `true`，`/v1/models` 也照常列出它——**两个元数据端点都不反映推理是否可用**）。同服务上只剩 `index-mt-9b-syllable` / `index-mt-2b-syllable` 可用，它们是**逐句模型**：给 N 行只回 1 行，且回哪一行不可控（9 行输入回第 8 行）。因此：
    - 流水线按**模型名**（`*-syllable`）自动切到逐句路径（`scripts/lib/line-translator.mjs`），一行一个请求；35B 恢复后改回模型名即可回到整块模式，无需改代码。
    - 逐句请求**只发 value、key 在本地拼回**：实测整行发过去时 15.5% 的行会原样回显英文，只发 value 降到 6.5%，且 § 与占位符零漂移。剩余回显按行回退（与整块路径同语义）。
    - 并发默认 16（`FREE_TIER_CONCURRENCY` 可调）。本机实测拐点：16 → 36 行/秒，32 → 58 行/秒，48/64 吞吐反而下降；CI 出口未验证，故取一半。
    - **实测效果**：250 行光影由免费层一次跑完，回退 0/250，耗时 4.9 秒（网关同工作量约 9 分钟）。
    - 同时补上官方 `call_api.py` 的硬性前提 `chat_template_kwargs.enable_thinking=false` 与 `max_tokens=1024`（原先漏了，CoT 会顶掉译文）。
10. **模型列表必须实测探测，不能读元数据**（**已实现**，2026-10-20）。站点 `/request` 的模型选择区现在同时列出网关模型与免费层模型：免费层部分由 Worker **真发一次翻译请求**判定存活（有中文才算活），而不是读 `/health` 或 `/v1/models`——第 9 条已证明这两个端点既漏报（不列 syllable）又误报（35B 报 true 实际 504）。探测全挂时不报错，只显示网关模型。免费层模型不在网关 `/models` 里，Worker 的白名单校验改为「网关与免费层任一命中即放行」。
11. **回退池默认模型整体更换**（**已实现**，2026-10-20）。旧默认 `opencode-zen-free/space-bunny-free` / `beam-free` / `big-pickle` **已全部从网关下架**（`GET /models` 只剩 16 个，全为 `kilo/*` 与 `tencent/Hunyuan-MT-7B`）。实测入选两个：`kilo/kilo-auto/free`（3.8~15.6s，5/5 键、§ 与占位符零漂移）、`kilo/poolside/laguna-s-2.1:free`（3.2~4.5s，同上）。其余 13 个 `kilo/*` 实测全部 429（每日额度耗尽），Hunyuan-MT-7B 会用 ``` 包裹输出，均不入选。**注意速度**：`kilo-auto` 首次调用可能 15s+，4 块实测约 9 分钟，接近每条光影 15 分钟上限。

## 待办事项

### 中优先级

- 将 `release.mjs` 与夸克上传流程整合；当前 release 只负责 git add/commit/push。
- 完成 Worker 端到端测试：前端表单 → Worker → 腾讯文档智能表格。
- 继续观察 `sync.yml` 的定时运行结果；主链路已在隔离目录完成实测。
- 处理尚未登记翻译、且已有可获取英文源的目录项目（当前快照：1 个）。

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
- **免费层**：翻译流水线默认优先使用的公开翻译接口（bilibili Index-Translate 免费公网 API），无需 API key，无 SLA。默认开启，用 `FREE_TIER_ENABLED=0` 关闭。
- **回退池**：免费层不可用时承接翻译的自建网关模型集合（`LLM_MODELS`）。成员是**轮班**而非优先级，且只允许「零丢键」的模型进入。

## 文档边界

- 本文件：项目架构、状态、流程、决策和待办的唯一来源。
- `site/guide/install.md`、`site/request/index.md` 等：网站面向用户的页面内容，不与本文件重复维护项目状态。
- `AGENTS.md`：本地 Agent/MCP 环境配置，不是产品说明。
- [`docs/项目结构.md`](docs/项目结构.md)：目录职责速查表（哪些是人写的源、哪些是生成的产物、哪些不能动）。
