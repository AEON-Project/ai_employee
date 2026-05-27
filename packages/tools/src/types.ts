/**
 * Tool 系统类型契约。
 *
 * 系统级 tool（advance_step/update_plan/emit_deliverable/ask_user）由 runtime
 * dispatcher 直接处理，**不进 ToolExecutor 三道闸**（它们驱动状态机，无外部副作用）。
 *
 * 普通 tool（web_search/read_file/write_file/...）走 ToolExecutor：
 *   ① 权限校验 — call.name 必须在 registry.listFor(employee) 内
 *   ② Schema 校验 — call.args 通过 inputSchema（Zod）
 *   ③ 超时重试 — AbortController + 指数退避 30s/60s/120s
 */

import type { z } from 'zod'
import type { EmployeeId, RequirementId, ThreadId } from '@ai-emp/domain'

export const TOOL_KINDS = ['system', 'standard'] as const
export type ToolKind = (typeof TOOL_KINDS)[number]

/** 内置 + 用户定义都用这套结构 */
export interface ToolDef<I = unknown, O = unknown> {
  /** 注册键 + LLM 看到的 name */
  name: string
  description: string
  /** 系统级 tool 不进 ToolExecutor */
  kind: ToolKind
  /** zod schema；ToolExecutor 用它校验 args */
  inputSchema: z.ZodType<I>
  /** JSON Schema 形式的 input schema，给 LLM provider tool_use schema 用（zod 不直接给 LLM）
   *  系统级 tool 必填（不写 LLM 会瞎 build args）；普通 tool 可选（无则用最小通用 schema） */
  inputJsonSchema?: Record<string, unknown>
  /** 输出 schema（可选，给文档化与未来类型化客户端用） */
  outputSchema?: z.ZodType<O>
  /** 实际执行函数；系统级 tool 这里通常是 noop（runtime 自己处理） */
  invoke: (args: I, ctx: ToolContext) => Promise<O>
  /** 超时（ms）；不传走全局默认 30000 */
  timeoutMs?: number
}

export interface ToolContext {
  requirementId: RequirementId
  employeeId: EmployeeId
  threadId: ThreadId
  /** runtime 自身实现，tool 可用 ctx.emit() 主动发事件（很少用） */
  signal: AbortSignal
}

/** LLM 流式输出的 tool_use_stop → 引擎 dispatch 之前的形态 */
export interface ToolCall {
  callId: string
  name: string
  args: unknown
}

export interface ToolResult<T = unknown> {
  ok: boolean
  value?: T
  error?: ToolError
  /** 重试次数（最终成功也保留，便于审计） */
  retries?: number
}

export interface ToolError {
  /** 'unauthorized' | 'invalid_args' | 'timeout' | 'invoke_failed' */
  kind: 'unauthorized' | 'invalid_args' | 'timeout' | 'invoke_failed' | 'unknown_tool'
  message: string
  /** 原始错误（如 Zod issues） */
  raw?: unknown
}
