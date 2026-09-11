# 双仓 + 两阶段翻译：冷启动箱与每日工作流分开

公开仓 `shader-i18n-site` 只承载 VitePress 与可分发的 `zh_CN.lang`；私有仓 `shader-i18n-data` 承载目录同步、源语言抽取、密钥和 GitHub Actions。第一次把现有光影译完（冷启动）不走 Actions：待译 `en_US.lang` 放到独立文件夹 `shader-i18n-translate`，由本地 Claude 写出 `output/`，再由人通知代理登记进公开仓。之后若某光影发布了新的语言文件，才由私有仓每日工作流翻译并推送到公开仓。

## Considered Options

- 冷启动也走 GitHub Actions（每天 20 个）：覆盖现有缺口太慢，被否决
- 冷启动与增量共用同一套已入库的免费 API 脚本：密钥不能进 git，且与「订阅模型 / 本地 Claude」混在一起，被否决
- 合回单仓：密钥和 en_US 源会进入或紧挨公开仓，被否决
