import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffVanished } from '../scripts/lib/catalog-diff.mjs'

test('没有任何条目消失时 vanished 与 vanishedWithTranslations 均为空（防止假检测永远报警）', () => {
  // 含"改 slug 但 projectId 不变"的情况：按 id/projectId 双键匹配，不应误报
  const oldEntries = [
    { id: 'a', projectId: 'P1' },
    { id: 'old-slug', projectId: 'P2' },
  ]
  const newEntries = [
    { id: 'a', projectId: 'P1' },
    { id: 'new-slug', projectId: 'P2' },
  ]
  assert.deepEqual(diffVanished(oldEntries, newEntries, []), {
    vanished: [],
    vanishedWithTranslations: [],
  })
})

test('一个条目消失且 manual 里有 langVersions 时，同时出现在 vanished 与 vanishedWithTranslations', () => {
  const oldEntries = [{ id: 'gone', projectId: 'P1' }]
  const newEntries = [{ id: 'kept', projectId: 'P2' }]
  const manualEntries = [
    { id: 'gone', modrinth: { projectId: 'P1' }, langVersions: [{ file: '/lang/gone/1/zh_CN.lang' }] },
  ]
  assert.deepEqual(diffVanished(oldEntries, newEntries, manualEntries), {
    vanished: ['gone'],
    vanishedWithTranslations: ['gone'],
  })
})

test('一个条目消失但 manual 里没有汉化时，只出现在 vanished', () => {
  const oldEntries = [{ id: 'gone', projectId: 'P1' }]
  const newEntries = [{ id: 'kept', projectId: 'P2' }]
  const manualEntries = [{ id: 'gone', modrinth: { projectId: 'P1' } }]
  assert.deepEqual(diffVanished(oldEntries, newEntries, manualEntries), {
    vanished: ['gone'],
    vanishedWithTranslations: [],
  })
})