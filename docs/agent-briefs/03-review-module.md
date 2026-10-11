# 任务 C：审查 `shared/zip-range.mjs`（只读，禁止改代码）

## 仓库

`C:\Users\Sora\Desktop\shader\shader-i18n-site`（branch `main`）。

## 你的身份

你是**新上下文、只读**的审查者。你**没有任何写权限**——不要尝试编辑、创建、删除文件，不要跑会修改仓库的命令。发现问题的唯一方式是报告。

## 审查对象

`shared/zip-range.mjs`（新建）+ `docs/range-download-plan.md`（定稿方案，作为验收基准）。

## 审查基准（逐条核对，给出 `file:line` 证据）

### 一、四条硬约束（任何一条违反都是 P0）

1. **禁止后缀区间** `bytes=-N`。搜代码确认只有显式 `bytes=start-end`。Modrinth CDN 对后缀区间返回 501。
2. **不可预判 Range 支持**。确认没有用 `Accept-Ranges` 响应头来决定走 Range 还是整包。CF 该头为 `null` 却仍返回 206，预判会导致不必要的整包。
3. **501 / 5xx 必须可重试**（`retries` 次，退避 1s/2s），仍失败才回退整包。确认没有把 501 直接当成「永久不支持 Range」。
4. **尾部窗口自适应放大**：64KB 起步、×4 递增、上限 `maxTailBytes`。确认大中央目录（1080 条目 / 104903 字节）场景能覆盖。

### 二、接口契约

- `crc32(Buffer.from("123456789"))` 是否精确等于 `0xCBF43926`（真跑一次）
- `openZip(url, opts)` 的 opts 默认值是否与 plan 一致：`minRangeBytes = 65536`、`maxTailBytes = 8 << 20`、`retries = 2`、`forceFull = false`
- 返回值是否含 `{ names, read, fetchMode, bytesDownloaded }`，且 `read` 是 async
- `read()` 对不存在的条目返回 `null` 而不是抛错
- `names` 是否包含中央目录**全部**条目名

### 三、回退矩阵（plan 表格逐行核对）

非 206 / 5xx / 501、EOCD 未找到 / CD 起点越界、检出 zip64、local header magic 不符、`method ∉ {0,8}`、CRC32 或长度不符、网络超时 / 抛错 —— 每一条是否都**透明回退整包**并返回可用的 full 对象。

**核心保证：Range 路径要么产出与整包逐字节相同的内容，要么回退整包。任何能静默产出错误字节的路径都是 P0。**

### 四、正确性细节

- EOCD 定位：向后扫描 22 字节，注释长度上限处理是否正确（`65535 + 22`）
- EOCD 各字段偏移是否读对（count@+10、cdSize@+12、cdOffset@+16、commentLen@+20）
- zip64 EOCD locator 检测（signature `0x07064b50`）是否正确，以及 locator 出现在 EOCD 前 20 字节的位置判断
- 中央目录条目头 signature `0x02014b50`、字段偏移（method@+10、compSize@+20、nameLen@+28、extraLen@+30、commentLen@+32、localOffset@+42、name@+46）
- local header signature `0x04034b50`、nameLen@+26、extraLen@+28、数据起点 +30
- **local header 的 extraLen 可能与中央目录不同**（zip 允许），是否用 local 的 extraLen 而不是 CD 的
- `compSize` 为 `0xFFFFFFFF`（zip64 占位）时是否被 zip64 检测拦下，而不是当成 4GB 读
- 窗口覆盖整个文件时是否真的复用 buffer 且**不再发第二次请求**
- `bytesDownloaded` 累计是否真实（不含重试丢失的字节可接受，但不得虚报为 0）

### 五、Node 边界

- `Buffer.readUInt32LE` 越界会抛，不是返回 NaN —— 所有偏移读取前是否做了边界检查
- `inflateRawSync` 对损坏数据抛错是否被 try/catch 兜住并回退
- 是否存在未 await 的 Promise、未捕获的 rejection

## 输出格式

```
## P0（必须修，破坏正确性或硬约束）
- file:line — 问题 — 证据 — 建议修法

## P1（应该修）
...

## P2（可选）
...

## 已核对通过项
- （逐条列出四条硬约束、回退矩阵、接口契约的核对结论）

Merge verdict: BLOCK / OK / OK with notes
```

只报**当前代码里真实存在**的问题。每条都要有 `file:line` 与证据。没找到问题就明确说没找到，不要编造。
