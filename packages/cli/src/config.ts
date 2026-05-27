/**
 * ai-emp 配置加载。
 *
 * 配置来源优先级（高 → 低）：
 *   1. 环境变量（含 .env / .env.local；Bun 自动加载）
 *   2. ~/.ai-emp/config.toml（init 时落盘）
 *   3. 内置 DEFAULT_CONFIG
 *
 * 数据目录路径由 env `AIEMP_DATA_DIR` 覆盖，默认 `~/.ai-emp/`。
 * 全套支持的 env 见 `.env.example`。
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

export interface AiempConfig {
  server: {
    port: number
    localhostTokenRef: string
  }
  embedding: {
    model: string
    dim: number
  }
  telegram: {
    /** keychain 中存 bot token 的 key 名 */
    botTokenRef: string
    /** 白名单 chat id 数组 */
    allowedChatIds: number[]
  }
  defaults: {
    budget: {
      maxIterations: number
      maxTokens: number
      maxWallTimeMs: number
    }
  }
}

const DEFAULT_CONFIG: AiempConfig = {
  server: {
    port: 7878,
    localhostTokenRef: 'localhost-token',
  },
  embedding: {
    model: 'bge-small-zh-v1.5',
    dim: 512,
  },
  telegram: {
    botTokenRef: 'tg-bot-token',
    allowedChatIds: [],
  },
  defaults: {
    budget: {
      maxIterations: 30,
      maxTokens: 200000,
      maxWallTimeMs: 30 * 60 * 1000,
    },
  },
}

// ──────────────────────────────────────────────────────────────
// 目录与文件路径（dataDir 可由 env 覆盖；其余基于它派生）
// ──────────────────────────────────────────────────────────────

export function dataDir(): string {
  const fromEnv = process.env.AIEMP_DATA_DIR
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim())
  return join(homedir(), '.ai-emp')
}

export function configPath(): string {
  return join(dataDir(), 'config.toml')
}

export function attachmentsDir(): string {
  return join(dataDir(), 'attachments')
}

export function modelsDir(): string {
  return join(dataDir(), 'models')
}

export function logsDir(): string {
  return join(dataDir(), 'logs')
}

export function backupsDir(): string {
  return join(dataDir(), 'backups')
}

export function dbPath(): string {
  return join(dataDir(), 'db.sqlite')
}

export async function ensureDirs(): Promise<void> {
  for (const d of [dataDir(), attachmentsDir(), modelsDir(), logsDir(), backupsDir()]) {
    await mkdir(d, { recursive: true })
  }
}

// ──────────────────────────────────────────────────────────────
// 加载 / 保存
// ──────────────────────────────────────────────────────────────

export async function loadConfig(): Promise<AiempConfig> {
  // 1) 从默认深拷一份
  let cfg: AiempConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG))

  // 2) 叠加 config.toml（如有）
  if (existsSync(configPath())) {
    const raw = await readFile(configPath(), 'utf8')
    cfg = parseToml(raw)
  }

  // 3) env 覆盖（最高优先级；Bun 自动加载 .env / .env.local）
  applyEnv(cfg)

  return cfg
}

export async function saveConfig(cfg: AiempConfig): Promise<void> {
  await mkdir(dirname(configPath()), { recursive: true })
  await writeFile(configPath(), serializeToml(cfg), { mode: 0o600 })
}

/**
 * 从环境变量覆盖配置；支持以下 key（详见 .env.example）：
 *
 *   AIEMP_PORT
 *   AIEMP_LOCALHOST_TOKEN_REF
 *   AIEMP_EMBEDDING_MODEL
 *   AIEMP_EMBEDDING_DIM
 *   AIEMP_TG_BOT_TOKEN_REF
 *   AIEMP_TG_CHAT_IDS                  (逗号分隔；如 "12345,67890")
 *   AIEMP_BUDGET_MAX_ITERATIONS
 *   AIEMP_BUDGET_MAX_TOKENS
 *   AIEMP_BUDGET_MAX_WALL_TIME_MS
 *
 * 另外 AIEMP_DATA_DIR 不在 cfg 中，由 dataDir() 直接读。
 */
function applyEnv(cfg: AiempConfig): void {
  const e = process.env
  if (e.AIEMP_PORT) cfg.server.port = numOrThrow('AIEMP_PORT', e.AIEMP_PORT)
  if (e.AIEMP_LOCALHOST_TOKEN_REF) cfg.server.localhostTokenRef = e.AIEMP_LOCALHOST_TOKEN_REF

  if (e.AIEMP_EMBEDDING_MODEL) cfg.embedding.model = e.AIEMP_EMBEDDING_MODEL
  if (e.AIEMP_EMBEDDING_DIM) cfg.embedding.dim = numOrThrow('AIEMP_EMBEDDING_DIM', e.AIEMP_EMBEDDING_DIM)

  if (e.AIEMP_TG_BOT_TOKEN_REF) cfg.telegram.botTokenRef = e.AIEMP_TG_BOT_TOKEN_REF
  if (e.AIEMP_TG_CHAT_IDS) {
    cfg.telegram.allowedChatIds = e.AIEMP_TG_CHAT_IDS.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => numOrThrow('AIEMP_TG_CHAT_IDS', s))
  }

  if (e.AIEMP_BUDGET_MAX_ITERATIONS) {
    cfg.defaults.budget.maxIterations = numOrThrow(
      'AIEMP_BUDGET_MAX_ITERATIONS',
      e.AIEMP_BUDGET_MAX_ITERATIONS,
    )
  }
  if (e.AIEMP_BUDGET_MAX_TOKENS) {
    cfg.defaults.budget.maxTokens = numOrThrow('AIEMP_BUDGET_MAX_TOKENS', e.AIEMP_BUDGET_MAX_TOKENS)
  }
  if (e.AIEMP_BUDGET_MAX_WALL_TIME_MS) {
    cfg.defaults.budget.maxWallTimeMs = numOrThrow(
      'AIEMP_BUDGET_MAX_WALL_TIME_MS',
      e.AIEMP_BUDGET_MAX_WALL_TIME_MS,
    )
  }
}

function numOrThrow(name: string, raw: string): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`env ${name} 不是合法数字: ${raw}`)
  return n
}

// ──────────────────────────────────────────────────────────────
// 极简 TOML（只覆盖我们写的格式）
// ──────────────────────────────────────────────────────────────
function parseToml(text: string): AiempConfig {
  const cfg: AiempConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG))
  let section: string[] = []
  for (const lineRaw of text.split(/\r?\n/)) {
    const line = lineRaw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1).split('.')
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const val = parseValue(line.slice(eq + 1).trim())
    setDeep(cfg as unknown as Record<string, unknown>, [...section, key], val)
  }
  return cfg
}

function parseValue(s: string): unknown {
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1)
  if (s === 'true') return true
  if (s === 'false') return false
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(',').map((x) => parseValue(x.trim()))
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  return s
}

function setDeep(obj: Record<string, unknown>, path: string[], val: unknown): void {
  let cur = obj
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]!
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}
    cur = cur[k] as Record<string, unknown>
  }
  cur[path[path.length - 1]!] = val
}

function serializeToml(cfg: AiempConfig): string {
  const lines: string[] = []
  function emit(section: string, obj: Record<string, unknown>) {
    lines.push(`[${section}]`)
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        // 嵌套：发出子 section
      } else {
        lines.push(`${k} = ${formatVal(v)}`)
      }
    }
    lines.push('')
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        emit(`${section}.${k}`, v as Record<string, unknown>)
      }
    }
  }
  emit('server', cfg.server as unknown as Record<string, unknown>)
  emit('embedding', cfg.embedding as unknown as Record<string, unknown>)
  emit('telegram', cfg.telegram as unknown as Record<string, unknown>)
  emit('defaults', cfg.defaults as unknown as Record<string, unknown>)
  return lines.join('\n')
}

function formatVal(v: unknown): string {
  if (typeof v === 'string') return `"${v.replace(/"/g, '\\"')}"`
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.map(formatVal).join(', ')}]`
  return JSON.stringify(v)
}

export { DEFAULT_CONFIG }
