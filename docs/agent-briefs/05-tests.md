# 任务 E：编写离线单元测试 + 联网等价性验证脚本

## 仓库

`C:\Users\Sora\Desktop\shader\shader-i18n-site`（branch `main`）。

## 前提

`shared/zip-range.mjs`（导出 `crc32` / `openZip`）与改造后的 `scripts/fetch-lang-sources.mjs` **均已完成**。
**先读这两个文件确认真实签名与行为，再写测试。**

## 你要创建的文件

### 1. `tests/zip-range.test.mjs`（进 CI，**完全离线**）

用 `node:zlib` 在内存构造合成 zip 夹具，用 stub `fetch` 注入响应。**不得发起任何真实网络请求。**

覆盖 plan 文档「测试与验收」列出的全部 9 条：

1. Stored 与 Deflate 两种 method 均能正确抽取
2. CRC32 已知向量：`crc32(Buffer.from("123456789")) === 0xCBF43926`
3. CRC 不匹配时回退整包：构造 CRC 字段被篡改的夹具，断言 `fetchMode === 'full'` 且内容正确
4. zip64 locator 检出即回退
5. 中央目录大于初始窗口时窗口正确放大
6. 窗口覆盖整个文件时不发第二次请求（断言请求计数）
7. 目标条目不存在时 `read()` 返回 `null`，且 `names` 仍完整
8. 非 206 响应（stub 返回 200 / 501 / 500）触发重试后回退整包
9. `minRangeBytes` 阈值：小于阈值不发 Range 请求

要求：
- 用 `node:test` 的 `describe` / `it`，风格对齐现有 `tests/validate-lang.test.mjs`（先读它）
- stub `fetch` 用 `mock.method(globalThis, 'fetch', ...)` 或在测试内替换后还原，**确保不泄漏到其他测试文件**
- 夹具构造抽成 helper，避免 9 个用例重复 100 行

### 2. `scripts/verify-range-equivalence.mjs` + `package.json` 的 `verify:range`

```json
"verify:range": "node scripts/verify-range-equivalence.mjs"
```

脚本行为（照 plan 文档）：
1. 从 catalog 抽样 N=30 个光影（覆盖大/中/小；已知 `allium-shaders` 13.63MB、`complementary-reimagined`、`miniature-shader` 等）
2. 对同一 URL 分别用 Range 与整包各抽一次 `en_US.lang`
3. **逐字节 `Buffer.equals()` 断言相同**，并校验 CRC32 与长度
4. 输出汇总表；任一不等即退出码 1

## 自检（必须做，报告贴结果）

```bash
cd C:\Users\Sora\Desktop\shader\shader-i18n-site
npm test                  # 期望全绿：原有 30 项 + 新增 zip-range 用例
node --check scripts/verify-range-equivalence.mjs
```

`npm test` 必须 30+ 全绿。**如果新增测试有失败，修到全绿为止，不许 `--test-skip` 或注释掉。**

`verify:range` 联网部分**先只跑 2–3 个样本**验证脚本能跑通（不要跑满 30，省时间也少打 API），确认逻辑正确后再决定是否全量。

## 报告格式

返回：新增/修改的文件、`npm test` 的完整通过计数、`verify:range` 小样本实测输出、覆盖的 9 条用例清单、任何未覆盖项及原因。
