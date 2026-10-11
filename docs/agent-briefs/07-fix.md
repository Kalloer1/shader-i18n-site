# 任务 G：修复审查发现的问题

## 仓库

`C:\Users\Sora\Desktop\shader\shader-i18n-site`（branch `main`）。

## 背景

`shared/zip-range.mjs` 已实现，`scripts/fetch-lang-sources.mjs` 已接入。随后有**两个独立的只读审查者**（一个正向核对、一个对抗性攻击）产出了问题清单，见下方「审查结论」一节。

## 你要做什么

按优先级修：

1. **P0 全部必修**。任何破坏「Range 要么逐字节等价、要么回退整包」的问题，以及违反四条硬约束（禁后缀区间 / 禁预判 Accept-Ranges / 501 可重试 / 窗口自适应放大）的问题。
2. **P1 尽量修**。若某条 P1 与 plan 文档定稿设计冲突，**不要自行改设计**——保留现状并在报告里说明冲突，交给主管决策。
3. **P2 可跳过**，但要在报告里列出跳过了哪些。

## 约束

- 只改 `shared/zip-range.mjs` 与 `scripts/fetch-lang-sources.mjs`。
- **不要改 `pipeline.mjs`**（用户决定，风险更高，本次不碰）。
- 不要引入新依赖。不要 `git add -A`。不要提交 `site/shaders/`。
- 修复不得以「降级校验让测试变绿」的方式实现。

## 修完必须自检（报告贴原文）

```bash
cd C:\Users\Sora\Desktop\shader\shader-i18n-site
node --test "tests/**/*.test.mjs"        # 必须全绿
node -e "import('./shared/zip-range.mjs').then(m=>console.log(m.crc32(Buffer.from('123456789')).toString(16)))"   # 期望 cbf43926
```

如果两个审查者都没发现问题，就**不要制造改动**——在报告里明确写「无 P0/P1，未做任何代码修改」。

## 审查结论

（由主管 Agent 在派发时填入；若为空表示尚未审查，直接回报无法执行）
