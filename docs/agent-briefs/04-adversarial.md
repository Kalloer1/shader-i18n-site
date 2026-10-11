# 任务 D：对抗性审查 `shared/zip-range.mjs`（只读，禁止改代码）

## 仓库

`C:\Users\Sora\Desktop\shader\shader-i18n-site`（branch `main`）。

## 你的身份

你是**新上下文、只读**的对抗性审查者。**不要编辑任何文件。** 你的任务不是找风格问题，而是**构造一个能让该模块静默产出错误字节的输入**。

## 核心不变量（你要攻击的就是这一条）

> Range 路径要么产出与整包逐字节相同的内容，要么回退整包。不会静默产出错误字节。

## 攻击面（逐一想办法打穿）

1. **构造畸形 / 边缘 zip**：写临时脚本（放 `/tmp` 或仓库外，**不要提交、不要留在仓库里**），用 `node:zlib` 手工拼字节，构造：
   - EOCD 出现在文件中间（前面有其他匹配 `0x06054b50` 的字节）→ 是否定位到正确的 EOCD
   - EOCD 带满 65535 字节注释
   - 中央目录声称 count 远大于实际条目 → 是否越界读
   - CD offset 指向窗口之外、指向文件头、指向负数
   - local header 的 extraLen 与 CD 的 extraLen **不一致**（合法 zip 允许）→ 是否用错偏移
   - local header 前有 gap（数据描述符场景，flag bit 3 置位）
   - `compSize` 是 `0xFFFFFFFF` 的 zip64 占位
   - 假的 zip64 EOCD locator（signature 存在但字段是垃圾）
   - 条目名超长 / 含非 UTF8 字节
   - method = 12（BZIP2）/ 14（LZMA）等未实现值
   - Stored 条目但 `compSize != uncompSize`
2. **构造恶意 HTTP 行为**：stub `fetch`，返回：
   - 200（完整文件，非 206）—— 应按整包处理
   - 206 但 body 比 Range 请求的短 / 长
   - 206 但 Content-Range 头与实际不符（**是否校验了 Content-Range？** 如果只信 body 长度，就可能拿到错位字节）
   - 501、500、429、网络抛错、超时
   - 空 body
3. **边界数值**：`totalSize = 0`、`totalSize = minRangeBytes - 1`、`totalSize` 远小于 64KB、`minRangeBytes = 0`、`retries = 0`、`maxTailBytes` 极小。
4. **并发与状态**：`openZip` 返回的 `read()` 被并发调用多次是否安全；`bytesDownloaded` 是否在回退后被正确累加。

## 特别检查点（最容易出事的地方）

- **Content-Range 是否被校验**。如果模块对 206 响应只检查 `res.ok` 与 body 长度，那么一个返回错位区间的 CDN 就会让模块读到错误字节且 CRC 恰好也可能被自洽数据骗过（取决于它拿 crc 的来源）。**确认 crc 与 uncompSize 是否来自它自己下载的中央目录**——如果 CD 本身被截断/损坏，CD 里的 crc 也是错的，那么「crc32(raw) === crc」这个自校验就可能变成「用坏数据校验坏数据」。这是本任务最重要的检查点。
- 窗口放大循环是否有终止条件（不会死循环 / 无限递归）。
- 回退整包时是否**重新发了一次完整请求**（可接受），还是复用了已经损坏的部分 buffer（不可接受）。

## 输出格式

```
## 成功构造的反例（每个都要给出：构造方法 + 该输入下模块的实际行为 + 为什么违反不变量）
## 未能构造但认为有风险的点
## 明确安全的点
```

每条反例必须附上你实际跑通的临时脚本路径与输出。**没跑通的猜想不要当反例报**，单独归到「未能构造」一节。全部没打穿就明确说没打穿。
