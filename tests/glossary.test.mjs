#!/usr/bin/env node
/**
 * scripts/lib/glossary.mjs 的离线单元测试：翻译记忆的骨架提取与「回退」读写守卫。
 *
 * 两个实测过的真 bug：
 *  1) 骨架正则多了一个 `+`（`§[0-9a-fk-or]+`）→ `§` 会一路吞掉后面所有落在字符集里的字符，
 *     `§cOFF`/`§b2`/`§e§lNormal` 的骨架都变成空串（空骨架在读写两端都被挡下，永远记不住）；
 *     `§c§lS§f§ltars §c§lR§f§led`（"Stars Red"）与 `Stars` 塌成同一个骨架 `stars`
 *     → 重翻时整条拿到另一段英文的译文（实测 2,004 条翻错的根因）。
 *  2) 写入端把「模型回显原文」当译文永久缓存 → 记忆里混入英文原文，之后每次都被当命中用。
 * 不发任何网络请求。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { stripSkeleton, isSourceEcho, isUsableMemory, shouldRememberMemory } from '../scripts/lib/glossary.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('stripSkeleton 骨架提取（§ 只吃紧随其后的一个字符）', () => {
  it('格式码后紧跟的字符不再被吞掉（旧正则下骨架是空串）', () => {
    // 骨架统一小写（stripSkeleton 的既有行为），所以期望值是原文的小写形式。
    assert.equal(stripSkeleton('§cOFF'), 'off')
    assert.equal(stripSkeleton('§b2'), '2')
    assert.equal(stripSkeleton('§e§lNormal'), 'normal')
    // 关键回归点：不再是空串（空骨架在读写两端都被守卫挡下，永远记不住）
    for (const v of ['§cOFF', '§b2', '§e§lNormal']) assert.notEqual(stripSkeleton(v), '')
  })

  it('真实撞车样本：Stars 与 §c§lS§f§ltars §c§lR§f§led 不再同骨架', () => {
    assert.equal(stripSkeleton('§c§lS§f§ltars §c§lR§f§led'), 'stars red')
    assert.equal(stripSkeleton('Stars'), 'stars')
    assert.notEqual(stripSkeleton('§c§lS§f§ltars §c§lR§f§led'), stripSkeleton('Stars'))
  })

  it('真实撞车样本：§bEnd Stars / §aEnable Stars 不再塌到 stars', () => {
    assert.equal(stripSkeleton('§bEnd Stars'), 'end stars')
    assert.equal(stripSkeleton(' §aEnable Stars'), 'enable stars')
    assert.notEqual(stripSkeleton('§bEnd Stars'), stripSkeleton('Stars'))
  })

  it('大小写与连续空白仍归一（记忆复用的原有行为不变）', () => {
    assert.equal(stripSkeleton('  §6Volumetric   Clouds '), 'volumetric clouds')
    assert.equal(stripSkeleton('WATER'), stripSkeleton(' Water'))
  })

  it('方括号占位符（§a[+]§c[-]）不受影响：只剥离 § 码本身', () => {
    assert.equal(stripSkeleton('§a[+]§c[-]'), '[+][-]')
  })

  it('空串 / 纯空白仍是空骨架', () => {
    assert.equal(stripSkeleton(''), '')
    assert.equal(stripSkeleton('   '), '')
    assert.equal(stripSkeleton('§c'), '')
  })
})

describe('isSourceEcho 回退判据（与 translateChunk 判回退的 zh !== v 同口径）', () => {
  it('值逐字等于英文原文 → 是回退', () => {
    assert.equal(isSourceEcho('§cOFF', '§cOFF'), true)
    assert.equal(isSourceEcho('Stars', 'Stars'), true)
  })

  it('大小写/空格的正常差异不算回退（不误判成回退）', () => {
    assert.equal(isSourceEcho('Off', '§cOFF'), false)
    assert.equal(isSourceEcho(' OFF', 'OFF'), false)
    assert.equal(isSourceEcho('关闭', '§cOFF'), false)
  })
})

describe('isUsableMemory 读取端守卫', () => {
  it('命中的值等于英文原文 → 视为未命中（历史污染不再被当译文用）', () => {
    assert.equal(isUsableMemory('§cOFF', '§cOFF'), false)
    assert.equal(isUsableMemory('Normal', 'Normal'), false)
  })

  it('真译文 / 不存在 → 可当命中 / 未命中', () => {
    assert.equal(isUsableMemory('关闭', '§cOFF'), true)
    assert.equal(isUsableMemory(undefined, '§cOFF'), false)
    assert.equal(isUsableMemory('', '§cOFF'), false)
  })
})

describe('shouldRememberMemory 写入端守卫', () => {
  it('回退（值 === 英文原文）不进记忆', () => {
    assert.equal(shouldRememberMemory('off', '§cOFF', '§cOFF', undefined), false)
  })

  it('正常译文进记忆', () => {
    assert.equal(shouldRememberMemory('off', '关闭', '§cOFF', undefined), true)
  })

  it('骨架为空不写；已有记忆不覆盖', () => {
    assert.equal(shouldRememberMemory('', '关闭', '§c', undefined), false)
    assert.equal(shouldRememberMemory('off', '关', '§cOFF', '关'), false)
  })
})

describe('pipeline 与重建脚本共用同一份实现（防漂移）', () => {
  const pipeline = readFileSync(join(ROOT, 'scripts/pipeline.mjs'), 'utf8')
  const rebuild = readFileSync(join(ROOT, 'scripts/rebuild-glossary.mjs'), 'utf8')

  it('pipeline 从 lib/glossary.mjs 导入骨架与守卫，不再自带实现', () => {
    assert.match(pipeline, /from '\.\/lib\/glossary\.mjs'/)
    assert.doesNotMatch(pipeline, /function stripSkeleton/)
  })

  it('重建脚本同样 import 线上实现，不复制骨架写法', () => {
    assert.match(rebuild, /from '\.\/lib\/glossary\.mjs'/)
    assert.doesNotMatch(rebuild, /function stripSkeleton\b/)
  })

  it('pipeline 里不再出现多 `+` 的骨架正则（重建脚本里的旧正则只用于报告对比数字）', () => {
    assert.doesNotMatch(pipeline, /\[0-9a-fk-or\]\+/)
  })
})
