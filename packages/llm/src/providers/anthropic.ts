/**
 * Anthropic 原生 SDK adapter。
 *
 * 映射规则（与 Spike 3 一致）：
 *   message_start         → 仅取 usage.input_tokens 发一个 usage chunk
 *   content_block_start   → tool_use_start（text 块不发 chunk）
 *   content_block_delta   → text_delta / tool_use_delta（input_json_delta 累积）
 *   content_block_stop    → tool_use_stop（带 JSON.parse 完整 args）
 *   message_delta         → usage(output) + message_stop(reason)
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
  CreateClientOptions,
  LLMChunk,
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMToolSchema,
} from '../types.js'

export function createAnthropicClient(opts: CreateClientOptions): LLMClient {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    baseURL: opts.baseUrl,
  })

  async function* stream(req: LLMRequest): AsyncIterable<LLMChunk> {
    const body = buildBody(opts.model, req, opts.temperature, opts.maxTokens)
    let s
    try {
      // SDK 类型对 stream:true + 自定义 body 校验过严，adapter 自己负责形状正确
      s = (await client.messages.create({
        ...body,
        stream: true,
      } as never)) as unknown as AsyncIterable<Anthropic.MessageStreamEvent>
    } catch (err) {
      yield { type: 'error', error: classifyError(err) }
      return
    }

    type ToolBlock = { id: string; name: string; argsPartial: string }
    const toolBlocks = new Map<number, ToolBlock>()

    try {
      for await (const event of s) {
        switch (event.type) {
          case 'message_start': {
            const usage = event.message?.usage
            if (usage) {
              yield {
                type: 'usage',
                input: usage.input_tokens ?? 0,
                output: usage.output_tokens ?? 0,
                cached: usage.cache_read_input_tokens ?? undefined,
              }
            }
            break
          }
          case 'content_block_start': {
            const cb = event.content_block
            if (cb.type === 'tool_use') {
              toolBlocks.set(event.index, { id: cb.id, name: cb.name, argsPartial: '' })
              yield { type: 'tool_use_start', id: cb.id, name: cb.name }
            }
            break
          }
          case 'content_block_delta': {
            const d = event.delta
            if (d.type === 'text_delta') {
              yield { type: 'text_delta', text: d.text }
            } else if (d.type === 'input_json_delta') {
              const blk = toolBlocks.get(event.index)
              if (blk) {
                blk.argsPartial += d.partial_json
                yield {
                  type: 'tool_use_delta',
                  id: blk.id,
                  argsPartial: d.partial_json,
                }
              }
            } else if (d.type === 'thinking_delta') {
              yield { type: 'thinking_delta', text: d.thinking }
            }
            break
          }
          case 'content_block_stop': {
            const blk = toolBlocks.get(event.index)
            if (blk) {
              let args: unknown = null
              try {
                args = blk.argsPartial ? JSON.parse(blk.argsPartial) : {}
              } catch {
                /* args 留 null；调用方决定降级 */
              }
              yield { type: 'tool_use_stop', id: blk.id, name: blk.name, args }
            }
            break
          }
          case 'message_delta': {
            const u = event.usage
            if (u?.output_tokens) {
              yield { type: 'usage', input: 0, output: u.output_tokens }
            }
            const reason = event.delta?.stop_reason
            if (reason) {
              yield { type: 'message_stop', reason: mapAnthropicStop(reason) }
            }
            break
          }
          default:
          // ignore message_stop / ping / 等
        }
      }
    } catch (err) {
      yield { type: 'error', error: classifyError(err) }
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
    provider: 'anthropic',
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
  const body: Record<string, unknown> = {
    model,
    max_tokens: req.maxTokens ?? maxTokens ?? 4096,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
  }
  if (req.system) {
    body.system = buildSystemBlocks(req.system, req.cacheBreakpoints)
  }
  if (req.temperature ?? temperature !== undefined) {
    body.temperature = req.temperature ?? temperature
  }
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map(toAnthropicTool)
  }
  if (req.extra) Object.assign(body, req.extra)
  return body
}

/**
 * 把 system prompt 按 cacheBreakpoints 切成多段；前缀段标记 cache_control: ephemeral。
 * 没有断点 → 直接传字符串（最常见，Anthropic SDK 都接受）。
 */
function buildSystemBlocks(
  system: string,
  breakpoints?: number[],
): string | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[] {
  if (!breakpoints || breakpoints.length === 0) return system

  // 仅取第一个有效断点；超过 system.length 则忽略
  const bp = breakpoints[0]!
  if (bp <= 0 || bp >= system.length) return system

  const head = system.slice(0, bp)
  const tail = system.slice(bp)
  return [
    { type: 'text', text: head, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: tail },
  ]
}

function toAnthropicTool(t: LLMToolSchema) {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }
}

function mapAnthropicStop(reason: string): string {
  switch (reason) {
    case 'end_turn':
      return 'end_turn'
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
      return 'max_tokens'
    case 'stop_sequence':
      return 'stop_seq'
    default:
      return reason
  }
}

function classifyError(err: unknown): {
  message: string
  kind: 'rate_limit' | 'auth' | 'network' | 'server' | 'unknown'
  retryable: boolean
  raw: unknown
} {
  const msg = err instanceof Error ? err.message : String(err)
  // Anthropic 错误形态
  const e = err as { status?: number; error?: { type?: string } } | undefined
  if (e?.status === 429) return { message: msg, kind: 'rate_limit', retryable: true, raw: err }
  if (e?.status === 401 || e?.status === 403)
    return { message: msg, kind: 'auth', retryable: false, raw: err }
  if (e?.status && e.status >= 500)
    return { message: msg, kind: 'server', retryable: true, raw: err }
  if (msg.includes('fetch') || msg.includes('network'))
    return { message: msg, kind: 'network', retryable: true, raw: err }
  return { message: msg, kind: 'unknown', retryable: false, raw: err }
}
