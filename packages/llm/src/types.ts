/**
 * LLM 层统一类型契约 — 屏蔽 Anthropic / OpenAI 协议差异。
 * 已在 Spike 3 中验证两个 provider 都能映射到这一抽象。
 */

import type { ModelConfig } from '@ai-emp/domain'

// ──────────────────────────────────────────────────────────────
// 流式 chunk（adapter 输出）
// ──────────────────────────────────────────────────────────────
export type LLMChunk =
  | { type: 'thinking_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; argsPartial: string }
  | { type: 'tool_use_stop'; id: string; name: string; args: unknown }
  | {
      type: 'message_stop'
      reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_seq' | string
    }
  | { type: 'usage'; input: number; output: number; cached?: number }
  | { type: 'error'; error: LLMError }

export interface LLMError {
  message: string
  /** 'rate_limit' | 'auth' | 'network' | 'server' | 'unknown' */
  kind: 'rate_limit' | 'auth' | 'network' | 'server' | 'unknown'
  retryable: boolean
  raw?: unknown
}

// ──────────────────────────────────────────────────────────────
// 工具 schema（用于 tool_use）
// ──────────────────────────────────────────────────────────────
export interface LLMToolSchema {
  /** LLM 看到的 tool name */
  name: string
  description: string
  /** JSON Schema（已由调用方从 Zod 转换） */
  inputSchema: Record<string, unknown>
}

// ──────────────────────────────────────────────────────────────
// 请求体（adapter 输入）
// ──────────────────────────────────────────────────────────────
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LLMRequest {
  /** system prompt 单独提取；其他对话走 messages */
  system?: string
  messages: LLMMessage[]
  tools?: LLMToolSchema[]
  temperature?: number
  maxTokens?: number
  /**
   * Prompt cache 断点 — system 字符串中的字节偏移。
   * Anthropic adapter 把 system 在断点处切分为多段并打上 cache_control:ephemeral；
   * OpenAI 兼容协议自动 prefix cache，断点信息会被忽略。
   */
  cacheBreakpoints?: number[]
  /** 透传 stop_sequences 等少量原生参数 */
  extra?: Record<string, unknown>
}

export interface LLMResponse {
  /** 非流式响应的纯文本（不含 tool_use） */
  text: string
  /** 模型选择调用的工具，按顺序 */
  toolCalls: { id: string; name: string; args: unknown }[]
  /** 终止原因（统一映射） */
  stopReason: LLMChunk extends { type: 'message_stop' }
    ? (LLMChunk & { type: 'message_stop' })['reason']
    : string
  usage?: { input: number; output: number; cached?: number }
}

// ──────────────────────────────────────────────────────────────
// Client 接口
// ──────────────────────────────────────────────────────────────
export interface LLMClient {
  readonly provider: ModelConfig['provider']
  readonly model: string
  /** 流式：消费方按 LLMChunk 增量处理 */
  stream(req: LLMRequest): AsyncIterable<LLMChunk>
  /** 非流式：澄清卡片等同步场景；底层仍可能跑 stream 后聚合 */
  complete(req: LLMRequest): Promise<LLMResponse>
}

export interface CreateClientOptions extends ModelConfig {
  /** 真实运行时由 storage 注入；测试可直接传 apiKey 字符串 */
  apiKey: string
}
