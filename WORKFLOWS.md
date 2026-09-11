# 自动工作流

> 更新：2026-09-11

---

## 工作流 1：Deploy to Cloudflare Pages

| 项 | 值 |
|---|---|
| 文件 | `.github/workflows/deploy.yml` |
| 触发 | push 到 main / 手动触发 |
| 作用 | npm ci → npm run build → 部署到 Cloudflare Pages |
| Secrets | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |

---

## 工作流 2：每日同步（sync）

| 项 | 值 |
|---|---|
| 文件 | `.github/workflows/sync.yml` |
| 触发 | 每天 UTC 21:00（北京时间 05:00）/ 手动触发 |
| 作用 | 拉取 Modrinth 目录 → 同步 CurseForge 元数据 → 检测新增光影写入智能表格 → 提交 |
| Secrets | `CURSEFORGE_API_KEY`（可选）, `TENCENT_DOCS_TOKEN` |

---

## 所有 Secrets

**GitHub Secrets**：`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `TENCENT_DOCS_TOKEN`, `CURSEFORGE_API_KEY`（可选）

**Worker Secrets**：`TENCENT_DOCS_TOKEN`
