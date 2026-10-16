#!/usr/bin/env node
/**
 * 免费层可达性与产出质量探针（CI 专用，只读、不写仓库、不碰 secrets）。
 *
 * 为什么需要它：免费层 index-translate.bilibili.com 是国内公开服务，
 * 而 GitHub runner 在境外。**本机实测 200 不能替代 CI 出口的实测**——出口 IP 完全不同。
 * 若被地域限制，「免费层优先」在 CI 里根本跑不起来，方案需要重新考虑。
 *
 * 用法：node scripts/free-tier-probe.mjs（由 .github/workflows/free-tier-probe.yml 调用）
 * 退出码：0 = 可达且产出合格；1 = 不可达或产出不合格（会让 workflow 变红，便于发现）
 */
import { createFreeTierProvider } from './lib/providers.mjs'
import { parseLangLines, evaluateOutput } from './lib/provider-chain.mjs'

const URL = 'https://index-translate.bilibili.com/v1/chat/completions'
const MODEL = 'Index-Translate-35B-A3B'

// 真实形态的分块：含 .comment 长句、%s / %1$s 占位符、§e[+]§r 颜色码、数值型取值。
const CHUNK = [
  ['option.SHADOWS', 'Shadows'],
  ['option.SHADOWS.comment', '§e[+]§r Toggles shadow rendering. Disabling this will greatly improve performance'],
  ['value.SHADOW_QUALITY', 'Shadow Quality'],
  ['value.SHADOW_QUALITY.comment', '§7Higher values use more resources'],
  ['option.WATER_WAVES', 'Water Waves'],
  ['option.WATER_WAVES.comment', '§e[+]§r Enables water waves'],
  ['option.BLOCK_REFLECTIONS', 'Block Reflections'],
  ['option.BLOCK_REFLECTIONS.comment', '§e[+]§r Enables reflections on blocks'],
  ['option.AO', 'AO'],
  ['option.AO.comment', '§e[+]§r Ambient occlusion strength'],
  ['option.BLOOM', 'Bloom'],
  ['option.BLOOM.comment', '§e[+]§r Glow around bright areas'],
  ['option.TONEMAP', 'Tonemap'],
  ['option.MOTION_BLUR', 'Motion Blur'],
  ['option.VIGNETTE', 'Vignette'],
  ['option.CHROMATIC_ABERRATION', 'Chromatic Aberration'],
  ['option.DEPTH_OF_FIELD', 'Depth of Field'],
  ['screen.SHADER_SETTINGS', 'Shader Settings'],
  ['screen.SHADER_SETTINGS.comment', 'Press %s to open, or %1$s to reset'],
  ['option.LOD_BIAS', 'LOD Bias'],
  ['option.LABPBR', 'labPBR Support'],
  ['option.ANTI_ALIASING', 'Anti-Aliasing'],
  ['option.CAUSTICS', 'Caustics'],
  ['option.SPECULAR', 'Specular Highlights'],
  ['option.NORMAL_MAPPING', 'Normal Mapping'],
  ['option.PARALLAX', 'Parallax Occlusion'],
  ['option.TRANSLUCENT', 'Translucent Shadows'],
  ['option.EMISSIVE', 'Emissive Strength'],
  ['option.REFRACTION', 'Refraction'],
  ['option.LENS_FLARE', 'Lens Flare'],
]

const sec = (s) => (s.match(/§./g) ?? []).sort().join('|')
const ph = (s) => (s.match(/%%|%\d+\$[sdfx]|%[sdfx]|%[A-Za-z_][A-Za-z0-9_]*%|%\d+%/g) ?? []).sort().join('|')

console.log(`探针目标：${URL}`)
console.log(`模型：${MODEL}`)
console.log(`分块：${CHUNK.length} 行（含 .comment 长句、%s / %1$s 占位符、§ 颜色码）\n`)

// 第一步：可达性（不带任何鉴权头，模拟流水线的真实请求形态）
const provider = createFreeTierProvider({ model: MODEL, url: () => URL, label: 'probe' })
const input = CHUNK.map(([k, v]) => `${k}=${v}`).join('\n')
const messages = provider.buildPrompt(input)

const t0 = Date.now()
let res
try {
  res = await fetch(provider.url(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(provider.body(messages)),
    signal: AbortSignal.timeout(provider.requestTimeoutMs),
  })
} catch (err) {
  console.error(`\n❌ 免费层从 CI 出口不可达：${err.name}: ${err.message}`)
  console.error('   若为超时/连接失败，很可能是地域限制 —— 「免费层优先」在 CI 里不成立。')
  process.exit(1)
}
const elapsed = Date.now() - t0
console.log(`HTTP ${res.status}（${elapsed}ms）`)

if (!res.ok) {
  console.error(`\n❌ 免费层返回非 2xx：${(await res.text()).slice(0, 300)}`)
  process.exit(1)
}

const json = await res.json()
const text = json.choices?.[0]?.message?.content ?? ''
if (!text.trim()) {
  console.error('\n❌ 免费层返回空正文')
  process.exit(1)
}

// 第二步：产出质量
const got = parseLangLines(text)
const { fallback, missingKeys } = evaluateOutput(CHUNK, got)
let secDrift = 0
let phDrift = 0
let untranslated = 0
for (const [k, v] of CHUNK) {
  const zh = got.get(k)
  if (zh === undefined) continue
  if (zh === v) untranslated++
  if (sec(zh) !== sec(v)) secDrift++
  if (ph(zh) !== ph(v)) phDrift++
}

console.log('\n--- 产出质量 ---')
console.log(`解析行数    ${got.size}/${CHUNK.length}`)
console.log(`缺失键      ${missingKeys.length}${missingKeys.length ? `（${missingKeys.slice(0, 5).join(', ')}）` : ''}`)
console.log(`回退（回显）${fallback}`)
console.log(`§ 码漂移    ${secDrift}`)
console.log(`占位符漂移  ${phDrift}`)
console.log(`未翻译      ${untranslated}`)

console.log('\n--- 回话前 8 行 ---')
console.log(text.split('\n').slice(0, 8).join('\n'))

const problems = []
if (missingKeys.length) problems.push(`丢键 ${missingKeys.length}`)
if (secDrift) problems.push(`§ 码漂移 ${secDrift}`)
if (phDrift) problems.push(`占位符漂移 ${phDrift}`)

if (problems.length) {
  console.error(`\n❌ 产出不合格：${problems.join('、')}`)
  console.error('   注意：丢键说明免费层把键名也翻掉了，requiresCompleteKeys 会判它失败并降级。')
  process.exit(1)
}

console.log('\n✅ 免费层从 CI 出口可达，且产出合格（零丢键、零 § 漂移、零占位符漂移）')
