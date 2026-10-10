#!/usr/bin/env node
/**
 * 把 sources/<id>/<version>/en_US.lang 打成一个 gzip 包，提交进仓库，
 * 让 CI 在没有 sources/（被 .gitignore 排除）时也能做完整的 EN↔ZH 比对。
 *
 * 为什么需要它：sources/ 有 16 MB 且版权属原作者，不入库；
 * 但 validate-lang 的完整比对依赖 EN 原文。若 CI 拿不到英文源，
 * 闸门会退回「假绿灯」——这正是历史上 22 个真实缺陷被漏掉的原因。
 *
 * 产出：data/lang-sources.json.gz（约 2 MB，只含 en_US.lang 文本，不含 shader 二进制）
 * 读取方：scripts/validate-lang.mjs 的 resolveEnSource()（本地 sources/ 缺失时回退到此包）
 *
 * 用法：node scripts/pack-lang-sources.mjs
 * 何时重跑：sources/ 有新增或更新后（例如跑完 fetch-lang-sources.mjs）
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = join(ROOT, 'sources')
const OUT_FILE = join(ROOT, 'data/lang-sources.json.gz')

export const BUNDLE_FILE = OUT_FILE

/** 读取打包好的英文源（供 validate-lang.mjs 回退使用）。 */
export function readBundle(file = OUT_FILE) {
  if (!existsSync(file)) return null
  const json = gunzipSync(readFileSync(file)).toString('utf8')
  const parsed = JSON.parse(json)
  return parsed?.entries ?? null
}

function pack() {
  if (!existsSync(SRC_DIR)) {
    console.error(`✘ 找不到 ${SRC_DIR}，请先跑 node scripts/fetch-lang-sources.mjs`)
    process.exit(1)
  }

  // 与已有包合并：CI 里 sources/ 只有本次新翻译的光影，
  // 若直接覆盖会把已发布的 472 条英文源全部抹掉。
  const entries = { ...(readBundle() ?? {}) }
  const before = Object.keys(entries).length
  let count = 0
  for (const id of readdirSync(SRC_DIR)) {
    const idDir = join(SRC_DIR, id)
    if (!statSync(idDir).isDirectory()) continue
    for (const ver of readdirSync(idDir)) {
      const enPath = join(idDir, ver, 'en_US.lang')
      if (!existsSync(enPath)) continue
      entries[`${id}/${ver}`] = readFileSync(enPath, 'utf8')
      count++
    }
  }

  if (!count && before) {
    console.log(`✔ sources/ 无新增，保留已有 ${before} 条英文源`)
    return
  }

  if (!Object.keys(entries).length) {
    console.error('✘ 没有任何 en_US.lang，拒绝生成空包')
    process.exit(1)
  }

  const payload = JSON.stringify({ generatedAt: new Date().toISOString(), count: Object.keys(entries).length, entries })
  const gz = gzipSync(Buffer.from(payload, 'utf8'), { level: 9 })
  mkdirSync(dirname(OUT_FILE), { recursive: true })
  writeFileSync(OUT_FILE, gz)

  const added = Object.keys(entries).length - before
  console.log(`✔ 已打包 ${count} 个 en_US.lang（新增 ${added}，总计 ${Object.keys(entries).length}）`)
  console.log(`  ${OUT_FILE.replace(ROOT + '\\', '').replace(/\\/g, '/')}  ${(gz.length / 1024 / 1024).toFixed(2)} MB`)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) pack()
