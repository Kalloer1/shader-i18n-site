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


/**
 * instTrans 术语对（`A→B`）。免费层提示词把它们作为约束一并给出。
 *
 * ⚠️ 与 SYSTEM_PROMPT 里的「术语表」是同一套词，但 SYSTEM_PROMPT 必须逐字不变，
 * 因此这里单独列一份。tests/providers.test.mjs 会断言两边不漂移。
 */
export const INST_TRANS_TERMS = [
  ['chunk', '区块'], ['biome', '群系'], ['vanilla', '原版'],
  ['shaderpack', '光影包'], ['resource pack', '资源包'],
  ['ambient occlusion', '环境光遮蔽'], ['AO', '环境光遮蔽'],
  ['bloom', '泛光'], ['light shafts', '体积光'], ['volumetric light', '体积光'],
  ['god rays', '体积光'], ['depth of field', '景深'], ['DoF', '景深'],
  ['caustics', '焦散'], ['specular', '高光'], ['normal mapping', '法线贴图'],
  ['parallax', '视差'], ['emissive', '自发光'], ['anti-aliasing', '抗锯齿'],
  ['tonemap', '色调映射'], ['saturation', '饱和度'], ['vibrance', '自然饱和度'],
  ['profile', '配置档'], ['shadowmap', '阴影贴图'], ['skybox', '天空盒'],
  ['fog', '雾'], ['translucent', '半透明'], ['motion blur', '运动模糊'],
  ['vignette', '暗角'], ['chromatic aberration', '色差'], ['lens flare', '镜头光晕'],
  ['refraction', '折射'],
]

/**
 * 免费层（bilibili Index-Translate 公开 API）的固定请求体。
 *
 * 与网关的两处关键差异：
 * 1. **不继承 `LLM_EXTRA_BODY`** —— 那是给自建中转站透传参数的，公开服务没有这个概念；
 * 2. **不需要 Authorization 头**（实测：不带 auth 头返回 200）。
 */
export const FREE_TIER_TEMPERATURE = 0.2
export const FREE_TIER_MAX_TOKENS = 8192

/**
 * 免费层的提示词：官方 instTrans 形态 —— **单条 user 消息**（无 system），
 * 含 `【源文】` / `【约束要求】` 两段，术语以 `A→B` 形式列出。
 *
 * 为什么不用 SYSTEM_PROMPT：实测免费层会**把键名一起翻掉**（`option.A` → `选项A`），
 * 因此必须用 instTrans 的显式约束；且实测它会**丢掉孤立的 `.comment` 后缀**，
 * 所以调用方按行回退漏掉的行（见 createFreeTierProvider 的说明）。
 *
 * @param {string} input 已按 \n 拼好的 `键=值` 文本
 */
export function buildInstTransPrompt(input) {
  const terms = INST_TRANS_TERMS.map(([a, b]) => `${a}→${b}`).join('｜')
  return [
    {
      role: 'user',
      content: `【源文】\n${input}\n\n【约束要求】\n`
        + '1. 只翻译等号右侧；等号左侧的键名一字不改，必须原样保留。\n'
        + '2. 保留占位符（%s、%1$s、%value%）与 § 格式码，数量与位置不变。\n'
        + '3. 输出行数与输入完全一致、顺序相同；禁止合并或拆分行。\n'
        + '4. 只输出结果行，禁止解释、序号、markdown 代码块。\n'
        + `5. 术语对照（必须遵守）：${terms}`,
    },
  ]
}

/**
 * 构造免费层提供方。
 *
 * 两个「免费层专属」的策略字段由 pipeline 读取，它们不是提示词/请求体，但同样是
 * provider 的属性（见 issue #3）：
 * - `maxAttempts: 1` —— 单次尝试，**无退避重试**；
 * - `requestTimeoutMs: 60000` —— 单请求 60 秒超时。
 *
 * **刻意没有「键集合必须完整」这个硬开关**。实测免费层会以约 60% 的概率丢掉孤立的
 * `.comment` 后缀（同名主键已命中记忆、输入里只剩 `.comment` 时），若按整块失败处理，
 * 28 行丢 2 个键会把 26 条好译文全扔掉 —— 在「免费层单跑」模式下等于整个光影失败。
 * 改为**按行回退**（漏掉的行留英文，其余译文照用），整体质量由调用方的
 * 回退率阈值（>10% 转交回退池）把关。
 *
 * @param {object} p
 * @param {string} p.model 模型 id
 * @param {() => string} p.url 接口地址
 * @param {string} p.label 日志里显示的提供方名称
 * @param {number} [p.requestTimeoutMs] 单请求超时
 */
export function createFreeTierProvider({ model, url, label, requestTimeoutMs = 60000 }) {
  return {
    id: model,
    name: label,
    url,
    // 免费层无需鉴权；保持函数形式，与网关提供方接口一致。
    key: () => undefined,
    body: (messages) => ({
      model,
      messages,
      temperature: FREE_TIER_TEMPERATURE,
      max_tokens: FREE_TIER_MAX_TOKENS,
    }),
    buildPrompt: buildInstTransPrompt,
    extract: (j) => j.choices?.[0]?.message?.content,
    maxAttempts: 1,
    requestTimeoutMs,
  }
}

/**
 * 网关请求体的固定字段；`LLM_EXTRA_BODY` 由调用方浅合并进去（**只有网关提供方**这么做）。
 */
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

/**
 * 署名行：如实反映**实际产出译文的提供方**（issue #5）。
 *
 * 为什么不能写死 `LLM_MODELS`：接入免费层后大部分条目由免费层产出，
 * 继续写回退池的模型列表会直接说谎，日后也无法追溯「这条为何质量有波动」。
 *
 * 混合产出（部分分块走免费层、部分走回退池）时两边都写，不谎报单一来源。
 * 一个提供方都没用上（如翻译记忆全覆盖）时不谎报来源。
 *
 * @param {string[]} providerIds 本次实际用上的提供方 id
 * @param {string} freeTierId 免费层的 provider id
 */
export function buildContributorLine(providerIds, freeTierId) {
  const ids = [...new Set(providerIds ?? [])]
  if (ids.length === 0) {
    // 一个提供方都没用上（如翻译记忆全覆盖）：不谎报来源。
    return 'AI 初翻（翻译记忆复用），未人工校对'
  }
  const freeIds = ids.filter((id) => id === freeTierId)
  const poolIds = ids.filter((id) => id !== freeTierId)
  const parts = []
  if (freeIds.length) parts.push(`免费层 ${freeIds.join(' / ')}`)
  if (poolIds.length) parts.push(`回退池 ${poolIds.join(' / ')}`)
  return `AI 初翻（来源：${parts.join(' + ')}），未人工校对`
}
