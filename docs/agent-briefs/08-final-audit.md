# 任务 H：最终验收（只读 + 允许跑验证命令）

## 仓库

`C:\Users\Sora\Desktop\shader\shader-i18n-site`（branch `main`）。

## 背景

Range 增量下载改造已实现：新建 `shared/zip-range.mjs`，改造 `scripts/fetch-lang-sources.mjs`，新增 `tests/zip-range.test.mjs` 与 `scripts/verify-range-equivalence.mjs`。方案基准是 `docs/range-download-plan.md`。你是**最后一道独立验收**。

## 允许 / 禁止

**允许**：读文件、跑 `npm test` / `node scripts/validate-lang.mjs` / `npm run build` / `npm run verify:range`（小样本）/ `git status` / `git diff --stat`。
**禁止**：修改任何文件、`git add` / `commit` / `push`、跑全量 `fetch:lang`（会打满 Modrinth API）。

## 验收清单（逐项给出真实输出）

### 1. 回归不变量

```bash
node --test "tests/**/*.test.mjs"     # 期望：原有 30 项 + 新增 zip-range 用例，全绿
node scripts/validate-lang.mjs        # 期望：460 文件 / 123818 键 / 0 失败
npm run build                         # 期望：退出码 0
git status --short                    # 期望：只有本次新增/修改的文件，无 site/shaders/，无 sources/
```

### 2. plan 文档「端到端验收」逐条

- `npm test` 全绿
- `npm run validate:lang` 仍通过（460 文件 / 123818 键）
- `npm run build` 退出码 0
- `sources/` 保持 gitignore（不入库）
- `manifest.json` 只新增 `fetchMode` / `bytesDownloaded` 两键，既有 6 键全部保留
- `--no-range` 参数存在且能强制整包
- `npm run verify:range` 存在且可运行（**只跑小样本**，不要跑满 30）

### 3. 关键回归断言（plan 明确要求）

> 实现 Range 后的关键回归断言：**新旧 manifest 的 `hasEn` / `hasNativeZhCN` / 文件内容完全一致。**

`sources/manifest.json` 是既有产物。请对比改造前逻辑与改造后逻辑对同一批光影应产出的 `hasEn` / `hasNativeZhCN`：读改造后的 `fetch-lang-sources.mjs`，确认这两个字段的判定路径与旧的 `zipEntries()` 版本**语义一致**（尤其 `names` 是否仍含全部条目、自带中文检测的正则是否未变）。如果你发现任何可能导致这两个字段取值变化的路径，报出来。

### 4. 预算收益（plan 的预期验收数字）

plan 预期：Range 模式占比约 50%（≥64KB 样本），总下载量由 745 MB 降至约 18 MB（-97.6%）。**若实测节省低于 90%，视为未达预期。**
你**不要跑全量**，改为：读 `verify-range-equivalence.mjs` 与 `fetch-lang-sources.mjs` 的汇总打印逻辑，判断这个统计是否真能被正确算出来；如 `sources/manifest.json` 已有带 `bytesDownloaded` 的历史记录，可直接统计实际节省比例并报告。

### 5. 交接文档的「Do not」清单逐条核对

- 没有用 `git add -A` 提交 `site/shaders/`
- `wrangler.toml` binding 名仍是 `TRANSLATION_QUEUE`（不是 `KV_BINDING`）
- 没有把 `bytes=0-0` 那一步「优化」成后缀区间
- 没有把 `validate-lang.mjs` 的失败项降级成警告
- `pack-lang-sources.mjs` 仍是合并式写入
- `sources/` 没有入仓
- `pipeline.mjs` 未被修改

## 输出格式

```
## 验收结论：PASS / FAIL
## 三项回归实测输出（原文）
## 端到端清单逐条结论
## hasEn / hasNativeZhCN 一致性分析
## 带宽收益评估
## Do-not 清单核对
## 未通过项（每条 file:line + 证据 + 建议修法）
```

只有全部通过才写 PASS。任何 P0 未通过都必须写 FAIL 并说清缺什么。
