/**
 * RuntimeServices — runtime 的依赖容器。
 *
 * 通过参数传入而非全局单例，便于：
 *   - 测试时注入 mock（mockLLM / mockKeychain）
 *   - 多实例隔离（理论上 V1.0 不会用，但保留可能性）
 */

import type { EventMap, TypedEventBus } from '@ai-emp/events'
import type { CredentialsRepo, Repos } from '@ai-emp/storage'
// services.ts 是 runtime 的依赖容器，跨 storage / events / 自定义 LLM/tool 抽象

/** LLM 客户端工厂 — 解耦 core 与 @ai-emp/llm 包，便于测试注入 fake */
export interface LLMFactory {
  /** runtime 给员工配置 + 解密后的 apiKey；返回标准 LLMClient */
  create(opts: {
    provider: 'anthropic' | 'openai-compat'
    model: string
    apiKey: string
    baseUrl?: string | undefined
    temperature?: number | undefined
    maxTokens?: number | undefined
  }): RuntimeLLMClient
}

/** runtime 层对 LLMClient 的最小契约（避免循环依赖 @ai-emp/llm） */
export interface RuntimeLLMClient {
  stream(req: RuntimeLLMRequest): AsyncIterable<RuntimeLLMChunk>
  complete(req: RuntimeLLMRequest): Promise<RuntimeLLMResponse>
}

export interface RuntimeLLMRequest {
  system?: string
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  tools?: {
    name: string
    description: string
    inputSchema: Record<string, unknown>
  }[]
  temperature?: number
  maxTokens?: number
  /** Prompt cache 断点（system 字节偏移） */
  cacheBreakpoints?: number[]
}

export type RuntimeLLMChunk =
  | { type: 'thinking_delta' | 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; argsPartial: string }
  | { type: 'tool_use_stop'; id: string; name: string; args: unknown }
  | { type: 'message_stop'; reason: string }
  | { type: 'usage'; input: number; output: number; cached?: number }
  | { type: 'error'; error: { message: string; kind: string; retryable: boolean } }

export interface RuntimeLLMResponse {
  text: string
  toolCalls: { id: string; name: string; args: unknown }[]
  stopReason: string
  usage?: { input: number; output: number; cached?: number }
}

/** Tool 注册表 / 执行器抽象（避免循环依赖 @ai-emp/tools） */
export interface RuntimeToolDef {
  name: string
  kind: 'system' | 'standard'
  description: string
  inputSchema: { safeParse(v: unknown): { success: boolean; data?: unknown; error?: unknown } } & {
    /** Zod schema → JSON Schema 的桥；adapter 层填充 */
    _jsonSchema?: Record<string, unknown>
  }
}

export interface RuntimeToolRegistry {
  get(name: string): RuntimeToolDef | undefined
  listFor(grantedNames: Iterable<string>): RuntimeToolDef[]
}

export interface RuntimeToolExecutor {
  invoke(
    call: { callId: string; name: string; args: unknown },
    ctx: { requirementId: string; employeeId: string; threadId: string; signal: AbortSignal },
    opts: { grantedNames: Iterable<string> },
  ): Promise<{ ok: boolean; value?: unknown; error?: { kind: string; message: string } }>
}

/** runtime 的统一依赖入口 */
export interface RuntimeServices {
  repos: Repos
  credentials: CredentialsRepo
  bus: TypedEventBus<EventMap>
  llm: LLMFactory
  toolRegistry: RuntimeToolRegistry
  toolExecutor: RuntimeToolExecutor
  /** V1.1: 已注册的所有 standard tool 名（file/shell 等）；默认对所有员工授权（单用户本地引擎，无沙箱） */
  standardToolNames?: string[]
  /** 调用方注入 tool 名 → JSON Schema 映射（给 LLM tools 用） */
  toolJsonSchema(name: string): Record<string, unknown> | undefined
  /** 可选：注入 memory 服务以启用 RAG；缺省走 minimal prompt */
  memory?: {
    embed(texts: string[]): Promise<Float32Array[]>
    sqlite: import('bun:sqlite').Database
  }
}
