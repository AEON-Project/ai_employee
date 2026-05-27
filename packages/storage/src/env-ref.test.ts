import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { isEnvRef, resolveEnvRef, resolveEnvRefStrict } from './env-ref.js'

const KEY = '__AIEMP_TEST_ENVREF_KEY__'

beforeEach(() => {
  delete process.env[KEY]
})
afterEach(() => {
  delete process.env[KEY]
})

describe('isEnvRef', () => {
  test('env:// 前缀返回 true', () => {
    expect(isEnvRef('env://FOO')).toBe(true)
    expect(isEnvRef('env://')).toBe(true) // 空 name 也是 ref（resolve 会失败）
  })
  test('其他字符串返回 false', () => {
    expect(isEnvRef('FOO')).toBe(false)
    expect(isEnvRef('claude-main')).toBe(false)
    expect(isEnvRef('')).toBe(false)
    expect(isEnvRef(null)).toBe(false)
    expect(isEnvRef(undefined)).toBe(false)
  })
})

describe('resolveEnvRef（宽松版）', () => {
  test('非引用直接返回原值', () => {
    expect(resolveEnvRef('plain')).toBe('plain')
    expect(resolveEnvRef('https://api.openai.com/v1')).toBe('https://api.openai.com/v1')
  })
  test('null / undefined / 空串返回 null', () => {
    expect(resolveEnvRef(null)).toBeNull()
    expect(resolveEnvRef(undefined)).toBeNull()
    expect(resolveEnvRef('')).toBeNull()
  })
  test('env:// 引用 + env 存在 → 返回 env 值', () => {
    process.env[KEY] = 'resolved-value'
    expect(resolveEnvRef(`env://${KEY}`)).toBe('resolved-value')
  })
  test('env:// 引用 + env 不存在 → 返回 null', () => {
    expect(resolveEnvRef(`env://${KEY}`)).toBeNull()
  })
  test('env:// 引用 + env 空串 → 返回 null', () => {
    process.env[KEY] = ''
    expect(resolveEnvRef(`env://${KEY}`)).toBeNull()
  })
})

describe('resolveEnvRefStrict（严格版）', () => {
  test('非引用直接返回原值', () => {
    expect(resolveEnvRefStrict('plain-value', 'field')).toBe('plain-value')
  })
  test('env:// + 存在 → 返回值', () => {
    process.env[KEY] = 'X'
    expect(resolveEnvRefStrict(`env://${KEY}`, 'modelName')).toBe('X')
  })
  test('env:// + 不存在 → 抛错（含 env 名 + label）', () => {
    expect(() => resolveEnvRefStrict(`env://${KEY}`, 'modelName')).toThrow(/modelName/)
    expect(() => resolveEnvRefStrict(`env://${KEY}`, 'modelName')).toThrow(KEY)
  })
})
