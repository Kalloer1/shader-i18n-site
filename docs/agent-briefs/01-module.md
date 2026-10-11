# 任务 A：实现 `shared/zip-range.mjs`

## 仓库

`C:\Users\Sora\Desktop\shader\shader-i18n-site`（branch `main`，HEAD `4d731d5`，工作树干净）。

## 你要做什么

**只新建一个文件：`shared/zip-range.mjs`。不要修改任何其他文件。**
不要 `git add -A`，不要提交 `site/shaders/`（生成物，已 gitignore）。

## 必读（先读再动手）

1. `docs/range-download-plan.md` —— 方案已定稿，设计、四条硬约束、回退矩阵、阈值、测试清单全部在里面。**逐条实现，不要自行发挥。**
2. `scripts/fetch-lang-sources.mjs` 的 `zipEntries()`（约 34 行）—— 你要提供同形接口替换它。
3. `C:/Users/Sora/Desktop/shader/_scratch_rangetest.mjs` —— 可参考的 Range 抽取函数（仓库外，只读不改）。

## 接口（与 plan 文档一致，不可更改）

```js
export function crc32(buf)              // 自实现查表版，crc32(Buffer.from("123456789")) === 0xCBF43926
export async function openZip(url, opts = {})
// opts: { totalSize, headers, minRangeBytes = 65536, maxTailBytes = 8 << 20, retries = 2, forceFull = false }
// → { names: string[], read: async (name) => Buffer|null, fetchMode: 'range' | 'full', bytesDownloaded: number }
```

`read()` 必须是 async（整包模式也返回 Promise）。Node 内置无 crc32，自实现，**不引入任何新依赖**。

## 四条硬约束（实测得出，违反即算失败）

1. **必须用显式 `bytes=start-end`**，禁止 `bytes=-65536` 后缀区间（Modrinth CDN 返回 501）。
2. **不可预判 Range 支持**：不得读 `Accept-Ranges` 头来决定走哪条路（CF 该头为 `null` 却仍返回 206）。只能发请求看状态码。
3. **501 / 5xx 视为可重试的瞬时错误**，重试 `retries` 次（指数退避 1s/2s），仍失败才回退整包。不得把 501 当作「该文件永久不支持 Range」。
4. **尾部窗口必须自适应放大**：64KB 起步，×4 递增，上限 `maxTailBytes`（8MB）。1080 条目的中央目录达 104903 字节，64KB 装不下。

## 决策流程（照抄 plan 文档）

```
1. totalSize = opts.totalSize（调用方从 Modrinth API 的 file.size 拿，不要用 bytes=0-0 探测）
2. if totalSize < minRangeBytes → 整包（1 次请求）
3. 取尾部窗口 win=64KB，bytes=(total-win)-(total-1)
     ├ 非 206 → 重试 retries 次 → 仍失败则整包
     └ 206 → 解析 EOCD + 中央目录
          ├ 窗口覆盖整个文件 → 复用该 buffer，不再发第二次请求
          ├ CD 起点在窗口之前 / EOCD 未找到 → win ×= 4 重试
          ├ win > maxTailBytes → 整包
          └ 检测到 zip64 EOCD locator → 整包
4. 在 CD 中定位目标条目名（大小写不敏感匹配）
     ├ 不存在 → 正常返回 names，read() 返回 null（不是错误）
     └ 存在 → 取 {localOffset, compSize, uncompSize, method, crc}
5. 取条目区间，解析 local header，按 method 解压（0=Stored / 8=Deflate，其余回退整包）
6. 校验：crc32(raw) === crc && raw.length === uncompSize
     ├ 通过 → 返回
     └ 不符 → 回退整包（静默）
```

## 回退策略

任何异常都**透明回退整包**，返回一个可用的 `fetchMode: 'full'` 对象，调用方无需感知。触发条件（全部照 plan 表格）：非 206 / 5xx / 501、EOCD 未找到 / CD 起点越界、检出 zip64、local header magic 不符、method ∉ {0,8}、CRC32 或长度不符、网络超时 / 抛错。

**核心保证：Range 路径要么产出与整包逐字节相同的内容，要么回退整包。绝不静默产出错误字节。**

## 其他要求

- `bytesDownloaded` 要真实累计（Range 模式：各次请求实际拿到的字节数；整包模式：整包大小）。
- `names` 必须包含中央目录**全部**条目名（含非 lang 文件），因为调用方靠它做 `^shaders/lang/[^/]+$` 过滤与自带中文检测。
- 文件用中文注释，风格对齐仓库现有脚本（看 `fetch-lang-sources.mjs` 与 `shared/tencent-docs.mjs`）。
- ESM（`package.json` 是 `"type": "module"`），只准用 `node:zlib` / `node:fs` / `node:path` / 全局 `fetch`。

## 自检（必须做，并在报告里贴结果）

```bash
cd C:\Users\Sora\Desktop\shader\shader-i18n-site
node -e "import('./shared/zip-range.mjs').then(m=>console.log('crc32 ok:', m.crc32(Buffer.from('123456789')).toString(16)))"
```
期望 `crc32 ok: cbf43926`。

再写一个临时脚本（放 `/tmp` 或仓库外，**不要提交**）用 `node:zlib` 构造合成 zip，验证 Stored 与 Deflate 都能抽对、CRC 不符能回退、目标条目不存在返回 null。确认后删掉临时脚本。

## 报告格式

返回：创建/修改的文件路径、`crc32` 向量自检输出、临时验证脚本的结论、任何你**未能**按 plan 实现的点及原因。不要粘贴大段源码。
