#!/usr/bin/env node
/**
 * 自动汉化流水线（ADR-0005）：下载 → 检测自带中文 → LLM 初翻 → 校验 → 登记。
 *
 * 候选：目录中按下载量排序、未被流水线覆盖且不在缺少英文源清单中的光影（无汉化映射、未检出自带中文）。
 * 翻译使用单一模型并按候选顺序处理，避免免费接口并发限流和同一文件术语不一致。
 *
 * LLM 提供方：SiliconFlow（硅基流动）。
 *   SILICONFLOW_API_KEY；模型固定为 tencent/Hunyuan-MT-7B。
 * 密钥通过环境变量读取，不入库；接口使用 OpenAI 兼容 chat/completions。
  *
 * 用法：node scripts/pipeline.mjs [--top 50]
 */
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { inflateRawSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG_FILE = join(ROOT, 'site/data/modrinth-catalog.json')
const SHADERS_FILE = join(ROOT, 'site/data/shaders.json')
const MISSING_SOURCE_FILE = join(ROOT, 'site/data/missing-source.json')
const GLOSSARY_FILE = join(ROOT, 'site/data/glossary.json')
const LANG_DIR = join(ROOT, 'site/public/lang')
const MODRINTH_API = 'https://api.modrinth.com/v2'
const CHUNK_LINES = 60
const MODEL = 'tencent/Hunyuan-MT-7B'
const MAX_RETRIES = 10
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// ---------- LLM 提供方 ----------
const provider = {
  id: 'hunyuan',
  name: 'Hunyuan-MT-7B（SiliconFlow）',
  url: () => process.env.SILICONFLOW_BASE_URL ?? 'https://api.siliconflow.cn/v1/chat/completions',
  key: () => process.env.SILICONFLOW_API_KEY,
  body: (messages) => ({
    model: MODEL,
    messages,
    temperature: 0.2,
    max_tokens: 8192,
  }),
  extract: (j) => j.choices?.[0]?.message?.content,
}

if (!process.env.SILICONFLOW_API_KEY) {
  console.error('缺少 SiliconFlow API key：请设置 SILICONFLOW_API_KEY')
  process.exit(2)
}
console.log(`LLM 提供方：${provider.name}（${provider.body([]).model}）\n`)

async function chatOnce(activeProvider, messages) {
  const res = await fetch(activeProvider.url(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${activeProvider.key()}` },
    body: JSON.stringify(activeProvider.body(messages)),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const j = await res.json()
  const text = activeProvider.extract(j)
  if (!text) throw new Error('返回为空')
  return text
}

async function chatWithRetry(activeProvider, messages) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await chatOnce(activeProvider, messages)
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err
      const delay = 2000 * 2 ** (attempt - 1)
      await sleep(delay)
    }
  }
}

// ---------- 翻译记忆（glossary.json） ----------
let glossary = {}
try {
  glossary = JSON.parse(readFileSync(GLOSSARY_FILE, 'utf8'))
  console.log(`翻译记忆加载：${Object.keys(glossary).length} 条\n`)
} catch {
  console.log('翻译记忆不存在，将从头构建\n')
}

// 骨架提取：剥离合法 § 格式码、小写、压缩空白
function stripSkeleton(value) {
  return value
    .replace(/§[0-9a-fk-or]+/gi, '')   // 剥离合法 § 码（§e、§r、§a[+]§c[-] 等）
    .toLowerCase()
    .replace(/\s+/g, ' ')               // 压缩空白
    .trim()
}

// 保存翻译记忆
function persistGlossary() {
  writeFileSync(GLOSSARY_FILE, JSON.stringify(glossary, null, 2) + '\n')
}

// ---------- 翻译提示词 ----------
const SYSTEM_PROMPT = `你是 Minecraft Java 版光影包（Iris / OptiFine）语言文件（.lang）的专业本地化译者。输入每行形如 "键=英文值"，输出 "键=中文值"。

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

// ---------- 极简 zip 读取（只读，支持 Stored/Deflate，不处理 zip64） ----------
function zipEntries(buf) {
  const eocdSig = 0x06054b50
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === eocdSig) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('zip: 找不到 EOCD')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const entries = new Map()
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip: 中央目录损坏')
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOffset = buf.readUInt32LE(off + 42)
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8')
    entries.set(name, { method, compSize, localOffset })
    off += 46 + nameLen + extraLen + commentLen
  }
  return {
    read(name) {
      const e = entries.get(name)
      if (!e) return null
      const lho = e.localOffset
      if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(`zip: 本地头损坏 ${name}`)
      const nameLen = buf.readUInt16LE(lho + 26)
      const extraLen = buf.readUInt16LE(lho + 28)
      const dataStart = lho + 30 + nameLen + extraLen
      const raw = buf.slice(dataStart, dataStart + e.compSize)
      return e.method === 0 ? raw : inflateRawSync(raw)
    },
    names: [...entries.keys()],
  }
}

// ---------- 翻译 ----------
// 解析模型输出：提取 键=值 对（容忍代码块围栏、前后杂讯）
function parseLangLines(text) {
  const got = new Map()
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    got.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  return got
}

// 翻译一个分块。模型偶发空响应/回显原文，因此回退率超过 10% 即重试，最多 3 次，取回退最少的版本。
async function translateChunk(chunk, activeProvider) {
  const input = chunk.map(([k, v]) => `${k}=${v}`).join('\n')
  let best = null, bestFallback = chunk.length
  for (let attempt = 1; attempt <= 3 && bestFallback > Math.ceil(chunk.length * 0.1); attempt++) {
    let text
    try {
      text = await chatWithRetry(activeProvider, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: input },
      ])
    } catch (err) {
      if (attempt === 3 || best) {
        console.log(`    [${activeProvider.id}] 分块翻译失败（重试耗尽）: ${err.message.slice(0, 120)}`)
        break
      }
      continue
    }
    const got = parseLangLines(text)
    const out = new Map()
    let fallback = 0
    for (const [k, v] of chunk) {
      const zh = got.get(k)
      if (zh && zh !== v) out.set(k, zh)
      else { out.set(k, v); fallback++ }
    }
    if (fallback < bestFallback) {
      best = out
      bestFallback = fallback
    }
    if (bestFallback > Math.ceil(chunk.length * 0.1)) {
      console.log(`    第 ${attempt} 次分块回退率 ${fallback}/${chunk.length}，重试`)
    }
  }
  return { map: best ?? new Map(chunk.map(([k, v]) => [k, v])), fallback: bestFallback }
}

async function translateEntries(pairs, activeProvider) {
  const out = new Map()
  let totalFallback = 0
  let glossaryHit = 0
  let llmCalls = 0

  // 第一步：查翻译记忆，命中的直接复用
  const unmatched = []
  for (const [k, v] of pairs) {
    const skel = stripSkeleton(v)
    if (skel && glossary[skel]) {
      out.set(k, glossary[skel])
      glossaryHit++
    } else {
      unmatched.push([k, v])
    }
  }

  if (unmatched.length === 0) {
    console.log(`    翻译记忆全覆盖（${glossaryHit}/${pairs.length}），跳过 LLM`)
    return { map: out, totalFallback: 0, glossaryHit, llmCalls: 0 }
  }

  console.log(`    翻译记忆命中 ${glossaryHit}/${pairs.length}，剩余 ${unmatched.length} 个需 LLM 翻译`)

  // 第二步：未命中的发给 LLM
  for (let i = 0; i < unmatched.length; i += CHUNK_LINES) {
    const chunk = unmatched.slice(i, i + CHUNK_LINES)
    const { map, fallback } = await translateChunk(chunk, activeProvider)
    for (const [k, v] of map) {
      out.set(k, v)
      // 新翻译结果按英文原文写入翻译记忆
      const sourceSkeleton = stripSkeleton(chunk.find(([key]) => key === k)?.[1] ?? '')
      if (sourceSkeleton && !glossary[sourceSkeleton]) {
        glossary[sourceSkeleton] = v
      }
    }
    totalFallback += fallback
    llmCalls++
  }

  return { map: out, totalFallback, glossaryHit, llmCalls }
}

// ---------- 主流程 ----------
const catalog = JSON.parse(readFileSync(CATALOG_FILE, 'utf8'))
const db = JSON.parse(readFileSync(SHADERS_FILE, 'utf8'))
const missingSource = new Set(JSON.parse(readFileSync(MISSING_SOURCE_FILE, 'utf8')))

const latestLangVersion = new Map()
for (const s of db.shaders) {
  for (const v of s.langVersions ?? []) {
    latestLangVersion.set(s.id, v.shaderVersion) // langVersions 按新在前
    break
  }
}

const candidates = catalog.shaders.filter((c) => {
  if (c.hasNativeZhCN === true) return false
  if (c.noEnUsLang || missingSource.has(c.id)) return false
  if (latestLangVersion.get(c.id)) return false // 最新版本已有汉化
  return true
})

const args = process.argv.slice(2)
const topArg = args.indexOf('--top')
const TOP = topArg >= 0 ? Number(args[topArg + 1]) : 50
console.log(`候选 ${candidates.length} 个，本次处理前 ${TOP} 个\n`)

const tmp = mkdtempSync(join(tmpdir(), 'shader-pipeline-'))
let done = 0, skippedNative = 0, failed = 0, processed = 0

function persist() {
  writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2) + '\n')
  writeFileSync(SHADERS_FILE, JSON.stringify(db, null, 2) + '\n')
}

async function processShader(entry) {
  const tag = `[${entry.id}]`
  try {
    const versions = await fetch(`${MODRINTH_API}/project/${entry.projectId}/version`, {
      headers: { 'User-Agent': UA() },
    }).then((r) => r.json())
    const latest = versions[0]
    const file = latest?.files?.find((f) => f.primary) ?? latest?.files?.[0]
    if (!file) { console.log(`${tag} 无可下载文件，跳过`); failed++; return }
    const shaderVersion = latest.version_number
    if (latestLangVersion.get(entry.id) === shaderVersion) { console.log(`${tag} v${shaderVersion} 已有汉化，跳过`); return }

    // zip 下载带重试（大文件网络中断偶发）
    let zipBuf
    for (let attempt = 1; ; attempt++) {
      try {
        zipBuf = Buffer.from(await fetch(file.url, { headers: { 'User-Agent': UA() } }).then((r) => r.arrayBuffer()))
        break
      } catch (err) {
        if (attempt >= 3) throw err
        console.log(`${tag} 下载失败（第 ${attempt} 次）: ${err.message.slice(0, 80)}，重试`)
        await sleep(2000 * attempt)
      }
    }
    const zip = zipEntries(zipBuf)
    const langNames = zip.names.filter((n) => /^shaders\/lang\/[^/]+$/i.test(n))
    if (langNames.some((n) => /^shaders\/lang\/zh_CN\.lang$/i.test(n))) {
      entry.hasNativeZhCN = true
      console.log(`${tag} 自带中文（v${shaderVersion}），已标记并排除`)
      skippedNative++
      persist()
      return
    }
    const enName = langNames.find((n) => /^shaders\/lang\/en_US\.lang$/i.test(n))
    if (!enName) {
      entry.noEnUsLang = true
      console.log(`${tag} 无 en_US.lang（lang 文件: ${langNames.join(', ') || '无'}），跳过`)
      failed++
      persist()
      return
    }

    const enText = zip.read(enName).toString('utf8')
    const lines = enText.split('\n')
    const pairs = []
    for (const line of lines) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq <= 0) continue
      pairs.push([t.slice(0, eq), t.slice(eq + 1)])
    }
    if (!pairs.length) {
      entry.noEnUsLang = true
      console.log(`${tag} en_US.lang 无可翻译条目，跳过`)
      failed++
      persist()
      return
    }

    console.log(`${tag} v${shaderVersion}：${pairs.length} 个键，[${provider.id}] 开始初翻…`)
    const { map: zhMap, totalFallback, glossaryHit, llmCalls } = await translateEntries(pairs, provider)
    console.log(`${tag} 翻译完成：记忆命中 ${glossaryHit}，LLM 调用 ${llmCalls} 次，回退 ${totalFallback}/${pairs.length}`)
    // 整体回退率过高视为翻译失败：不上线、不登记，留待下次重试
    if (totalFallback > pairs.length * 0.3) {
      console.log(`${tag} 回退率过高（${totalFallback}/${pairs.length}），判定失败，跳过`)
      failed++
      return
    }
    const outLines = lines.map((line) => {
      const t = line.trim()
      if (!t || t.startsWith('#')) return line
      const eq = t.indexOf('=')
      if (eq <= 0) return line
      return `${t.slice(0, eq)}=${zhMap.get(t.slice(0, eq)) ?? t.slice(eq + 1)}`
    })
    const header = `#shaders/lang/zh_CN.lang\n# ${entry.title} v${shaderVersion} 简体中文翻译（AI 初翻，未人工校对）\n# 源文件：${file.filename} 的 ${enName}\n`
    const outPath = join(LANG_DIR, entry.id, shaderVersion, 'zh_CN.lang')
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, header + outLines.join('\n'))

    const enTmp = join(tmp, `${randomUUID()}_en_US.lang`)
    writeFileSync(enTmp, enText)
    try {
      execFileSync(process.execPath, [join(ROOT, 'scripts/validate-lang.mjs'), enTmp, outPath], { stdio: 'pipe' })
    } finally {
      rmSync(enTmp, { force: true })
    }

    let shaderEntry = db.shaders.find((s) => s.id === entry.id)
    if (!shaderEntry) {
      shaderEntry = { id: entry.id, modrinth: { slug: entry.id, projectId: entry.projectId }, langVersions: [] }
      db.shaders.push(shaderEntry)
    }
    shaderEntry.langVersions = shaderEntry.langVersions ?? []
    shaderEntry.langVersions.unshift({
      shaderVersion,
      langVersion: '1.0.0',
      file: `/lang/${entry.id}/${shaderVersion}/zh_CN.lang`,
      quark: '',
      updatedAt: new Date().toISOString().slice(0, 10),
      contributors: [`AI 初翻（${provider.name.split('（')[0]}），未人工校对`],
    })
    done++
    processed++
    console.log(`${tag} 完成（${processed}/${TOP}） -> ${outPath.replace(ROOT + '\\', '').replace(/\\\\/g, '/')}`)
    persist()
    await sleep(300)
  } catch (err) {
    console.log(`${tag} 失败: ${err.message.slice(0, 200)}`)
    failed++
  }
}

function UA() {
  return 'shader-i18n-site/0.1.0 (translation pipeline)'
}

try {
  for (const entry of candidates.slice(0, TOP)) await processShader(entry)
} finally {
  persist()
  persistGlossary()
  rmSync(tmp, { recursive: true, force: true })
  console.log(`\n流水线结束：完成 ${done}，自带中文排除 ${skippedNative}，失败/跳过 ${failed}`)
}
