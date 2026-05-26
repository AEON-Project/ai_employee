/**
 * Spike 3: Anthropic + OpenAI SDK 在 Bun 下流式（含 tool_use）
 *
 * 验证 LLMChunk 抽象层在两个 provider 下都能成立。
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { startMockServer } from './mock-server';

const t0 = Date.now();
const server = startMockServer();
const baseURL = `http://localhost:${server.port}`;
console.log(`✓ Mock server: ${baseURL}`);

// ── 统一 chunk ────────────────────────────────────────────────
type LLMChunk =
  | { type: 'thinking_delta' | 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; argsPartial: string }
  | { type: 'tool_use_stop'; id: string; name: string; args: unknown }
  | { type: 'message_stop'; reason: string }
  | { type: 'usage'; input: number; output: number }
  | { type: 'error'; error: unknown };

// ── Anthropic adapter ────────────────────────────────────────
async function* anthropicStream(): AsyncGenerator<LLMChunk> {
  const client = new Anthropic({ apiKey: 'mock', baseURL: `${baseURL}/anthropic` });
  const stream = await client.messages.create({
    model: 'claude-opus-4-7-20251022',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'test' }],
    stream: true,
  });

  const toolBlocks = new Map<number, { id: string; name: string; argsPartial: string }>();

  for await (const event of stream) {
    switch (event.type) {
      case 'content_block_start': {
        const cb: any = event.content_block;
        if (cb.type === 'text') {
          // 文本块 start 不发 chunk，等 delta
        } else if (cb.type === 'tool_use') {
          toolBlocks.set(event.index, { id: cb.id, name: cb.name, argsPartial: '' });
          yield { type: 'tool_use_start', id: cb.id, name: cb.name };
        }
        break;
      }
      case 'content_block_delta': {
        const d: any = event.delta;
        if (d.type === 'text_delta') {
          yield { type: 'text_delta', text: d.text };
        } else if (d.type === 'input_json_delta') {
          const blk = toolBlocks.get(event.index)!;
          blk.argsPartial += d.partial_json;
          yield { type: 'tool_use_delta', id: blk.id, argsPartial: d.partial_json };
        }
        break;
      }
      case 'content_block_stop': {
        const blk = toolBlocks.get(event.index);
        if (blk) {
          let args: unknown = null;
          try { args = JSON.parse(blk.argsPartial); } catch {}
          yield { type: 'tool_use_stop', id: blk.id, name: blk.name, args };
        }
        break;
      }
      case 'message_delta': {
        const usage = (event as any).usage;
        if (usage?.output_tokens) yield { type: 'usage', input: 0, output: usage.output_tokens };
        const stopReason = (event as any).delta?.stop_reason;
        if (stopReason) yield { type: 'message_stop', reason: stopReason };
        break;
      }
      case 'message_start': {
        const usage = (event as any).message?.usage;
        if (usage) yield { type: 'usage', input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 };
        break;
      }
    }
  }
}

// ── OpenAI adapter ───────────────────────────────────────────
async function* openaiStream(): AsyncGenerator<LLMChunk> {
  const client = new OpenAI({ apiKey: 'mock', baseURL: `${baseURL}/openai/v1` });
  const stream = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'test' }],
    stream: true,
  });

  const toolBlocks = new Map<number, { id: string; name: string; argsPartial: string; started: boolean }>();

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta;

    if (delta.content) yield { type: 'text_delta', text: delta.content };

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        let blk = toolBlocks.get(idx);
        if (!blk) {
          blk = { id: tc.id ?? '', name: tc.function?.name ?? '', argsPartial: '', started: false };
          toolBlocks.set(idx, blk);
        }
        if (tc.id && !blk.id) blk.id = tc.id;
        if (tc.function?.name && !blk.name) blk.name = tc.function.name;
        if (!blk.started && blk.id && blk.name) {
          blk.started = true;
          yield { type: 'tool_use_start', id: blk.id, name: blk.name };
        }
        if (tc.function?.arguments) {
          blk.argsPartial += tc.function.arguments;
          yield { type: 'tool_use_delta', id: blk.id, argsPartial: tc.function.arguments };
        }
      }
    }

    if (choice.finish_reason) {
      // 关闭所有未关闭的 tool block
      for (const blk of toolBlocks.values()) {
        let args: unknown = null;
        try { args = JSON.parse(blk.argsPartial); } catch {}
        yield { type: 'tool_use_stop', id: blk.id, name: blk.name, args };
      }
      yield { type: 'message_stop', reason: choice.finish_reason };
    }
  }
}

// ── 验证函数 ──────────────────────────────────────────────────
async function verify(name: string, gen: AsyncGenerator<LLMChunk>) {
  console.log(`\n── ${name} ─────────────────────────────────`);
  const chunks: LLMChunk[] = [];
  for await (const c of gen) {
    chunks.push(c);
    if (c.type === 'text_delta') process.stdout.write(`text:"${c.text}" `);
    else if (c.type === 'tool_use_start') process.stdout.write(`\n  tool_start(${c.name}) `);
    else if (c.type === 'tool_use_delta') process.stdout.write(`Δargs:"${c.argsPartial}" `);
    else if (c.type === 'tool_use_stop') process.stdout.write(`\n  tool_stop args=${JSON.stringify(c.args)} `);
    else if (c.type === 'message_stop') process.stdout.write(`\n  message_stop(${c.reason}) `);
    else if (c.type === 'usage') process.stdout.write(`\n  usage(in=${c.input} out=${c.output}) `);
  }
  console.log();

  // 断言：必须看到至少一个 text_delta、一个 tool_use_start、最终参数能 parse、message_stop=tool_use*
  const hasText = chunks.some(c => c.type === 'text_delta');
  const toolStop = chunks.find(c => c.type === 'tool_use_stop') as any;
  const finalStop = chunks.find(c => c.type === 'message_stop') as any;
  const ok =
    hasText &&
    toolStop?.name === 'ask_user' &&
    toolStop?.args?.trigger_reason === 'decision_split' &&
    /tool_use|tool_calls/.test(finalStop?.reason ?? '');

  if (!ok) {
    console.error(`FAIL ${name}`);
    console.error('  hasText=', hasText, 'toolStop=', toolStop, 'finalStop=', finalStop);
    return false;
  }
  console.log(`✓ ${name} PASS`);
  return true;
}

let ok = true;
ok = (await verify('Anthropic SDK', anthropicStream())) && ok;
ok = (await verify('OpenAI SDK',    openaiStream()))    && ok;

server.stop();
console.log(`\n=== ${ok ? 'PASS' : 'FAIL'} in ${Date.now() - t0}ms ===`);
process.exit(ok ? 0 : 1);
