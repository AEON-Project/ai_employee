/**
 * config 加载优先级测试：env > toml > 默认。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dataDir, loadConfig, saveConfig, DEFAULT_CONFIG } from './config.js'

const ENV_KEYS = [
  'AIEMP_DATA_DIR',
  'AIEMP_PORT',
  'AIEMP_LOCALHOST_TOKEN_REF',
  'AIEMP_EMBEDDING_MODEL',
  'AIEMP_EMBEDDING_DIM',
  'AIEMP_TG_BOT_TOKEN_REF',
  'AIEMP_TG_CHAT_IDS',
  'AIEMP_BUDGET_MAX_ITERATIONS',
  'AIEMP_BUDGET_MAX_TOKENS',
  'AIEMP_BUDGET_MAX_WALL_TIME_MS',
]

let tmp: string
let snapshot: Record<string, string | undefined> = {}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'aiemp-cfg-'))
  snapshot = {}
  for (const k of ENV_KEYS) snapshot[k] = process.env[k]
  for (const k of ENV_KEYS) delete process.env[k]
  process.env.AIEMP_DATA_DIR = tmp
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = snapshot[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(tmp, { recursive: true, force: true })
})

describe('dataDir', () => {
  test('AIEMP_DATA_DIR 覆盖默认 ~/.ai-emp', () => {
    expect(dataDir()).toBe(tmp)
  })
})

describe('loadConfig', () => {
  test('无 toml 无 env → 默认值', async () => {
    const cfg = await loadConfig()
    expect(cfg.server.port).toBe(7878)
    expect(cfg.embedding.dim).toBe(512)
    expect(cfg.telegram.allowedChatIds).toEqual([])
    expect(cfg.defaults.budget.maxIterations).toBe(DEFAULT_CONFIG.defaults.budget.maxIterations)
  })

  test('toml 覆盖默认', async () => {
    await saveConfig({
      ...DEFAULT_CONFIG,
      server: { port: 9000, localhostTokenRef: 'tok' },
    })
    // 用 toml 路径加载
    const cfg = await loadConfig()
    expect(cfg.server.port).toBe(9000)
    expect(cfg.server.localhostTokenRef).toBe('tok')
  })

  test('env 覆盖 toml', async () => {
    await saveConfig({
      ...DEFAULT_CONFIG,
      server: { port: 9000, localhostTokenRef: 'from-toml' },
    })
    process.env.AIEMP_PORT = '8080'
    process.env.AIEMP_LOCALHOST_TOKEN_REF = 'from-env'

    const cfg = await loadConfig()
    expect(cfg.server.port).toBe(8080)
    expect(cfg.server.localhostTokenRef).toBe('from-env')
  })

  test('AIEMP_TG_CHAT_IDS 解析逗号列表', async () => {
    process.env.AIEMP_TG_CHAT_IDS = '111, 222 , 333'
    const cfg = await loadConfig()
    expect(cfg.telegram.allowedChatIds).toEqual([111, 222, 333])
  })

  test('AIEMP_TG_BOT_TOKEN_REF + 默认值', async () => {
    process.env.AIEMP_TG_BOT_TOKEN_REF = 'my-bot'
    const cfg = await loadConfig()
    expect(cfg.telegram.botTokenRef).toBe('my-bot')
  })

  test('Budget env 覆盖', async () => {
    process.env.AIEMP_BUDGET_MAX_ITERATIONS = '50'
    process.env.AIEMP_BUDGET_MAX_TOKENS = '500000'
    process.env.AIEMP_BUDGET_MAX_WALL_TIME_MS = '60000'
    const cfg = await loadConfig()
    expect(cfg.defaults.budget.maxIterations).toBe(50)
    expect(cfg.defaults.budget.maxTokens).toBe(500000)
    expect(cfg.defaults.budget.maxWallTimeMs).toBe(60000)
  })

  test('非法数字 env 抛错', async () => {
    process.env.AIEMP_PORT = 'abc'
    await expect(loadConfig()).rejects.toThrow(/AIEMP_PORT/)
  })
})

describe('saveConfig + loadConfig round-trip', () => {
  test('保留 telegram 字段', async () => {
    await saveConfig({
      ...DEFAULT_CONFIG,
      telegram: { botTokenRef: 'tg', allowedChatIds: [42, 99] },
    })
    const cfg = await loadConfig()
    expect(cfg.telegram.botTokenRef).toBe('tg')
    expect(cfg.telegram.allowedChatIds).toEqual([42, 99])
  })
})
