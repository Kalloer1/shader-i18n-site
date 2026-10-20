#!/usr/bin/env node
/**
 * scripts/lib/atomic-file.mjs 的离线单元测试：原子写 + 「内容没变不碰文件」。
 *
 * 为什么值得单独测：pipeline 的进度文件与 `sources/` 里的英文源都要走这条路径。
 * 两个真实风险：
 *  1) 内容没变却重写 —— `npm test` 并行跑多个 pipeline 子进程时会在 Windows 上撞文件锁
 *     （历史上就是这样让 deploy 闸门随机变红的，见 tests/pipeline-smoke.test.mjs）；
 *  2) 直接覆盖写 —— 进程被杀会留下半截文件，而进度文件半截的后果是「看起来有进度」。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic, removeFileQuietly, readFileQuietly } from '../scripts/lib/atomic-file.mjs'

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-file-test-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('writeFileAtomic', () => {
  it('新文件：写入并返回 true', () => {
    withTempDir((dir) => {
      const p = join(dir, 'a.json')
      assert.equal(writeFileAtomic(p, '{"a":1}\n'), true)
      assert.equal(readFileSync(p, 'utf8'), '{"a":1}\n')
    })
  })

  it('内容没变 → 不碰文件（返回 false，mtime 不变）', () => {
    withTempDir((dir) => {
      const p = join(dir, 'a.json')
      writeFileAtomic(p, 'same\n')
      const before = statSync(p).mtimeMs
      // 等到 mtime 的粗粒度足以区分（NTFS 通常 100ns，但保险起见）
      assert.equal(writeFileAtomic(p, 'same\n'), false)
      assert.equal(statSync(p).mtimeMs, before)
    })
  })

  it('内容变了 → 原子替换，且不留下临时文件', () => {
    withTempDir((dir) => {
      const p = join(dir, 'a.json')
      writeFileAtomic(p, 'old\n')
      assert.equal(writeFileAtomic(p, 'new\n'), true)
      assert.equal(readFileSync(p, 'utf8'), 'new\n')
      assert.deepEqual(readdirSync(dir), ['a.json'], '临时文件必须清理干净')
    })
  })
})

describe('removeFileQuietly / readFileQuietly', () => {
  it('删除不存在的文件不抛错（幂等，可安全重复清理）', () => {
    withTempDir((dir) => {
      assert.equal(removeFileQuietly(join(dir, 'nope.json')), false)
      const p = join(dir, 'x.json')
      writeFileSync(p, 'x')
      assert.equal(removeFileQuietly(p), true)
      assert.equal(removeFileQuietly(p), false)
    })
  })

  it('读不存在的文件返回 null，不抛错', () => {
    withTempDir((dir) => {
      assert.equal(readFileQuietly(join(dir, 'nope.json')), null)
      const p = join(dir, 'x.json')
      writeFileSync(p, 'x')
      assert.equal(readFileQuietly(p), 'x')
    })
  })
})
