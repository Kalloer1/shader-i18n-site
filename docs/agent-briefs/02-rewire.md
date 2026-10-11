# 任务 B：改造 `scripts/fetch-lang-sources.mjs` 接入 `shared/zip-range.mjs`

## 仓库

`C:\Users\Sora\Desktop\shader\shader-i18n-site`（branch `main`，HEAD `4d731d5`）。

## 前提

`shared/zip-range.mjs` **已由另一个子代理实现完成**，导出 `crc32(buf)` 与 `openZip(url, opts)`。
**先读它确认真实签名再动手**，不要凭记忆。

## 你要做什么

只改 `scripts/fetch-lang-sources.mjs`（外加 `package.json` 加一个 script）。**不要动 `pipeline.mjs`，不要动 `shared/zip-range.mjs`，不要动 `wrangler.toml`，不要动 CI 工作流。**

## 具体改动（照 `docs/range-download-plan.md` 的「调用点改动」小节）

1. 删除本地 `zipEntries()`（约 34 行），改 `import { openZip } from '../shared/zip-range.mjs'`
2. 下载段（约第 88 行）：
   `fetch(file.url).then(r => r.arrayBuffer())` → `await openZip(file.url, { totalSize: file.size, headers: { 'User-Agent': UA } })`
   注意 `file.size` 来自 Modrinth API 的 file 对象；`forceFull` 由 `--no-range` 控制。
3. `zip.read(enName)` → `await zip.read(enName)`（接口已变 async）
4. 新增 `--no-range` 命令行参数，强制整包（用于 A/B 对比与排障）
5. `manifest.json` **只新增两个字段**，既有键 `{shaderVersion, file, hasEn, hasNativeZhCN, zipFile, fetchedAt}` 全部保留：
   `fetchMode: 'range' | 'full'`、`bytesDownloaded: <number>`
6. 运行结束额外打印汇总，形如：
   `Range N 个 / 整包 M 个，共下载 X MB（若全整包需 Y MB，节省 Z%）`

## 必须保持的行为

- 80ms 节流与 16 并发（`--threads` 仍生效）；并发下每个 worker 独立持有自己的 zip 对象
- 中途每 25 个增量写 manifest（被停不丢进度）
- 失败项只 `failed++` 并打印，不影响其他光影
- `sources/<id>/<version>/en_US.lang` 输出路径不变
- 自带中文检测逻辑（`^shaders/lang/zh_CN\.lang$`）不变

## 其他要求

- 中文注释，风格对齐现有脚本
- 不要引入新依赖

## 自检（必须做，报告里贴结果）

```bash
cd C:\Users\Sora\Desktop\shader\shader-i18n-site
node --check scripts/fetch-lang-sources.mjs
node scripts/fetch-lang-sources.mjs --help 2>&1 | head -5   # 或类似的最小验证，不要真跑全量
```

**不要跑全量 `fetch:lang`**（16 并发 + 984 个光影，会打满 Modrinth API）。只做语法与最小冒烟验证。
如果必须联网验证，最多挑 **2 个** 已知光影手动验证后立刻停。

## 报告格式

返回：修改的文件、`manifest.json` 新旧键差异、冒烟验证结果、任何偏离 plan 的地方及原因。
