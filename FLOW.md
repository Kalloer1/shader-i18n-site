# Shader i18n 站点全流程

> 图示按真实代码路径与命令绘制，可配合 Mermaid 渲染查看。

## 1. 数据采集（GitHub Actions，每日 UTC 21:00）

```mermaid
flowchart TD
    T["sync.yml 定时触发<br/>cron 0 21 * * * / 手动 dispatch"] --> C["npm run catalog<br/>scripts/fetch-catalog.mjs"]
    T --> S["npm run sync<br/>scripts/sync-metadata.mjs"]
    T --> D["npm run detect-changes<br/>scripts/detect-changes.mjs"]

    C -->|"写入全量目录"| CJ[("site/data/modrinth-catalog.json")]
    S -->|"元数据写入 _meta.modrinth"| SJ[("site/data/shaders.json")]
    D -->|"diff 新旧快照"| DD{{"新增光影？"}}
    DD -->|"是"| DOCS[("腾讯文档智能表格<br/>登记请求记录")]
    DD -->|"否"| NOOP["结束，无登记"]

    CJ --> G{"git diff 有变更？"}
    SJ --> G
    G -->|"是"| PUSH["显式路径 git add / commit / push<br/>chore: daily sync"]
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
- `sync.yml` 与 `translate.yml` 共用 `concurrency: repo-write` 组，避免两个工作流同时 push 冲突。
- 字段结构（状态枚举、`buildFieldValues`）由 `shared/tencent-docs.mjs` 统一提供，Worker 与 Node 脚本共用同一份。

## 2. 翻译（站点触发或本地手动）

```mermaid
flowchart TD
    SITE["/request 翻译工作台<br/>口令 + 开启翻译"] -->|"POST /translate"| WK["Cloudflare Worker"]
    WK -->|"口令错误"| UNAUTH["401 拒绝"]
    WK -->|"口令正确"| DISPATCH["GitHub API workflow_dispatch<br/>inputs.ids"]
    DISPATCH --> TY["translate.yml<br/>npm test + validate:lang 闸门"]
    TY --> CLI["scripts/pipeline.mjs --ids a,b,c"]

    CLI --> CAND["筛候选<br/>排除自带中文 / 缺 en_US.lang / 已是最新汉化"]
    CAND --> GL["glossary.json 精确命中<br/>按剥离 § 格式码后的英文骨架"]
    GL -->|"未命中"| LLM["LLM 分块翻译<br/>SiliconFlow Hunyuan-MT-7B，60 行/块"]
    LLM --> GATE{"回退率 ≤ 30%？"}
    GATE -->|"否，失败"| FAIL["不写出、不登记<br/>记 failed 并回写 KV"]
    GATE -->|"是"| W["写出 site/public/lang/&lt;id&gt;/&lt;version&gt;/zh_CN.lang<br/>头部标注 AI 初翻未人工校对"]
    GL -->|"命中"| W
    W --> V["scripts/validate-lang.mjs<br/>键集合 + § 格式码 + 占位符种类与数量 + 无 BOM"]
    V -->|"不通过"| FAIL
    V -->|"通过"| REG["写入 langVersions<br/>回写 shaders.json 与 glossary.json"]

    CLI -.->|"每条独立 5 分钟超时<br/>超时只影响该条"| REG
    REG --> ST["POST /status 回写 KV 状态"]

    style GATE fill:#111827,stroke:#374151,color:#f9fafb
    style V fill:#111827,stroke:#374151,color:#f9fafb
```

要点：

- 术语表 `glossary.json` 是**精确命中**：按去掉 `§e`、`§a[+]§c[-]` 这类格式码并 lowercased 的英文骨架比对。
- 全命中时**一次 LLM 都不调**。
- 分块回退率 > 10% 会整块重试（最多 3 次），整体 > 30% 直接判失败，**不写文件**。
- 校验失败即中止该条发布，不会留半个文件在仓库里；这是**唯一的质量闸门**，不再有人工确认环节。
- 闸门分线（`scripts/validate-lang.mjs`）：
  - **失败**（会真的渲染错）：缺键/多键、译文引入的**畸形 § 序列**（§ 后不是 `0-9a-fk-orx`）、非 `%%` 占位符差异、BOM、翻译新增的重复键、**找不到英文源**。
  - **警告**（只是样式选择）：§ 格式码数量差异、`%%` 差异、上游 EN 自带的乱码、继承自上游的重复键、值与英文相同。
- 英文源解析顺序：同目录 `en_US.lang` → `sources/<id>/<version>/en_US.lang` → `data/lang-sources.json.gz`。
  `sources/` 未入库（16 MB，版权属原作者），故 CI 靠 `data/lang-sources.json.gz`（约 2 MB）做真实比对；
  三处都找不到直接**判失败**，绝不退回「自检」产生假绿灯。
- `\u00a7` 字面转义会先解码为 `§` 再比对（部分光影把 § 写成转义序列，不解码会产生假失败）。
- 畸形 § 序列可自动修复：`npm run fix:lang`（`--dry-run` 只报告）；只修「译文多出来」的畸形，上游自带的乱码保留。
- 新增/更新英文源后需重跑 `npm run pack:lang` 刷新压缩包（与已有包合并，不会抹掉历史条目）。
- 每条光影独立 5 分钟超时（`AbortController` 同时中断进行中的 `fetch`），超时只让该条记失败，**其余条目继续完成**。
- `--ids` 与 `--top` 互斥；`--top` 行为与改造前完全一致（旧用法回归安全）。

## 3. 镜像、发布与部署（全自动）

```mermaid
flowchart TD
    TY["translate.yml 翻译结束"] --> MIR["scripts/mirror.mjs --ids ...<br/>continue-on-error"]
    MIR --> Q{"夸克可用？"}
    Q -->|"是"| QU["create-folder 幂等取目录<br/>upload → share（永久公开）"]
    Q -->|"否"| SKIPQ["跳过，quark 留空"]
    MIR --> B{"百度网盘可用？"}
    B -->|"是"| BD["upload → share --period 0"]
    B -->|"否"| SKIPB["跳过，baidu 留空"]
    QU --> WRITE[("写回 shaders.json<br/>顶层 + langVersions 双写")]
    BD --> WRITE
    SKIPQ --> WRITE
    SKIPB --> WRITE
    WRITE --> ST2["POST /status 回写<br/>已完成 / 已完成待镜像"]

    ST2 --> PACK["npm run pack:lang<br/>合并式重打包英文源"]
    PACK --> COMMIT["显式路径 git add<br/>site/public/lang, site/data/*,<br/>data/lang-sources.json.gz"]
    COMMIT --> PUSH[("git commit + push main")]
    PUSH --> DEPLOY["deploy.yml 触发"]
    DEPLOY --> GATE2["npm test + npm run validate:lang"]
    GATE2 --> BUILD["npm run build<br/>gen-shader-pages.mjs → vitepress build"]
    BUILD --> WORKER["wrangler deploy（Worker）"]
    WORKER --> PAGES["wrangler pages deploy<br/>Cloudflare Pages"]
```

要点：

- 镜像失败**不阻断发布**：任一网盘失败只让该字段留空，站点因此不渲染对应按钮（`quark` 为空 = 无「国内镜像」按钮）。
- 发布前先 `npm run pack:lang`：pipeline 已把本次新翻译的 `en_US.lang` 写入 `sources/`，重打包后 `data/lang-sources.json.gz` 才会包含它们；否则新光影在下一次 CI 校验时找不到英文源而**假失败**。打包是**合并式**的（CI 里 `sources/` 只有新增项，直接覆盖会抹掉已发布的 472 条）。
- 绝不伪造链接：拿不到真实 `share_url` / `link` 就写空字符串。
- 两个网盘互相独立，逐条串行 + 每条之间 `sleep(500)` 限流。
- 两个工作流都用**显式路径** `git add`，禁止 `git add -A`。
- `deploy.yml` 的顺序是「测试 → 校验 → 构建 → Worker → Pages」；Worker 必须先于 Pages 部署，否则线上 API 仍是旧版本。

## 4. 用户请求与队列（站点运行时）

```mermaid
flowchart TD
    U["站点用户"] --> REQ["site/request/index.md<br/>提交表单"]
    REQ -->|"POST /"| W["Cloudflare Worker"]
    W --> CORSS{"CORS 白名单放行？"}
    CORSS -->|"否"| DENY["403 拒绝"]
    CORSS -->|"是"| VF{"字段与 modrinth.com 链接合法？"}
    VF -->|"否"| REJECT["400 拒绝"]
    VF -->|"是"| MR["Modrinth API 解析 slug<br/>不存在 / 非 shader 当场 400"]
    MR --> KV[("KV: queue:index + queue:&lt;id&gt;<br/>权威状态源")]
    KV --> DOCS[("腾讯文档智能表格<br/>尽力镜像，失败不阻断")]

    QP["/request 工作台<br/>GET /queue 轮询 ~15s"] --> KV
```

要点：

- 状态权威源是 **KV**；腾讯文档只作「尽力而为」的镜像，任何失败都只记日志。
- 同一光影重复提交只更新时间（`updatedAt`），不重复入队。
- 状态枚举：`待翻译` → `翻译中` → `已完成` / `已完成待镜像` / `失败`。
- `/translate` 触发成功后立即把条目置为 `翻译中`，避免重复点击导致重复触发。

## 5. 站点消费层

```mermaid
flowchart TD
    SITE["site/ VitePress 站点"] --> D1["data/modrinth-catalog.json"]
    SITE --> D2["data/shaders.json"]
    SITE --> D3["data/glossary.json"]
    D1 --> PAGE["光影详情页<br/>.vitepress/theme 生成 zh_CN.lang 下载入口"]
    D3 --> PAGE
    PAGE --> DL["用户下载 /lang/&lt;id&gt;/&lt;version&gt;/zh_CN.lang<br/>site/public 静态资源"]
    PAGE --> MIRROR["国内镜像按钮<br/>仅当 quark 非空时渲染"]
```

## 一句话总览

```
每日 Actions 采数据（catalog / sync / detect）
        ↓
/request 提交 → Worker 写 KV 队列 → 点「开启翻译」→ translate.yml
        ↓
site/public/lang 下的 zh_CN.lang（pipeline 产出 + validate-lang 闸门）
        ↓
mirror.mjs 上传网盘并写回分享链接
        ↓
自动 commit + push → deploy.yml → Worker + Cloudflare Pages → 用户下载
```
