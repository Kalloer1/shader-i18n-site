#!/usr/bin/env node
/**
 * 小文件的原子读写与「内容没变就不碰文件」。
 *
 * 为什么抽出来：pipeline 里已有 `writeJsonIfChanged`（临时文件 + rename），
 * 断点续翻的进度文件也必须走同一条路，否则进程被杀会留下半截 JSON。
 * 半截的进度文件比没有更糟——它「看起来有进度」。
 *
 * 与 `writeJsonIfChanged` 的区别：这里直接收字符串（进度文件有自己的序列化格式，
 * 不是通用 JSON 缩进风格），并且**不排队**（各条光影写各自的文件，互不冲突）。
 *
 * 无全局状态；路径由调用方给出，可离线单测（见 tests/atomic-file.test.mjs）。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 读文件；不存在 / 读不了返回 null（不抛错）。 */
export function readFileQuietly(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * 原子写：内容完全相同则**不碰文件**（返回 false），否则写临时文件再 rename。
 *
 * 「不碰文件」不只是省 IO：`npm test` 会并行跑多个 pipeline 子进程，
 * 无谓的重写会在 Windows 上撞文件锁，让部署闸门随机变红（历史缺陷，见 tests/pipeline-smoke.test.mjs）。
 *
 * @returns {boolean} 是否真的写了
 */
export function writeFileAtomic(file, text) {
  if (readFileQuietly(file) === text) return false
  mkdirSync(dirname(file), { recursive: true })
  const tmpFile = `${file}.tmp-${process.pid}`
  writeFileSync(tmpFile, text)
  renameSync(tmpFile, file)
  return true
}

/** 删除文件；不存在也返回 false，不抛错（可安全重复清理）。 */
export function removeFileQuietly(file) {
  try {
    unlinkSync(file)
    return true
  } catch {
    return false
  }
}
