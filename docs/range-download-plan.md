# Range 增量抽取 en_US.lang 方案

## 摘要

把 `scripts/fetch-lang-sources.mjs` 的整包下载改为「Range 优先 → 失败回退整包 → CRC32 强校验」，只下载 zip 的中央目录与目标条目。新模块 `shared/zip-range.mjs` 提供与现有 `zipEntries()` 同形的接口，调用点几乎零改动。

**实测收益（984 光影 / 408 有效样本）：整包 745.3 MB → 18.2 MB，节省 97.6%。**

按决定：不改 `pipeline.mjs`、不考虑 CF、不实现 zip64。

## 实测依据

| 项 | 数据 |
|---|---|
| 整包合计 | 745.3 MB |
| Range 合计（64KB 阈值） | 18.2 MB（**-97.6%**） |
| 中位 / p75 / p90 / p99 / max | 0.062 / 0.610 / 4.073 / 29.257 / 87.08 MB |
| 小文件占比 | <64KB 50%、<128KB 56%、<256KB 62%、<1MB 78% |
| 独立探针（60 / 40 样本） | 节省 94.6% / 95.2% |
| CRC32 抽取校验 | 4/4 通过（含 13.63MB allium） |

阈值模拟（尾部 64KB + 条目 8KB）：

```
 64KB: Range 用于 203/408 → 18.2MB  节省 97.6%   ← 最优
 96KB: Range 用于 188/408 → 18.3MB  节省 97.5%
256KB: Range 用于 154/408 → 21.3MB  节省 97.1%
  1MB: Range 用于  89/408 → 48.4MB  节省 93.5%
```

## 四条硬约束（实测得出，必须遵守）

1. **后缀区间不可用**：`bytes=-65536` 在 Modrinth CDN 返回 **501**，只有 CF 支持。必须用显式 `bytes=start-end`。
2. **不可预判 Range 支持**：CF 的 `accept-ranges` 为 `null` 却仍返回 206。只能直接发请求看状态码。
3. **501 是可重试的瞬时错误**：`miniature-shader`(43KB)、`vanillaa`(23KB) 重试即返回 206 且 `accept-ranges: bytes`。不得把 501 当作"该文件永久不支持 Range"。
4. **尾部窗口必须自适应放大**：1080 条目的中央目录达 104903 字节，64KB 窗口装不下，需 ×4 递增（实测 256KB 才够）。

## 设计

### 新模块 `shared/zip-range.mjs`

与现有 `zipEntries()` 同形，使调用点改动最小：

```js
export async function openZip(url, opts = {})
// opts: { totalSize, headers, minRangeBytes = 65536,
//         maxTailBytes = 8 << 20, retries = 2, forceFull = false }
// → { names: string[],                    // 中央目录全部条目名（含非 lang 文件）
//     read: async (name) => Buffer|null,  // 按需取；Range 模式下发起第二次请求
//     fetchMode: 'range' | 'full',
//     bytesDownloaded: number }
```

`read()` 统一为 **async**（整包模式下也返回 Promise），调用点由 `zip.read(enName)` 改为 `await zip.read(enName)`。

同时导出 `export function crc32(buf)` 供测试复用（仓库内目前无任何 CRC32 实现）。

### 决策流程

```
1. totalSize = file.size（Modrinth API 已给，无需 bytes=0-0 探测）
2. if totalSize < minRangeBytes  → 整包（1 次请求）
3. 取尾部窗口 win=64KB，bytes=(total-win)-(total-1)
     ├ 非 206 → 重试 retries 次 → 仍失败则整包
     └ 206 → 解析 EOCD + 中央目录
          ├ 窗口覆盖整个文件 → 复用该 buffer，不再发第二次请求
          ├ CD 起点在窗口之前 / EOCD 未找到 → win ×= 4 重试
          ├ win > maxTailBytes → 整包
          └ 检测到 zip64 EOCD locator → 整包
4. 在 CD 中定位 ^shaders/lang/en_US.lang$（大小写不敏感）
     ├ 不存在 → 正常返回 names，read() 返回 null（不是错误）
     └ 存在 → 取 {localOffset, compSize, uncompSize, method, crc}
5. 取条目区间，解析 local header，按 method 解压（0=Stored / 8=Deflate）
6. 校验：crc32(raw) === crc && raw.length === uncompSize
     ├ 通过 → 返回
     └ 不符 → 回退整包（静默）
```

### 回退策略

任何异常都**透明回退整包**，返回一个可用的 full 模式对象，调用方无需感知：

| 触发条件 | 处理 |
|---|---|
| 非 206 / 5xx / 501 | 重试 `retries` 次，仍失败 → 整包 |
| EOCD 未找到 / CD 起点越界 | 窗口 ×4 重试，超 `maxTailBytes` → 整包 |
| 检出 zip64 | 整包（不实现 zip64 解析） |
| local header magic 不符 | 整包 |
| method ∉ {0, 8} | 整包 |
| CRC32 或长度不符 | 整包 |
| 网络超时 / 抛错 | 整包 |

**核心保证：Range 路径要么产出与整包逐字节相同的内容，要么回退整包。不会静默产出错误字节。**

### 大小阈值

`minRangeBytes = 65536`。低于阈值走整包（1 次请求，避免 CD 解析开销）。

阈值选择其实是**低风险**的：由于「窗口覆盖整个文件即复用 buffer」这一优化，小文件走 Range 也不会多耗流量。阈值主要作用是简化代码路径。

### 调用点改动（`scripts/fetch-lang-sources.mjs`）

- 删除本地 `zipEntries()`（约 34 行），改 `import { openZip } from '../shared/zip-range.mjs'`
- 下载段（约第 88 行）`fetch(file.url).then(r => r.arrayBuffer())` → `await openZip(file.url, { totalSize: file.size, headers: { 'User-Agent': UA } })`
- `zip.read(enName)` → `await zip.read(enName)`
- 新增 `--no-range` 参数强制整包（用于 A/B 对比与排障）
- 保留 80ms 节流与 16 并发；并发下每个 worker 独立持有自己的 zip 对象

### manifest.json 变更（仅新增字段，向后兼容）

现有键 `{shaderVersion, file, hasEn, hasNativeZhCN, zipFile, fetchedAt}` **全部保留**，新增：

```json
{ "fetchMode": "range" | "full", "bytesDownloaded": 73728 }
```

旧 manifest 可直接复用，无需迁移。运行结束额外打印：`Range N 个 / 整包 M 个，共下载 X MB（若全整包需 Y MB，节省 Z%）`。

## 行为与接口变更

- **新增** `shared/zip-range.mjs`：`openZip()`、`crc32()`
- **变更** `fetch-lang-sources.mjs`：`zip.read()` 变为 async；新增 `--no-range`；产出 manifest 多两个字段
- **新增** `npm run verify:range`
- **不变**：`pipeline.mjs`、`wrangler.toml`、CI 工作流、`sources/` 目录结构与 `manifest.json` 既有键

## 测试与验收

### 离线单元测试 `tests/zip-range.test.mjs`（进 CI，无网络）

用 `node:zlib` 在内存构造合成 zip 夹具：

1. **Stored 与 Deflate 两种 method** 均能正确抽取
2. **CRC32 已知向量**：`crc32(Buffer.from("123456789")) === 0xCBF43926`
3. **CRC 不匹配时回退整包**：构造 CRC 字段被篡改的夹具，断言 `fetchMode === 'full'` 且内容正确
4. **zip64 locator 检出即回退**
5. **中央目录大于初始窗口**时窗口正确放大
6. **窗口覆盖整个文件**时不发第二次请求（断言请求计数）
7. **目标条目不存在**时 `read()` 返回 `null`，且 `names` 仍完整
8. **非 206 响应**（stub 返回 200/501/500）触发重试后回退整包
9. **`minRangeBytes` 阈值**：小于阈值不发 Range 请求

用 stub `fetch` 注入响应，全部离线可跑，纳入 `npm test`。

### 联网等价性验证 `npm run verify:range`（抽样逐字节对比）

新增 `scripts/verify-range-equivalence.mjs`：

1. 从 catalog 抽样 N=30 个光影（覆盖大/中/小：含 `allium-shaders` 13.63MB、`complementary-reimagined`、`miniature-shader` 等）
2. 对同一 URL 分别用 Range 与整包各抽一次 `en_US.lang`
3. **逐字节 `Buffer.equals()` 断言相同**，并校验 CRC32 与长度
4. 输出汇总表；任一不等即退出码 1

### 端到端验收

- `npm run fetch:lang -- --threads 16` 全量跑完，对比新旧 manifest：`hasEn` / `hasNativeZhCN` / 文件内容**完全一致**
- 运行结束后 `git status` 中 `sources/` 保持 gitignore（不入库）
- `npm test` 全绿（现有 30 项 + 新增 zip-range 用例）
- `npm run validate:lang` 仍通过（460 文件 / 123818 键）
- `npm run build` 退出码 0

### 预期验收数字

Range 模式占比约 **50%**（≥64KB 的样本），总下载量由 745 MB 降至约 **18 MB**（-97.6%）。若实测节省低于 90%，视为未达预期并需排查。

## 假设与默认值

- **已应用**（上一轮完成）：`wrangler.toml` 的 KV id 已填 `d89b68831b5f463c9f4e46a9f937f07a`，binding 名保留代码期望的 `TRANSLATION_QUEUE`（非控制台默认的 `KV_BINDING`）
- **阈值 65536 字节**：基于 408 样本分布，97.6% 为最优；因小文件复用 buffer，该选择低风险
- **尾部窗口** 64KB 起、×4 递增、上限 8MB
- **重试** 2 次（指数退避 1s/2s），仍失败即回退整包
- **CRC32 用自实现查表版**（无新依赖，Node 内置无 crc32）
- **仅 Modrinth**：CF 与 zip64 均走整包回退；CF 的 Range 实测可用但不纳入本次
- **`pipeline.mjs` 的重复 `zipEntries` 暂不合并**，两份实现暂时共存
- 用户 scratch 脚本 `C:/Users/Sora/Desktop/shader/_scratch_rangetest.mjs` 保留不动

## 不在本次范围

- 改造 `pipeline.mjs` 的整包下载（`pipeline.mjs:382`）——未来可复用同一模块
- CurseForge 整合包（数百 MB）抓取
- zip64 解析
- 合并 `pipeline.mjs` 与 `fetch-lang-sources.mjs` 的重复 zip 实现
