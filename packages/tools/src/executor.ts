/**
 * ToolExecutor — 普通 tool 执行的三道闸 + 指数退避超时重试。
 *
 * 系统级 tool 不经此通道，由 runtime dispatcher 直接处理。
 */

import type { ToolRegistry } from './registry.js'
import type { ToolCall, ToolContext, ToolDef, ToolError, ToolResult } from './types.js'

export interface ExecuteOptions {
  /** 员工已授权 tool 名集合（普通 tool 鉴权用） */
  grantedNames: Iterable<string>
  /** 总超时（含重试）；不传按 tool.timeoutMs */
  timeoutMs?: number
  /** 退避序列（ms）；默认 [30000, 60000, 120000] = 3 次（首次 + 2 次重试） */
  backoffMs?: number[]
}

const DEFAULT_BACKOFF = [30_000, 60_000, 120_000]
const DEFAULT_TIMEOUT = 30_000

export class ToolExecutor {
  constructor(private readonly registry: ToolRegistry) {}

  async invoke(call: ToolCall, ctx: ToolContext, opts: ExecuteOptions): Promise<ToolResult> {
    const def = this.registry.get(call.name)
    if (!def) {
      return fail('unknown_tool', `tool not found: ${call.name}`)
    }

    // 系统级 tool 不应进 executor
    if (def.kind === 'system') {
      return fail(
        'invoke_failed',
        `system tool ${call.name} must be dispatched by runtime, not executor`,
      )
    }

    // ① 权限
    const granted = new Set(opts.grantedNames)
    if (!granted.has(def.name)) {
      return fail('unauthorized', `tool ${def.name} not granted to employee`)
    }

    // ② Schema 校验
    const parsed = def.inputSchema.safeParse(call.args)
    if (!parsed.success) {
      return fail('invalid_args', `args invalid for ${def.name}`, parsed.error)
    }

    // ③ 超时 + 退避重试
    const backoff = opts.backoffMs ?? DEFAULT_BACKOFF
    const perAttemptTimeout = def.timeoutMs ?? opts.timeoutMs ?? DEFAULT_TIMEOUT
    let lastError: ToolError | undefined
    for (let attempt = 0; attempt < backoff.length; attempt++) {
      const timeoutMs = backoff[attempt] ?? perAttemptTimeout
      const r = await this.runOnce(def, parsed.data, ctx, timeoutMs)
      if (r.ok) return { ...r, retries: attempt }
      lastError = r.error
      // timeout 与 invoke_failed 可重试；其他直接退出（理论上前两道闸已过）
      if (r.error?.kind !== 'timeout' && r.error?.kind !== 'invoke_failed') {
        return { ...r, retries: attempt }
      }
    }
    return {
      ok: false,
      error: lastError ?? {
        kind: 'invoke_failed',
        message: `tool ${def.name} failed after retries`,
      },
      retries: backoff.length - 1,
    }
  }

  private async runOnce(
    def: ToolDef,
    args: unknown,
    parentCtx: ToolContext,
    timeoutMs: number,
  ): Promise<ToolResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const ctx: ToolContext = { ...parentCtx, signal: controller.signal }
    try {
      const value = await def.invoke(args, ctx)
      return { ok: true, value }
    } catch (err) {
      if (controller.signal.aborted) {
        return fail('timeout', `tool ${def.name} timed out after ${timeoutMs}ms`)
      }
      const msg = err instanceof Error ? err.message : String(err)
      return fail('invoke_failed', msg, err)
    } finally {
      clearTimeout(timer)
    }
  }
}

function fail(kind: ToolError['kind'], message: string, raw?: unknown): ToolResult {
  return { ok: false, error: { kind, message, raw } }
}
