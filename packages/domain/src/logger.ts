/**
 * 结构化日志（NDJSON 文件 + stdout 镜像）— 单用户本地，不引外部依赖。
 *
 * 设计：
 *   - 一行一条 JSON：{ ts, level, scope, msg, ...kv }
 *   - 文件按天滚动：~/.ai-emp/logs/YYYY-MM-DD.log
 *   - 级别由 env AIEMP_LOG_LEVEL 控制：error / warn / info / debug（默认 info）
 *   - debug 才记 LLM prompt / SQL 详情；info 只记 audit
 *   - LLM key 脱敏（值若以 sk- 开头或长度 > 40 视为 secret，只保留前 6 + 后 4）
 *
 * 用法：
 *   const log = getLogger('runtime')
 *   log.info('llm.call.start', { reqId, model, msgCount })
 *   log.debug('llm.call.request', { messages, system })   // 仅 debug 级别落盘
 *   log.error('llm.call.failed', { reqId, error: err.message })
 *
 * 关闭：不需要 — 用 stdout 时 ai-emp 进程退出即可；文件 fd 由 Bun 兜底回收。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

const LEVELS: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }

function currentLevel(): LogLevel {
  const v = (process.env.AIEMP_LOG_LEVEL ?? 'info').toLowerCase() as LogLevel
  return v in LEVELS ? v : 'info'
}

function dataDir(): string {
  return process.env.AIEMP_DATA_DIR
    ? expandHome(process.env.AIEMP_DATA_DIR)
    : join(homedir(), '.ai-emp')
}
function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

function logPath(): string {
  const day = new Date().toISOString().slice(0, 10) // YYYY-MM-DD (UTC)
  return join(dataDir(), 'logs', `${day}.log`)
}

const ensuredDirs = new Set<string>()
function ensureLogDir(p: string) {
  const d = dirname(p)
  if (ensuredDirs.has(d)) return
  try {
    mkdirSync(d, { recursive: true })
    ensuredDirs.add(d)
  } catch {
    /* 写文件时再让它失败，不阻断业务 */
  }
}

/** secret 简单脱敏：sk-/Bearer 开头或长 > 40 的字符串只保留前 6 + 后 4 */
function redactValue(v: unknown): unknown {
  if (typeof v !== 'string') return v
  if (v.length > 40 || /^(sk-|Bearer\s)/i.test(v)) {
    return v.length <= 10 ? '***' : `${v.slice(0, 6)}…${v.slice(-4)}`
  }
  return v
}
function redactKV(kv: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(kv)) {
    if (/(api[_-]?key|token|secret|password|authorization)/i.test(k)) {
      out[k] = redactValue(v)
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redactKV(v as Record<string, unknown>)
    } else {
      out[k] = v
    }
  }
  return out
}

function writeLine(level: LogLevel, scope: string, msg: string, kv: Record<string, unknown>) {
  if (LEVELS[level] > LEVELS[currentLevel()]) return
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
    ...redactKV(kv),
  })
  // stdout 镜像（开发期方便）
  if (level === 'error') process.stderr.write(line + '\n')
  else process.stdout.write(line + '\n')

  // 文件持久化
  try {
    const p = logPath()
    ensureLogDir(p)
    appendFileSync(p, line + '\n')
  } catch {
    /* swallow — 日志失败不能影响业务 */
  }
}

export interface Logger {
  error(msg: string, kv?: Record<string, unknown>): void
  warn(msg: string, kv?: Record<string, unknown>): void
  info(msg: string, kv?: Record<string, unknown>): void
  debug(msg: string, kv?: Record<string, unknown>): void
  /** 子 logger，继承 scope 前缀 */
  child(subScope: string): Logger
}

export function getLogger(scope: string): Logger {
  return {
    error(msg, kv = {}) {
      writeLine('error', scope, msg, kv)
    },
    warn(msg, kv = {}) {
      writeLine('warn', scope, msg, kv)
    },
    info(msg, kv = {}) {
      writeLine('info', scope, msg, kv)
    },
    debug(msg, kv = {}) {
      writeLine('debug', scope, msg, kv)
    },
    child(sub) {
      return getLogger(`${scope}.${sub}`)
    },
  }
}

/** 仅测试 / 工具用：当前生效级别 */
export function getCurrentLevel(): LogLevel {
  return currentLevel()
}
