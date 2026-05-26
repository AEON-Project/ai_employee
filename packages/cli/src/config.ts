/**
 * ~/.ai-emp/config.toml 加载与写入。
 *
 * 简化 TOML 解析 / 序列化（仅支持我们用到的子集）：
 *   [section]
 *   key = "value"
 *   key = 1234
 *   key = [1, 2, 3]
 *   key = true
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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
  defaults: {
    budget: {
      maxIterations: 30,
      maxTokens: 200000,
      maxWallTimeMs: 30 * 60 * 1000,
    },
  },
}

export function dataDir(): string {
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

export async function loadConfig(): Promise<AiempConfig> {
  if (!existsSync(configPath())) return DEFAULT_CONFIG
  const raw = await readFile(configPath(), 'utf8')
  return parseToml(raw)
}

export async function saveConfig(cfg: AiempConfig): Promise<void> {
  await mkdir(dirname(configPath()), { recursive: true })
  await writeFile(configPath(), serializeToml(cfg), { mode: 0o600 })
}

// ── 极简 TOML（只覆盖我们写的格式） ───────────────────────────
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
