/**
 * LLM adapter 集成测试 — mock SSE server，双 provider 覆盖。
 * 与 Spike 3 验证的 LLMChunk 流一致；新增：complete() 聚合验证。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createLLMClient } from './index.js'
import type { LLMChunk } from './types.js'

// ── Mock SSE server ──────────────────────────────────────────
function anthropicEvents() {
  return [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_01ABC',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-opus-4-7',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 50, output_tokens: 0 },
        },
      },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    },
    {
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: ' there' },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'ask_user', input: {} },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"questions":' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '[{"q":"x"}]}' },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 1 },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 17 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]
}

function openaiEvents() {
  const base = { id: 'cc-1', object: 'chat.completion.chunk', created: 0, model: 'gpt-4o' }
  return [
    {
      data: {
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      },
    },
    {
      data: { ...base, choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] },
    },
    {
      data: { ...base, choices: [{ index: 0, delta: { content: ' there' }, finish_reason: null }] },
    },
    {
      data: {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'ask_user', arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
    },
    {
      data: {
        ...base,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"questions":' } }] },
            finish_reason: null,
          },
        ],
      },
    },
    {
      data: {
        ...base,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '[{"q":"x"}]}' } }] },
            finish_reason: null,
          },
        ],
      },
    },
    { data: { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] } },
    { data: '[DONE]' },
  ]
}

function sseStream(events: { event?: string; data: unknown }[]) {
  return new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const enc = new TextEncoder()
      for (const e of events) {
        const block: string[] = []
        if (e.event) block.push(`event: ${e.event}`)
        block.push(`data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}`)
        block.push('', '')
        ctrl.enqueue(enc.encode(block.join('\n')))
        await Bun.sleep(2)
      }
      ctrl.close()
    },
  })
}

let server: ReturnType<typeof Bun.serve> | null = null
let baseURL = ''
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/anthropic/v1/messages') {
        return new Response(sseStream(anthropicEvents()), {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      if (url.pathname === '/openai/v1/chat/completions') {
        return new Response(sseStream(openaiEvents()), {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return new Response('not found', { status: 404 })
    },
  })
  baseURL = `http://localhost:${server.port}`
})
afterAll(() => {
  server?.stop()
})

// ── 通用断言 ────────────────────────────────────────────────
function assertCommon(chunks: LLMChunk[]) {
  // 至少有 text_delta、tool_use_start、tool_use_stop、message_stop
  expect(chunks.some((c) => c.type === 'text_delta')).toBe(true)
  expect(chunks.some((c) => c.type === 'tool_use_start')).toBe(true)
  const stop = chunks.find((c) => c.type === 'tool_use_stop')! as Extract<
    LLMChunk,
    { type: 'tool_use_stop' }
  >
  expect(stop.name).toBe('ask_user')
  expect((stop.args as { questions: unknown[] }).questions).toHaveLength(1)
  const fin = chunks.find((c) => c.type === 'message_stop')! as Extract<
    LLMChunk,
    { type: 'message_stop' }
  >
  expect(fin.reason).toBe('tool_use')
}

// ── 测试 ───────────────────────────────────────────────────
describe('Anthropic adapter', () => {
  test('stream() 产出标准 LLMChunk 序列', async () => {
    const client = createLLMClient({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      baseUrl: `${baseURL}/anthropic`,
      apiKey: 'mock',
      keyRef: 'mock',
    })
    const chunks: LLMChunk[] = []
    for await (const c of client.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(c)
    }
    assertCommon(chunks)
  })

  test('complete() 聚合 text + toolCalls + usage', async () => {
    const client = createLLMClient({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      baseUrl: `${baseURL}/anthropic`,
      apiKey: 'mock',
      keyRef: 'mock',
    })
    const r = await client.complete({ messages: [{ role: 'user', content: 'hi' }] })
    expect(r.text).toBe('Hello there')
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0]?.name).toBe('ask_user')
    expect(r.stopReason).toBe('tool_use')
    expect(r.usage?.input).toBe(50)
    expect(r.usage?.output).toBe(17)
  })
})

describe('OpenAI-compat adapter', () => {
  test('stream() 产出标准 LLMChunk 序列', async () => {
    const client = createLLMClient({
      provider: 'openai-compat',
      model: 'gpt-4o',
      baseUrl: `${baseURL}/openai/v1`,
      apiKey: 'mock',
      keyRef: 'mock',
    })
    const chunks: LLMChunk[] = []
    for await (const c of client.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(c)
    }
    assertCommon(chunks)
  })

  test('complete() 聚合 text + toolCalls', async () => {
    const client = createLLMClient({
      provider: 'openai-compat',
      model: 'gpt-4o',
      baseUrl: `${baseURL}/openai/v1`,
      apiKey: 'mock',
      keyRef: 'mock',
    })
    const r = await client.complete({ messages: [{ role: 'user', content: 'hi' }] })
    expect(r.text).toBe('Hello there')
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0]?.name).toBe('ask_user')
    expect(r.stopReason).toBe('tool_use')
  })
})
