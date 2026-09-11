# 只分发汉化文件，永不重分发光影本体

主流光影包许可证普遍限制修改版 zip 的二次分发（BSL 为 All Rights Reserved，Bliss 许可模糊，Complementary 系要求改名且视觉明显不同等）。我们决定：网站只分发单独的 `zh_CN.lang` 汉化文件，光影本体一律外链跳转到 CurseForge / Modrinth 官方页面，由用户自行下载。这既是合规红线，也延续了 NakiriRuri 等现有汉化仓库"只提供语言文件"的成熟模式。托管形态见 ADR-0003。

## Considered Options

- 重分发注入汉化的完整光影 zip：体验最好但版权风险高，被否决
- 按许可证逐光影分类处理（部分重打包）：维护成本高且 Bliss/BSL 类无法覆盖，被否决
- 以资源包形式替换光影语言文件：技术上不可行，Iris/OptiFine 只从光影包内读取语言文件（ShaderDoc 规范、IrisShaders/Iris#2531），被否决
