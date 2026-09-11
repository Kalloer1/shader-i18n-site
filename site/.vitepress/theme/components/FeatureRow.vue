<script setup>
const items = [
  {
    title: '只分发汉化文件',
    text: '出于版权原因不分发光影本体，只提供 zh_CN.lang；光影本体一律跳转 Modrinth / CurseForge 官方页面。',
    icon: 'M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  },
  {
    title: '精确到版本的映射',
    text: 'lang 键随光影版本变动。每个汉化文件都标注适配的光影版本，最新版默认展示，旧版本折叠。',
    icon: 'M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M3 15v4a2 2 0 0 0 2 2h4m10-6v4a2 2 0 0 1-2 2h-4M7 12h10',
  },
  {
    title: 'AI 辅助翻译声明',
    text: '部分汉化文件由 AI 模型（SiliconFlow / DeepSeek-V4-Flash）初翻生成，标注为「AI 初翻」。建议玩家根据个人偏好选择已校对版本或自行润色。',
    icon: 'M16 18 22 12 16 6M8 6 2 12l6 6',
  },
]
</script>

<template>
  <div class="feature-row">
    <div v-for="it in items" :key="it.title" class="feature">
      <span class="fico">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="it.icon" /></svg>
      </span>
      <div>
        <h3>{{ it.title }}</h3>
        <p>{{ it.text }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.feature-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 1px;
  background: var(--vp-c-divider);
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  overflow: hidden;
  margin: 26px 0 40px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}
.feature {
  display: flex;
  gap: 14px;
  padding: 20px 18px;
  background: var(--vp-c-bg-soft);
  transition: background 0.2s;
}
.feature:hover {
  background: var(--vp-c-bg-elv);
}
.fico {
  flex: none;
  width: 38px;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: var(--vp-c-brand-1);
  background: rgba(232, 163, 61, 0.15);
  border: 1px solid rgba(232, 163, 61, 0.18);
  transition: background 0.2s, border-color 0.2s;
}
.feature:hover .fico {
  background: rgba(232, 163, 61, 0.22);
  border-color: rgba(232, 163, 61, 0.3);
}
.feature h3 {
  font-family: var(--shader-display-font);
  font-size: 14.5px;
  margin: 2px 0 6px !important;
  border: none !important;
  padding: 0 !important;
  color: var(--vp-c-text-1);
}
.feature p {
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--vp-c-text-3);
  margin: 0;
}
</style>
