# 网站本体：VitePress 静态站 + JSON 数据

站点本质是"一份光影元数据 JSON + 一份版本映射表 + 若干下载链接"，无需后端。决定基于 VitePress（参考 vitepress-nav-template 模板）构建静态站，数据以 JSON 文件形式进 Git 仓库，部署到 GitHub Pages / Cloudflare Pages；缺的功能（版本映射表、按光影筛选）用 Vue 组件在 VitePress 内扩展。Modrinth 与 CurseForge 的元数据均通过 API 自动同步（两者凭证均已具备；Modrinth 无需 key，CurseForge 搜索 API 使用自有 key，密钥一律不入库）。

## Considered Options

- 复用 Modrinth 开源 monorepo 自建平台：重型、官方不支持自托管，被否决
- WordPress/CMS 动态站：需养服务器、防攻击，规模不匹配，被否决
- Astro 纯静态：性能更好但模板生态偏英文、二次开发量大，被否决
