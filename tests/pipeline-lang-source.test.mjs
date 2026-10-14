#!/usr/bin/env node
/**
 * scripts/lib/lang-source.mjs 语言源路径判定的离线单元测试。
 *
 * 覆盖 Modrinth（无外层目录）与 CurseForge（带外层目录）两种包结构，
 * 以及大小写、更深一层、shaders/lang 不相邻、后缀不精确等负例。
 * 不发任何网络请求。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isEnUsLangPath, isLangFilePath, isZhCNLangPath } from '../scripts/lib/lang-source.mjs'

describe('isEnUsLangPath 英文源路径判定', () => {
  it('匹配：无外层目录的两种大小写文件名', () => {
    assert.equal(isEnUsLangPath('shaders/lang/en_US.lang'), true)
    assert.equal(isEnUsLangPath('shaders/lang/en_us.lang'), true)
  })

  it('匹配：带一层/多层外层目录（CurseForge 包结构）', () => {
    assert.equal(isEnUsLangPath('SolisLite/shaders/lang/en_US.lang'), true)
    assert.equal(isEnUsLangPath('a/b/shaders/lang/en_us.lang'), true)
  })

  it('匹配：lang 段大小写不敏感', () => {
    assert.equal(isEnUsLangPath('shaders/LANG/en_US.lang'), true)
    assert.equal(isEnUsLangPath('SolisLite/SHADERS/Lang/en_us.lang'), true)
  })

  it('不匹配：zh_CN 与更深一层', () => {
    assert.equal(isEnUsLangPath('shaders/lang/zh_CN.lang'), false)
    assert.equal(isEnUsLangPath('shaders/lang/sub/en_US.lang'), false)
  })

  it('不匹配：shaders 与 lang 不相邻 / 缺少 shaders 段', () => {
    assert.equal(isEnUsLangPath('foo/shaders/x/lang/en_US.lang'), false)
    assert.equal(isEnUsLangPath('lang/en_US.lang'), false)
  })

  it('不匹配：文件名后缀不精确', () => {
    assert.equal(isEnUsLangPath('shaders/lang/en_US.lang.bak'), false)
  })
})

describe('isLangFilePath 语言文件通用判定', () => {
  it('匹配：无外层目录与带外层目录', () => {
    assert.equal(isLangFilePath('shaders/lang/zh_CN.lang'), true)
    assert.equal(isLangFilePath('shaders/lang/ru_RU.lang'), true)
    assert.equal(isLangFilePath('SolisLite/shaders/lang/en_US.lang'), true)
  })

  it('不匹配：更深一层 / 缺少 shaders 段 / 无文件名', () => {
    assert.equal(isLangFilePath('shaders/lang/sub/en_US.lang'), false)
    assert.equal(isLangFilePath('lang/en_US.lang'), false)
    assert.equal(isLangFilePath('shaders/lang'), false)
  })
})

describe('isZhCNLangPath 自带中文判定', () => {
  it('匹配：无外层目录与带外层目录，大小写不敏感', () => {
    assert.equal(isZhCNLangPath('shaders/lang/zh_CN.lang'), true)
    assert.equal(isZhCNLangPath('X/shaders/lang/zh_cn.lang'), true)
  })

  it('不匹配：英文源 / 更深一层', () => {
    assert.equal(isZhCNLangPath('shaders/lang/en_US.lang'), false)
    assert.equal(isZhCNLangPath('shaders/lang/sub/zh_CN.lang'), false)
  })
})