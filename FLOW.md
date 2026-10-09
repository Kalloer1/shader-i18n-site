# Shader i18n 站点全流程

> 图示按真实代码路径与命令绘制，可配合 Mermaid 渲染查看。

## 1. 数据采集（GitHub Actions，每日 UTC 21:00）

```mermaid
flowchart TD
    T["sync.yml 定时触发<br/>cron 0 21 * * * / 手动 dispatch"]
    T --> C["npm run catalog<br/>scripts/fetch-catalog.mjs"]
    T --> S["npm run sync<br/>scripts/sync-metadata.mjs"]
    T --> D["npm run detect-changes<br/>scripts/detect-changes.mjs"]

    C -->|"写入全量目录"| CJ[("site/data/modrinth-catalog.json")]
    S -->|"元数据写入 _meta.modrinth"| SJ[("site/data/shaders.json")]
    D -->|"diff 新旧快照"| DD{{"新增光影？"}}
    DD -->|"是"| DOCS[("腾讯文档智能表格<br/>登记请求记录")]
    DD -->|"否"| NOOP["结束，无登记"]

    CJ --> G{"git diff 有变更？"}
    SJ --> G
    G -->|"是"| PUSH["git add -A / commit / push<br/>chore: daily sync"]
    G -->|"否"| END1["结束"]

    style T fill:#111827,stroke:#374151,color:#f9fafb
    style DD fill:#111827,stroke:#374151,color:#f9fafb
    style G fill:#111827,stroke:#374151,color:#f9fafb
```

要点：

- `catalog` 与 `sync` 并行跑，产物落 `site/data/`。
- `sync-metadata.mjs` 只写 `_meta.modrinth`，**永不覆盖人工已翻译的字段**（这是数据安全的边界）。
- `detect-changes.mjs` 拿的是 `modrinth-catalog.json` 的新旧快照对比，不是运行时检测；新增项写腾讯文档。
- 自动流程**不含**翻译与发布，站点内容不会因为同步而悄悄变化。

## 2. 翻译（本地人工驱动）

```mermaid
flowchart TD
    CLI["npm run translate<br/>scripts/pipeline.mjs"] --> CAND["筛候选<br/>排除自带中文 / 缺 en_US.lang / 已是最新汉化"]
    CAND --> GL["glossary.json 精确命中<br/>按剥离 § 格式码后的英文骨架"]
    GL -->|"未命中"| LLM["LLM 分块翻译<br/>SiliconFlow Hunyuan-MT-7B，60 行/块"]
    LLM --> GATE{"回退率 ≤ 30%？"}
    GATE -->|"否，失败"| FAIL["不写出、不登记<br/>记为 failed，留待下次"]
    GATE -->|"是"| W["写出 site/public/lang/&lt;id&gt;/&lt;version&gt;/zh_CN.lang<br/>头部标注 AI 初翻未人工校对"]
    GL -->|"命中"| W
    W --> V["scripts/validate-lang.mjs<br/>键集合 + § 格式码数量一致"]
    V --> REG["写入 langVersions<br/>回写 shaders.json 与 glossary.json"]
    REG --> PERSIST["落盘 catalog / shaders / glossary"]

    style GATE fill:#111827,stroke:#374151,color:#f9fafb
```

要点：

- 术语表 `glossary.json` 是**精确命中**：按去掉 `§e`、`§a[+]§c[-]` 这类格式码并 lowercased 的英文骨架比对。
- 全命中时**一次 LLM 都不调**。
- 分块回退率 > 10% 会整块重试（最多 3 次），整体 > 30% 直接判失败，**不写文件**。
- 校验失败即中止该条发布，不会留半个文件在仓库里。

## 3. 发布（本地人工确认）

```mermaid
flowchart TD
    R["npm run release &lt;id&gt;<br/>scripts/release.mjs"] --> CHK["确认 lang 产物已存在<br/>才允许 git add / commit / push"]
    CHK --> PUSH[("远端仓库 push")]
    PUSH --> DEPLOY["deploy.yml 触发<br/>gen-shader-pages.mjs"]
    DEPLOY --> BUILD["vitepress build site"]
    BUILD --> PAGES["Cloudflare Pages<br/>站点更新"]

    style R fill:#111827,stroke:#374151,color:#f9fafb
```

## 4. 用户请求翻译链路（站点运行时）

```mermaid
flowchart TD
    U["站点用户"] --> REQ["site/request/index.md<br/>/request 表单"]
    REQ -->|"POST"| W["Cloudflare Worker<br/>worker/index.js"]
    W --> CORSS{"CORS 白名单放行？"}
    CORSS -->|"否"| DENY["403 拒绝"]
    CORSS -->|"是"| VF{"字段与 modrinth.com 链接合法？"}
    VF -->|"否"| REJECT["400 拒绝"]
    VF -->|"是"| DOCS[("腾讯文档智能表格<br/>登记请求记录")]

    style CORSS fill:#111827,stroke:#374151,color:#f9fafb
    style VF fill:#111827,stroke:#374151,color:#f9fafb
```

要点：这条链路**只登记需求**，不触发下载、翻译或页面生成。

## 5. 站点消费层

```mermaid
flowchart TD
    SITE["site/ VitePress 站点"] --> D1["data/modrinth-catalog.json"]
    SITE --> D2["data/shaders.json"]
    SITE --> D3["data/glossary.json"]
    D1 --> PAGE["光影详情页<br/>.vitepress/theme 生成 zh_CN.lang 下载入口"]
    D3 --> PAGE
    PAGE --> DL["用户下载 /lang/&lt;id&gt;/&lt;version&gt;/zh_CN.lang<br/>site/public 静态资源"]
```

## 一句话总览

```
每日 Actions 采数据（catalog / sync / detect）
        ↓
site/public/lang 下的 zh_CN.lang  ←—— 由人工本地跑 pipeline 产出（不自动）
        ↓
release 确认产物后才 push
        ↓
Actions 部署 → Cloudflare Pages → 用户下载 / 提交请求 → Worker → 腾讯文档
```

**已知当前卡点**（诚实说明，未修）：`candidate.json` 里 `register_db → release_cli` 这条主路径边在 render 阶段触发 `workflow/solver-budget-exhausted`，后面 43 条 composition 诊断（30 个 proper-crossing、12 个 ambiguous-corridor、1 个 arrowhead-collision）目前是被这条 rank-capacity 失败**抑制**的，`validate` 不会往下报。