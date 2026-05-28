/**
 * V2 P0 bug 4 回归：composer 输出结构化 LLMContentBlock 而不是字符串化 tool_call / tool_result。
 * 之前 extractText 把 tool_call 序列化为 "→ tool_call: Bash({...})"、tool_result 为 "[tool_result]\n..."
 * 字符串，Anthropic 凑效但 OpenAI 兼容协议下 LLM 看不到自己真的调过工具 → stop loop。
 */
import { describe, expect, test } from 'bun:test'
import { createRepos, migrate, openDatabase } from '@ai-emp/storage'
import { DEFAULT_BUDGET_CAP } from '@ai-emp/domain'
import { compose } from './composer.js'

function setup() {
  const { db, sqlite } = openDatabase({ path: ':memory:' })
  migrate(sqlite)
  const repos = createRepos(db)
  const eid = repos.employees.create({
    name: 'e',
    role: 'r',
    modelProvider: 'openai-compat',
    modelName: 'gpt-5.3-chat-latest',
    modelKeyRef: 'env://X',
    persona: 'p',
  })
  const rid = repos.requirements.create({
    title: 'T',
    description: 'D',
    budgetCap: DEFAULT_BUDGET_CAP,
  })
  repos.requirements.assign(rid, eid)
  const tid = repos.threads.createForRequirement(rid)
  return { repos, eid, rid, tid }
}

describe('PromptComposer — V2 P0 bug 4: 结构化 IR 输出', () => {
  test('tool_call 输出 {type:"tool_call", callId, name, args} 而不是字符串', async () => {
    const { repos, eid, rid, tid } = setup()
    repos.messages.append({
      threadId: tid,
      role: 'assistant',
      type: 'tool_call',
      content: { type: 'tool_call', callId: 'call_abc123', name: 'Bash', args: { command: 'ls' } },
    })
    const p = await compose(repos, { reqId: rid, employeeId: eid, threadId: tid })
    // 第一条是需求描述（user/string），第二条应是 assistant 的 tool_call IR
    const m = p.messages[1]
    expect(m).toBeDefined()
    expect(m!.role).toBe('assistant')
    expect(Array.isArray(m!.content)).toBe(true)
    const blocks = m!.content as Array<{ type: string }>
    expect(blocks).toHaveLength(1)
    const b = blocks[0] as {
      type: string
      callId: string
      name: string
      args: { command: string }
    }
    expect(b.type).toBe('tool_call')
    expect(b.callId).toBe('call_abc123')
    expect(b.name).toBe('Bash')
    expect(b.args.command).toBe('ls')
  })

  test('tool_result 输出 {type:"tool_result", callId, output} 而不是 "[tool_result]\\n..." 字符串', async () => {
    const { repos, eid, rid, tid } = setup()
    repos.messages.append({
      threadId: tid,
      role: 'tool',
      type: 'tool_result',
      content: {
        type: 'tool_result',
        callId: 'call_abc123',
        ok: true,
        value: { status: 'completed', exitCode: 0, stdout: 'hello world', stderr: '' },
      },
    })
    const p = await compose(repos, { reqId: rid, employeeId: eid, threadId: tid })
    const m = p.messages[1]
    expect(m).toBeDefined()
    expect(m!.role).toBe('user') // tool_result 在 IR 里走 user role（与 Anthropic 一致）
    const blocks = m!.content as Array<{ type: string }>
    const b = blocks[0] as {
      type: string
      callId: string
      output: string
      isError?: boolean
    }
    expect(b.type).toBe('tool_result')
    expect(b.callId).toBe('call_abc123')
    expect(b.output).toContain('exitCode=0')
    expect(b.output).toContain('stdout:\nhello world')
    expect(b.isError).toBeUndefined()
  })

  test('tool_result ok=false → isError:true', async () => {
    const { repos, eid, rid, tid } = setup()
    repos.messages.append({
      threadId: tid,
      role: 'tool',
      type: 'tool_result',
      content: {
        type: 'tool_result',
        callId: 'call_err',
        ok: false,
        error: 'permission denied',
      },
    })
    const p = await compose(repos, { reqId: rid, employeeId: eid, threadId: tid })
    const b = (
      p.messages[1]!.content as Array<{ type: string; isError?: boolean; output: string }>
    )[0]!
    expect(b.type).toBe('tool_result')
    expect(b.isError).toBe(true)
    expect(b.output).toContain('permission denied')
  })

  test('完整往返 tool_call + tool_result：保持 callId 配对（OpenAI 协议要求）', async () => {
    const { repos, eid, rid, tid } = setup()
    repos.messages.append({
      threadId: tid,
      role: 'assistant',
      type: 'tool_call',
      content: { type: 'tool_call', callId: 'call_pair', name: 'Bash', args: { command: 'pwd' } },
    })
    repos.messages.append({
      threadId: tid,
      role: 'tool',
      type: 'tool_result',
      content: {
        type: 'tool_result',
        callId: 'call_pair',
        ok: true,
        value: { status: 'completed', exitCode: 0, stdout: '/tmp', stderr: '' },
      },
    })
    const p = await compose(repos, { reqId: rid, employeeId: eid, threadId: tid })
    // messages[0] = 需求；[1] = assistant tool_call；[2] = user tool_result
    const tc = (p.messages[1]!.content as Array<{ callId?: string }>)[0]!
    const tr = (p.messages[2]!.content as Array<{ callId?: string }>)[0]!
    expect(tc.callId).toBe('call_pair')
    expect(tr.callId).toBe('call_pair') // 配对一致，OpenAI tool_call_id 才能找到对应 tool_call
  })

  test('text / thinking → {type:"text", text}', async () => {
    const { repos, eid, rid, tid } = setup()
    repos.messages.append({
      threadId: tid,
      role: 'assistant',
      type: 'text',
      content: { type: 'text', text: '让我先看看代码' },
    })
    const p = await compose(repos, { reqId: rid, employeeId: eid, threadId: tid })
    const b = (p.messages[1]!.content as Array<{ type: string; text?: string }>)[0]!
    expect(b.type).toBe('text')
    expect(b.text).toBe('让我先看看代码')
  })
})
