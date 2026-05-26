import { describe, test, expect, beforeEach } from 'bun:test'
import { z } from 'zod'
import {
  SYSTEM_TOOL_NAMES,
  ToolExecutor,
  ToolRegistry,
  registerSystemTools,
  registry,
  type ToolContext,
  type ToolDef,
} from './index.js'

const ctx: ToolContext = {
  requirementId: 'r1',
  employeeId: 'e1',
  threadId: 't1',
  signal: new AbortController().signal,
}

describe('ToolRegistry', () => {
  test('register / get / has / unregister', () => {
    const r = new ToolRegistry()
    const def: ToolDef<{ q: string }, string> = {
      name: 'echo',
      kind: 'standard',
      description: 'echo',
      inputSchema: z.object({ q: z.string() }),
      invoke: async (a) => a.q,
    }
    r.register(def)
    expect(r.has('echo')).toBe(true)
    expect(r.get('echo')?.name).toBe('echo')
    expect(r.unregister('echo')).toBe(true)
    expect(r.has('echo')).toBe(false)
  })

  test('listFor 包含系统级 + 已授权标准 tool', () => {
    const r = new ToolRegistry()
    r.register({
      name: 'sys',
      kind: 'system',
      description: 's',
      inputSchema: z.object({}),
      invoke: async () => null,
    })
    r.register({
      name: 'web',
      kind: 'standard',
      description: 'w',
      inputSchema: z.object({}),
      invoke: async () => null,
    })
    r.register({
      name: 'fs',
      kind: 'standard',
      description: 'f',
      inputSchema: z.object({}),
      invoke: async () => null,
    })
    const names = r
      .listFor(['web'])
      .map((t) => t.name)
      .sort()
    expect(names).toEqual(['sys', 'web'])
  })

  test('重复注册抛错；override 允许', () => {
    const r = new ToolRegistry()
    const def: ToolDef = {
      name: 'x',
      kind: 'standard',
      description: '',
      inputSchema: z.object({}),
      invoke: async () => null,
    }
    r.register(def)
    expect(() => r.register(def)).toThrow()
    r.override(def) // ok
  })
})

describe('registerSystemTools()', () => {
  beforeEach(() => registry.clear())

  test('注册全部 4 个系统级 tool', () => {
    registerSystemTools()
    for (const n of SYSTEM_TOOL_NAMES) {
      expect(registry.has(n)).toBe(true)
      expect(registry.get(n)?.kind).toBe('system')
    }
  })

  test('重复调用幂等', () => {
    registerSystemTools()
    expect(() => registerSystemTools()).not.toThrow()
    expect(registry.listAll()).toHaveLength(SYSTEM_TOOL_NAMES.size)
  })
})

describe('ToolExecutor 三道闸', () => {
  let r: ToolRegistry
  let exec: ToolExecutor
  beforeEach(() => {
    r = new ToolRegistry()
    exec = new ToolExecutor(r)
  })

  test('① 未授权 → unauthorized', async () => {
    r.register({
      name: 'web_search',
      kind: 'standard',
      description: '',
      inputSchema: z.object({ q: z.string() }),
      invoke: async () => 'never',
    })
    const out = await exec.invoke({ callId: 'c1', name: 'web_search', args: { q: 'x' } }, ctx, {
      grantedNames: [],
    })
    expect(out.ok).toBe(false)
    expect(out.error?.kind).toBe('unauthorized')
  })

  test('② args 非法 → invalid_args，不调用 invoke', async () => {
    let called = false
    r.register({
      name: 'web_search',
      kind: 'standard',
      description: '',
      inputSchema: z.object({ q: z.string() }),
      invoke: async () => {
        called = true
        return null
      },
    })
    const out = await exec.invoke({ callId: 'c1', name: 'web_search', args: { q: 42 } }, ctx, {
      grantedNames: ['web_search'],
    })
    expect(out.ok).toBe(false)
    expect(out.error?.kind).toBe('invalid_args')
    expect(called).toBe(false)
  })

  test('③ 调用成功返回 value', async () => {
    r.register({
      name: 'echo',
      kind: 'standard',
      description: '',
      inputSchema: z.object({ q: z.string() }),
      invoke: async (a) => a.q.toUpperCase(),
    })
    const out = await exec.invoke({ callId: 'c1', name: 'echo', args: { q: 'hi' } }, ctx, {
      grantedNames: ['echo'],
    })
    expect(out.ok).toBe(true)
    expect(out.value).toBe('HI')
    expect(out.retries).toBe(0)
  })

  test('③ 超时触发重试，最终成功 retries 反映尝试次数', async () => {
    let n = 0
    r.register({
      name: 'flaky',
      kind: 'standard',
      description: '',
      inputSchema: z.object({}),
      invoke: async (_a, c) => {
        n++
        if (n <= 1) {
          // 触发超时：故意 wait abort
          await new Promise((res, rej) => {
            c.signal.addEventListener('abort', () => rej(new Error('aborted')))
          })
        }
        return 'ok'
      },
    })
    const out = await exec.invoke({ callId: 'c1', name: 'flaky', args: {} }, ctx, {
      grantedNames: ['flaky'],
      backoffMs: [10, 100],
    })
    expect(out.ok).toBe(true)
    expect(out.retries).toBe(1)
  })

  test('③ 持续失败 → invoke_failed', async () => {
    r.register({
      name: 'bad',
      kind: 'standard',
      description: '',
      inputSchema: z.object({}),
      invoke: async () => {
        throw new Error('boom')
      },
    })
    const out = await exec.invoke({ callId: 'c1', name: 'bad', args: {} }, ctx, {
      grantedNames: ['bad'],
      backoffMs: [10, 10, 10],
    })
    expect(out.ok).toBe(false)
    expect(out.error?.kind).toBe('invoke_failed')
    expect(out.error?.message).toBe('boom')
  })

  test('系统级 tool 通过 executor 调用被拒', async () => {
    r.register({
      name: 'sys',
      kind: 'system',
      description: '',
      inputSchema: z.object({}),
      invoke: async () => null,
    })
    const out = await exec.invoke({ callId: 'c1', name: 'sys', args: {} }, ctx, {
      grantedNames: [],
    })
    expect(out.ok).toBe(false)
    expect(out.error?.kind).toBe('invoke_failed')
    expect(out.error?.message).toContain('system tool')
  })

  test('未知 tool → unknown_tool', async () => {
    const out = await exec.invoke({ callId: 'c1', name: 'nope', args: {} }, ctx, {
      grantedNames: [],
    })
    expect(out.error?.kind).toBe('unknown_tool')
  })
})

describe('系统级 tool input schemas', () => {
  test('ask_user 要求至少 1 个 question', async () => {
    registerSystemTools()
    const def = registry.get('ask_user')!
    expect(def.inputSchema.safeParse({ questions: [], trigger_reason: 'initial' }).success).toBe(
      false,
    )
    expect(
      def.inputSchema.safeParse({
        questions: [{ question: '目标用户?' }],
        trigger_reason: 'decision_split',
      }).success,
    ).toBe(true)
  })

  test('emit_deliverable 需 contentText 或 contentRef 至少一个', async () => {
    registerSystemTools()
    const def = registry.get('emit_deliverable')!
    expect(def.inputSchema.safeParse({ summary: 'x' }).success).toBe(false)
    expect(def.inputSchema.safeParse({ summary: 'x', contentText: 'hi' }).success).toBe(true)
  })

  test('系统级 tool 的 invoke 直接调会抛', async () => {
    registerSystemTools()
    const def = registry.get('advance_step')!
    await expect(def.invoke({ step_idx: 0, summary: 'x' }, ctx)).rejects.toThrow()
  })
})
