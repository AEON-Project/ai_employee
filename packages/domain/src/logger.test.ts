import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let tmpRoot = ''
const origEnv = { ...process.env }

function loadFreshLogger() {
  // 强制重新 import，确保 env 变量被新的模块读取
  return import('./logger.js?ts=' + Date.now())
}

describe('logger', () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'aiemp-logger-'))
    process.env.AIEMP_DATA_DIR = tmpRoot
  })
  afterEach(() => {
    process.env = { ...origEnv }
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
  })

  test('info 写入 NDJSON', async () => {
    process.env.AIEMP_LOG_LEVEL = 'info'
    const { getLogger } = await loadFreshLogger()
    const log = getLogger('test')
    log.info('hello', { foo: 'bar' })
    const day = new Date().toISOString().slice(0, 10)
    const file = join(tmpRoot, 'logs', `${day}.log`)
    const content = readFileSync(file, 'utf8').trim().split('\n')
    const line = JSON.parse(content[content.length - 1]!)
    expect(line.level).toBe('info')
    expect(line.scope).toBe('test')
    expect(line.msg).toBe('hello')
    expect(line.foo).toBe('bar')
    expect(typeof line.ts).toBe('string')
  })

  test('debug 在 info 级别下不落盘', async () => {
    process.env.AIEMP_LOG_LEVEL = 'info'
    const { getLogger } = await loadFreshLogger()
    const log = getLogger('t')
    log.debug('should-not-write', {})
    log.info('should-write', {})
    const day = new Date().toISOString().slice(0, 10)
    const file = join(tmpRoot, 'logs', `${day}.log`)
    const content = readFileSync(file, 'utf8')
    expect(content).not.toContain('should-not-write')
    expect(content).toContain('should-write')
  })

  test('debug 在 debug 级别下落盘', async () => {
    process.env.AIEMP_LOG_LEVEL = 'debug'
    const { getLogger } = await loadFreshLogger()
    const log = getLogger('t')
    log.debug('keep', { x: 1 })
    const day = new Date().toISOString().slice(0, 10)
    const content = readFileSync(join(tmpRoot, 'logs', `${day}.log`), 'utf8')
    expect(content).toContain('keep')
  })

  test('secret 字段脱敏', async () => {
    process.env.AIEMP_LOG_LEVEL = 'info'
    const { getLogger } = await loadFreshLogger()
    const log = getLogger('t')
    log.info('m', {
      apiKey: 'sk-ant-fakefakefakefakefakefakefakefakefakefake1234',
      token: 'Bearer abcdefghijklmnop',
      keep: 'plain-value',
    })
    const day = new Date().toISOString().slice(0, 10)
    const content = readFileSync(join(tmpRoot, 'logs', `${day}.log`), 'utf8')
    expect(content).not.toContain('fakefakefake')
    expect(content).not.toContain('abcdefghijklmnop')
    expect(content).toContain('plain-value')
  })

  test('child logger 继承 scope', async () => {
    process.env.AIEMP_LOG_LEVEL = 'info'
    const { getLogger } = await loadFreshLogger()
    const log = getLogger('parent').child('sub')
    log.info('hi')
    const day = new Date().toISOString().slice(0, 10)
    const line = readFileSync(join(tmpRoot, 'logs', `${day}.log`), 'utf8')
      .trim()
      .split('\n')
      .pop()!
    expect(JSON.parse(line).scope).toBe('parent.sub')
  })
})
