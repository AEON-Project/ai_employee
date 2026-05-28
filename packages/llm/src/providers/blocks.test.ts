/**
 * V2 P0 bug 4 回归：两个 provider 都能把 LLMContentBlock IR 翻译成各自原生协议。
 *
 * Anthropic：tool_call → {type:'tool_use', id, name, input}；tool_result → {type:'tool_result', tool_use_id, content}
 * OpenAI:    tool_call → assistant.tool_calls[i] = {id, type:'function', function:{name,arguments}}；
 *            tool_result → 独立 {role:'tool', tool_call_id, content} message
 */
import { describe, expect, test } from 'bun:test'
import type OpenAI from 'openai'
import { toAnthropicMessage } from './anthropic.js'
import { appendOpenAIMessages } from './openai-compat.js'
import type { LLMMessage } from '../types.js'

describe('Anthropic: LLMContentBlock → Anthropic content blocks', () => {
  test('tool_call IR → {type:"tool_use", id, name, input}', () => {
    const msg: LLMMessage = {
      role: 'assistant',
      content: [{ type: 'tool_call', callId: 'tu_1', name: 'Bash', args: { command: 'ls' } }],
    }
    const out = toAnthropicMessage(msg)
    expect(out.role).toBe('assistant')
    expect(Array.isArray(out.content)).toBe(true)
    const blocks = out.content as Array<{
      type: string
      id?: string
      name?: string
      input?: { command: string }
    }>
    expect(blocks[0]).toEqual({
      type: 'tool_use',
      id: 'tu_1',
      name: 'Bash',
      input: { command: 'ls' },
    })
  })

  test('tool_result IR → {type:"tool_result", tool_use_id, content}', () => {
    const msg: LLMMessage = {
      role: 'user',
      content: [{ type: 'tool_result', callId: 'tu_1', output: 'exitCode=0\nstdout:\nhello' }],
    }
    const out = toAnthropicMessage(msg)
    const blocks = out.content as Array<{
      type: string
      tool_use_id?: string
      content?: string
      is_error?: boolean
    }>
    expect(blocks[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: 'exitCode=0\nstdout:\nhello',
    })
  })

  test('tool_result.isError → is_error:true', () => {
    const msg: LLMMessage = {
      role: 'user',
      content: [
        { type: 'tool_result', callId: 'tu_2', output: 'permission denied', isError: true },
      ],
    }
    const out = toAnthropicMessage(msg)
    const block = (out.content as Array<{ is_error?: boolean }>)[0]
    expect(block!.is_error).toBe(true)
  })

  test('字符串 content 向后兼容', () => {
    const msg: LLMMessage = { role: 'user', content: 'plain text' }
    const out = toAnthropicMessage(msg)
    expect(out.content).toBe('plain text')
  })
})

describe('OpenAI: LLMContentBlock → OpenAI chat messages', () => {
  test('assistant tool_call IR → message-level tool_calls 字段', () => {
    const out: OpenAI.Chat.ChatCompletionMessageParam[] = []
    appendOpenAIMessages(out, {
      role: 'assistant',
      content: [{ type: 'tool_call', callId: 'call_1', name: 'Bash', args: { command: 'ls' } }],
    })
    expect(out).toHaveLength(1)
    const m = out[0] as OpenAI.Chat.ChatCompletionAssistantMessageParam
    expect(m.role).toBe('assistant')
    expect(m.content).toBeNull()
    expect(m.tool_calls).toHaveLength(1)
    expect(m.tool_calls![0]).toEqual({
      id: 'call_1',
      type: 'function',
      function: { name: 'Bash', arguments: JSON.stringify({ command: 'ls' }) },
    })
  })

  test('tool_result IR → 独立 {role:"tool", tool_call_id, content} message（不是 user role）', () => {
    const out: OpenAI.Chat.ChatCompletionMessageParam[] = []
    appendOpenAIMessages(out, {
      role: 'user',
      content: [{ type: 'tool_result', callId: 'call_1', output: 'exitCode=0\nstdout: hello' }],
    })
    expect(out).toHaveLength(1)
    const m = out[0] as OpenAI.Chat.ChatCompletionToolMessageParam
    expect(m.role).toBe('tool')
    expect(m.tool_call_id).toBe('call_1')
    expect(m.content).toBe('exitCode=0\nstdout: hello')
  })

  test('assistant 同时有 text + tool_call → 合并到一条 message', () => {
    const out: OpenAI.Chat.ChatCompletionMessageParam[] = []
    appendOpenAIMessages(out, {
      role: 'assistant',
      content: [
        { type: 'text', text: '我来查一下' },
        { type: 'tool_call', callId: 'call_x', name: 'Bash', args: {} },
      ],
    })
    expect(out).toHaveLength(1)
    const m = out[0] as OpenAI.Chat.ChatCompletionAssistantMessageParam
    expect(m.content).toBe('我来查一下')
    expect(m.tool_calls).toHaveLength(1)
    expect(m.tool_calls![0]!.id).toBe('call_x')
  })

  test('字符串 content 向后兼容', () => {
    const out: OpenAI.Chat.ChatCompletionMessageParam[] = []
    appendOpenAIMessages(out, { role: 'user', content: 'plain text' })
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ role: 'user', content: 'plain text' })
  })
})
