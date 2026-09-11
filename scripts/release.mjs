#!/usr/bin/env node
/**
 * 发布脚本：翻译完成后一键发布到站点。
 *
 * 用法：node scripts/release.mjs <shader-id> [--skip-quark]
 *
 * 流程：
 * 1. 验证 lang 文件存在
 * 2. git add + commit
 * 3. git push 触发 Cloudflare Pages 部署
 *
 * 环境变量：无必填
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LANG_DIR = join(ROOT, 'site/public/lang')

const args = process.argv.slice(2)
const shaderId = args.find(a => !a.startsWith('-'))

if (!shaderId) {
  console.log('用法: node scripts/release.mjs <shader-id>')
  console.log('示例: node scripts/release.mjs complementary-reimagined')
  process.exit(1)
}

function exec(cmd) {
  console.log(`> ${cmd}`)
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim()
}

function findLangFile(shaderId) {
  const shaderDir = join(LANG_DIR, shaderId)
  if (!existsSync(shaderDir)) return null

  const versions = []
  for (const v of readdirSync(shaderDir)) {
    const langPath = join(shaderDir, v, 'zh_CN.lang')
    if (existsSync(langPath)) {
      versions.push({ version: v, path: langPath })
    }
  }

  if (versions.length === 0) return null
  versions.sort((a, b) => b.version.localeCompare(a.version))
  return versions[0]
}

console.log(`\n🚀 发布光影: ${shaderId}\n`)

// 1. 查找 lang 文件
const langInfo = findLangFile(shaderId)
if (!langInfo) {
  console.error(`❌ 未找到 lang 文件: site/public/lang/${shaderId}/<version>/zh_CN.lang`)
  process.exit(1)
}
console.log(`📄 找到 lang 文件: ${langInfo.path}`)

// 2. git add
exec('git add -A')
const status = exec('git status --porcelain')
if (!status) {
  console.log('ℹ️  无变更，跳过提交')
  process.exit(0)
}

// 3. commit
exec(`git commit -m "发布 ${shaderId} 汉化文件"`)
console.log('✅ 已提交')

// 4. push
exec('git push')
console.log('✅ 已推送，Cloudflare Pages 将自动部署')

console.log(`\n🎉 ${shaderId} 发布完成！\n`)
