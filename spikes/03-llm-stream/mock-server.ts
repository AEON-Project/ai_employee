/**
 * Mock SSE server: 模拟 Anthropic 和 OpenAI 的 streaming 响应。
 * 同进程内起一个 Bun.serve，按路径分发两套协议。
 *
 * 每个响应都包含：thinking-like text → tool_use 帧 → 收尾，
 * 目的是验证 SDK 能正确解析 tool_use 流式 args。
 */

function sse(events: { event?: string; data: unknown }[]) {
  const lines: string[] = [];
  for (const e of events) {
    if (e.event) lines.push(`event: ${e.event}`);
    lines.push(`data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}`);
    lines.push('', '');
  }
  return lines.join('\n');
}

function sseStream(events: { event?: string; data: unknown }[], delayMs = 5) {
  return new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const enc = new TextEncoder();
      for (const e of events) {
        const block: string[] = [];
        if (e.event) block.push(`event: ${e.event}`);
        block.push(`data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}`);
        block.push('', '');
        ctrl.enqueue(enc.encode(block.join('\n')));
        await Bun.sleep(delayMs);
      }
      ctrl.close();
    },
  });
}

// ── Anthropic 协议 ───────────────────────────────────────────
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
          model: 'claude-opus-4-7-20251022',
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
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '我想' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '调用工具来确认' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },

    // tool_use 块
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_01XYZ', name: 'ask_user', input: {} },
      },
    },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"questions":' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '[{"question":"目标用户是开发者还是运营？"}],' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"trigger_reason":"decision_split"}' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },

    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 42 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
}

// ── OpenAI 协议 ──────────────────────────────────────────────
function openaiEvents() {
  const base = { id: 'chatcmpl-XYZ', object: 'chat.completion.chunk', created: 0, model: 'gpt-4o' };
  return [
    { data: { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] } },
    { data: { ...base, choices: [{ index: 0, delta: { content: '我想' }, finish_reason: null }] } },
    { data: { ...base, choices: [{ index: 0, delta: { content: '调用工具来确认' }, finish_reason: null }] } },
    // tool_calls 流式
    { data: { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_X', type: 'function', function: { name: 'ask_user', arguments: '' } }] }, finish_reason: null }] } },
    { data: { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"questions":' } }] }, finish_reason: null }] } },
    { data: { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '[{"question":"目标用户是开发者还是运营？"}],' } }] }, finish_reason: null }] } },
    { data: { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"trigger_reason":"decision_split"}' } }] }, finish_reason: null }] } },
    { data: { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] } },
    { data: '[DONE]' },
  ];
}

export function startMockServer() {
  return Bun.serve({
    port: 0, // 让 Bun 分配可用端口
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === '/anthropic/v1/messages') {
        return new Response(sseStream(anthropicEvents()), {
          headers: { 'content-type': 'text/event-stream' },
        });
      }

      if (url.pathname === '/openai/v1/chat/completions') {
        return new Response(sseStream(openaiEvents()), {
          headers: { 'content-type': 'text/event-stream' },
        });
      }

      return new Response('not found', { status: 404 });
    },
  });
}
