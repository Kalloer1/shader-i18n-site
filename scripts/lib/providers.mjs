#!/usr/bin/env node
/**
 * 翻译提供方（provider）：**提示词与请求体形状是 provider 自己的属性**，不是模块级常量。
 *
 * 为什么抽到 lib：提供方之间唯一需要分叉的就是这两样东西（免费层走官方 instTrans 形态、
 * 不继承 LLM_EXTRA_BODY），而超时/重试/熔断属于流水线策略、留在 pipeline.mjs。
 * 抽成纯函数是为了能被离线单测覆盖——见 tests/providers.test.mjs。
 */

export const SYSTEM_PROMPT = `你是 Minecraft Java 版光影包（Iris / OptiFine）语言文件（.lang）的专业本地化译者。输入每行形如 "键=英文值"，输出 "键=中文值"。

硬性规则（违反即任务失败）：
1. 键名（= 左侧）一字不改；输出行数与输入一致、顺序相同；禁止合并或拆分行。
2. 占位符（%s、%value%、%n$s 等）与格式码（§ 及其后一个字符，如 §e、§r、§a[+]§c[-]）的数量、种类、相对位置必须与原文完全一致。
3. 只输出结果行，禁止解释、禁止序号、禁止 markdown 代码块。

术语表（全篇统一，符合 Minecraft 社区习惯）：
chunk=区块｜biome=群系｜vanilla=原版｜shaderpack=光影包｜resource pack=资源包
ambient occlusion/AO=环境光遮蔽｜bloom=泛光｜light shafts/volumetric light=体积光｜god rays=体积光
depth of field/DoF=景深｜caustics=焦散｜specular=高光｜normal mapping=法线贴图｜parallax=视差
emissive=自发光｜anti-aliasing=抗锯齿｜tonemap=色调映射｜saturation=饱和度｜vibrance=自然饱和度
profile=配置档｜shadowmap=阴影贴图｜skybox=天空盒｜fog=雾｜translucent=半透明
motion blur=运动模糊｜vignette=暗角｜chromatic aberration=色差｜lens flare=镜头光晕｜refraction=折射

风格规则：
4. "More xxx Config" 类界面名译为「xxx 高级设置」；"xxx Strength/Amount" 译为「xxx 强度/数量」。
5. 质量档位用 低配/中配/高配/极高；数值型取值（"0.50"、"8K"、"5 cm"、"10%"）保持原样。
6. 专有名词保留原文：TAA、FXAA、labPBR、SEUS、PBR、LOD、Voxy、Distant Horizons、Perlin、Worley、OptiFine、Iris、BSL。
7. 界面文案要简洁（游戏设置空间有限），长说明句（.comment）译得通顺完整、不偷懒减行。
8. 语义不明的键保持英文原值，不要猜。`


/** 网关请求体的固定字段；`LLM_EXTRA_BODY` 由调用方浅合并进去（**只有网关提供方**这么做）。 */
export const GATEWAY_TEMPERATURE = 0.2
export const GATEWAY_MAX_TOKENS = 8192

/**
 * 网关提供方的提示词：system 角色承载全部规则与术语表，user 角色只放待译文本。
 * 形态必须与改造前逐字一致（这是一条刻意立下的不变量）。
 * @param {string} input 已按 \n 拼好的 `键=值` 文本
 */
export function buildGatewayPrompt(input) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: input },
  ]
}

/**
 * 构造一个网关提供方（自建中转站，OpenAI 兼容）。
 *
 * `url` / `key` 保持**函数**形式：既有实现在每次调用时才读环境变量，
 * 改成值会在语义上做一次不必要的收紧。
 *
 * @param {object} p
 * @param {string} p.model 模型 id
 * @param {() => string} p.url 接口地址
 * @param {() => string|undefined} p.key API key
 * @param {object} [p.extraBody] 额外请求体，浅合并进 body（来自 LLM_EXTRA_BODY）
 * @param {string} p.label 日志里显示的提供方名称
 */
export function createGatewayProvider({ model, url, key, extraBody = {}, label }) {
  return {
    id: model,
    name: label,
    url,
    key,
    body: (messages) => ({
      model,
      messages,
      temperature: GATEWAY_TEMPERATURE,
      max_tokens: GATEWAY_MAX_TOKENS,
      ...extraBody,
    }),
    buildPrompt: buildGatewayPrompt,
    extract: (j) => j.choices?.[0]?.message?.content,
  }
}
