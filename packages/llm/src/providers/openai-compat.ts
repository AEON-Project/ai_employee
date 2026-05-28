/**
 * OpenAI 兼容 SDK adapter（同时覆盖 OpenAI 原生 / DeepSeek / 智谱 / Kimi / 等）。
 *
 * 协议差异处理（与 Spike 3 一致）：
 *   - 仅 `data:` 行 + `[DONE]` 哨兵
 *   - tool_calls 增量通过 `index` 字段拼接；arguments 是字符串 partial
 *   - finish_reason='tool_calls' 时关闭所有未关闭的 tool block 并 emit message_stop
 */

import OpenAI from 'openai'
import type {
  CreateClientOptions,
  LLMChunk,
  LLMClient,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  LLMToolSchema,
} from '../types.js'

export function createOpenAICompatClient(opts: CreateClientOptions): LLMClient {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseUrl,
  })

  async function* stream(req: LLMRequest): AsyncIterable<LLMChunk> {
    const body = buildBody(opts.model, req, opts.temperature, opts.maxTokens)
    let s
    try {
      s = (await client.chat.completions.create({
        ...body,
        stream: true,
      } as never)) as unknown as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>
    } catch (err) {
      yield { type: 'error', error: classifyError(err) }
      return
    }

    type ToolBlock = { id: string; name: string; argsPartial: string; started: boolean }
    const toolBlocks = new Map<number, ToolBlock>()
    let stopReason: string | null = null
    let usageEmitted = false

    try {
      for await (const chunk of s) {
        const choice = chunk.choices?.[0]
        if (!choice) {
          // 尾包：usage 等
          const u = (chunk as { usage?: { prompt_tokens?: number; completion_tokens?: number } })
            .usage
          if (u && !usageEmitted) {
            yield {
              type: 'usage',
              input: u.prompt_tokens ?? 0,
              output: u.completion_tokens ?? 0,
            }
            usageEmitted = true
          }
          continue
        }
        const delta = choice.delta

        if (delta?.content) {
          yield { type: 'text_delta', text: delta.content }
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            let blk = toolBlocks.get(idx)
            if (!blk) {
              blk = {
                id: tc.id ?? '',
                name: tc.function?.name ?? '',
                argsPartial: '',
                started: false,
              }
              toolBlocks.set(idx, blk)
            }
            if (tc.id && !blk.id) blk.id = tc.id
            if (tc.function?.name && !blk.name) blk.name = tc.function.name
            if (!blk.started && blk.id && blk.name) {
              blk.started = true
              yield { type: 'tool_use_start', id: blk.id, name: blk.name }
            }
            if (tc.function?.arguments) {
              blk.argsPartial += tc.function.arguments
              yield {
                type: 'tool_use_delta',
                id: blk.id,
                argsPartial: tc.function.arguments,
              }
            }
          }
        }

        if (choice.finish_reason) {
          stopReason = choice.finish_reason
        }
      }
    } catch (err) {
      yield { type: 'error', error: classifyError(err) }
      return
    }

    // 关闭所有 tool blocks
    for (const blk of toolBlocks.values()) {
      let args: unknown = null
      try {
        args = blk.argsPartial ? JSON.parse(blk.argsPartial) : {}
      } catch {
        /* args 留 null */
      }
      yield { type: 'tool_use_stop', id: blk.id, name: blk.name, args }
    }
    if (stopReason) {
      yield { type: 'message_stop', reason: mapOpenAIStop(stopReason) }
    }
  }

  async function complete(req: LLMRequest): Promise<LLMResponse> {
    let text = ''
    const toolCalls: { id: string; name: string; args: unknown }[] = []
    let stopReason: string = 'end_turn'
    let usage: LLMResponse['usage']

    for await (const c of stream(req)) {
      switch (c.type) {
        case 'text_delta':
          text += c.text
          break
        case 'tool_use_stop':
          toolCalls.push({ id: c.id, name: c.name, args: c.args })
          break
        case 'message_stop':
          stopReason = c.reason
          break
        case 'usage':
          usage = usage
            ? {
                input: usage.input + c.input,
                output: usage.output + c.output,
                cached: (usage.cached ?? 0) + (c.cached ?? 0) || undefined,
              }
            : { input: c.input, output: c.output, cached: c.cached }
          break
        case 'error':
          throw new Error(c.error.message)
      }
    }

    return { text, toolCalls, stopReason, usage } as LLMResponse
  }

  return {
    provider: 'openai-compat',
    model: opts.model,
    stream,
    complete,
  }
}

function buildBody(
  model: string,
  req: LLMRequest,
  temperature: number | undefined,
  maxTokens: number | undefined,
) {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = []
  if (req.system) messages.push({ role: 'system', content: req.system })
  // V2 P0 bug 6 修复：OpenAI 协议要求 `role:'tool'` message 必须紧跟一个含 tool_calls
  // 的 assistant message。composer 截 chat history 窗口可能切走对应 tool_call，
  // 留下 orphan tool_result → API 报 400 Invalid parameter。
  // 追踪本轮已发出的 tool_call ID，遇 orphan tool_result 改写成 user 文本而不发 role:'tool'。
  const knownToolCallIds = new Set<string>()
  for (const m of req.messages) {
    appendOpenAIMessages(messages, m, knownToolCallIds)
  }
  const body: Record<string, unknown> = {
    model,
    messages,
  }
  if (req.maxTokens ?? maxTokens) {
    body.max_tokens = req.maxTokens ?? maxTokens
  }
  if (req.temperature ?? temperature !== undefined) {
    body.temperature = req.temperature ?? temperature
  }
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map(toOpenAITool)
    body.tool_choice = 'auto'
  }
  if (req.extra) Object.assign(body, req.extra)
  return body
}

/**
 * 把 LLMMessage 翻译成 OpenAI chat completion messages（可能产生多条）：
 *   - content: string → 单条 { role, content }
 *   - content: LLMContentBlock[] →
 *       同一 assistant 的 text/tool_call 合并到一条 { role:'assistant', content, tool_calls }
 *       每个 tool_result 单独输出一条 { role:'tool', tool_call_id, content }
 *       user 的 text blocks 合并成 content 字符串
 *
 * OpenAI 协议关键点：
 *   - tool result 必须用 role:'tool' + tool_call_id（不能像 Anthropic 那样塞在 user 里）
 *   - assistant 的 tool_calls 是 message-level 字段，不是 content array 元素
 */
/** Exported for unit tests; do not depend on this from outside the llm package. */
export function appendOpenAIMessages(
  out: OpenAI.Chat.ChatCompletionMessageParam[],
  m: LLMMessage,
  knownToolCallIds?: Set<string>,
): void {
  if (typeof m.content === 'string') {
    out.push({ role: m.role, content: m.content } as OpenAI.Chat.ChatCompletionMessageParam)
    return
  }
  if (m.role === 'assistant') {
    const textParts: string[] = []
    const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = []
    for (const b of m.content) {
      if (b.type === 'text') {
        textParts.push(b.text)
      } else if (b.type === 'tool_call') {
        toolCalls.push({
          id: b.callId,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.args ?? {}) },
        })
        knownToolCallIds?.add(b.callId)
      }
      // tool_result 不应在 assistant 里出现；忽略
    }
    const msg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
      role: 'assistant',
      // OpenAI 要求 assistant 至少有 content 或 tool_calls 之一；text 为空则 null
      content: textParts.length > 0 ? textParts.join('\n') : null,
    }
    if (toolCalls.length > 0) msg.tool_calls = toolCalls
    // 仅当至少一者存在才输出，避免空 message
    if (msg.content !== null || (msg.tool_calls && msg.tool_calls.length > 0)) {
      out.push(msg)
    }
    return
  }
  // user role：tool_result blocks 拆成独立 role:'tool' messages，text blocks 合并
  const textParts: string[] = []
  for (const b of m.content) {
    if (b.type === 'tool_result') {
      // V2 P0 bug 6：orphan tool_result（窗口切断对应 tool_call）→ 转 user 文本，避免协议错误
      if (knownToolCallIds && !knownToolCallIds.has(b.callId)) {
        textParts.push(`[tool_result of ${b.callId.slice(0, 16)}]\n${b.output}`)
        continue
      }
      out.push({
        role: 'tool',
        tool_call_id: b.callId,
        content: b.output,
      } as OpenAI.Chat.ChatCompletionToolMessageParam)
    } else if (b.type === 'text') {
      textParts.push(b.text)
    }
    // tool_call 不应在 user 里出现；忽略
  }
  if (textParts.length > 0) {
    out.push({ role: 'user', content: textParts.join('\n') })
  }
}

function toOpenAITool(t: LLMToolSchema): OpenAI.Chat.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }
}

function mapOpenAIStop(reason: string): string {
  switch (reason) {
    case 'stop':
      return 'end_turn'
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'content_filter':
      return 'stop_seq'
    default:
      return reason
  }
}

function classifyError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err)
  const e = err as { status?: number } | undefined
  if (e?.status === 429)
    return { message: msg, kind: 'rate_limit' as const, retryable: true, raw: err }
  if (e?.status === 401 || e?.status === 403)
    return { message: msg, kind: 'auth' as const, retryable: false, raw: err }
  if (e?.status && e.status >= 500)
    return { message: msg, kind: 'server' as const, retryable: true, raw: err }
  if (msg.includes('fetch') || msg.includes('network'))
    return { message: msg, kind: 'network' as const, retryable: true, raw: err }
  return { message: msg, kind: 'unknown' as const, retryable: false, raw: err }
}
