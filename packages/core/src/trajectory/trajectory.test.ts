/**
 * V2 O11 Trajectory dump 单测
 */
import { describe, expect, test } from 'bun:test'
import { createRepos, migrate, openDatabase } from '@ai-emp/storage'
import { DEFAULT_BUDGET_CAP } from '@ai-emp/domain'
import { extractTrajectory, toJsonl } from './index.js'

function setup() {
  const { db, sqlite } = openDatabase({ path: ':memory:' })
  migrate(sqlite)
  const repos = createRepos(db)
  return { repos, sqlite }
}

describe('extractTrajectory', () => {
  test('空 thread → 只返回 user prompt (title+description)', () => {
    const { repos } = setup()
    const rid = repos.requirements.create({
      title: '写个落地页',
      description: '高级开发者风格 800 字',
      budgetCap: DEFAULT_BUDGET_CAP,
    })
    const dump = extractTrajectory(repos, rid)
    expect(dump.requirementId).toBe(rid)
    expect(dump.title).toBe('写个落地页')
    expect(dump.messages.length).toBe(1)
    expect(dump.messages[0]!.role).toBe('user')
    expect(dump.messages[0]!.content).toContain('写个落地页')
    expect(dump.messages[0]!.content).toContain('高级开发者风格')
  })

  test('完整 thread → text / tool_call / tool_result / plan_update 正确映射', () => {
    const { repos } = setup()
    const rid = repos.requirements.create({
      title: 'T',
      description: 'D',
      budgetCap: DEFAULT_BUDGET_CAP,
    })
    const tid = repos.threads.createForRequirement(rid)
    repos.messages.append({
      threadId: tid,
      role: 'assistant',
      type: 'thinking',
      content: { type: 'thinking', text: '让我想想…' },
    })
    repos.messages.append({
      threadId: tid,
      role: 'assistant',
      type: 'text',
      content: { type: 'text', text: '开始干' },
    })
    repos.messages.append({
      threadId: tid,
      role: 'assistant',
      type: 'tool_call',
      content: { type: 'tool_call', name: 'Bash', callId: 'c1', args: { command: 'ls' } },
    })
    repos.messages.append({
      threadId: tid,
      role: 'tool',
      type: 'tool_result',
      content: { type: 'tool_result', callId: 'c1', ok: true, value: 'file1.txt\nfile2.txt' },
    })
    repos.messages.append({
      threadId: tid,
      role: 'assistant',
      type: 'plan_update',
      content: {
        type: 'plan_update',
        plan: { steps: [{ idx: 0, text: 's1', status: 'done' }] },
        reason: 'init',
      },
    })

    const dump = extractTrajectory(repos, rid)
    expect(dump.messages.length).toBe(6) // 1 user prompt + 5 thread messages

    // index 0: user prompt
    expect(dump.messages[0]!.role).toBe('user')

    // index 1: thinking → assistant + [thinking] prefix
    expect(dump.messages[1]!.role).toBe('assistant')
    expect(dump.messages[1]!.content).toContain('[thinking]')
    expect(dump.messages[1]!.content).toContain('让我想想')

    // index 2: text → assistant
    expect(dump.messages[2]!.role).toBe('assistant')
    expect(dump.messages[2]!.content).toBe('开始干')

    // index 3: tool_call → assistant + tool_calls
    expect(dump.messages[3]!.role).toBe('assistant')
    expect(dump.messages[3]!.tool_calls).toBeDefined()
    expect(dump.messages[3]!.tool_calls![0]!.function.name).toBe('Bash')
    expect(JSON.parse(dump.messages[3]!.tool_calls![0]!.function.arguments)).toEqual({
      command: 'ls',
    })

    // index 4: tool_result → tool + tool_call_id
    expect(dump.messages[4]!.role).toBe('tool')
    expect(dump.messages[4]!.tool_call_id).toBe('c1')
    // ok=true 时 value 是 string 直接放 content
    expect(dump.messages[4]!.content).toContain('file1.txt')

    // index 5: plan_update → assistant + [plan_update] prefix
    expect(dump.messages[5]!.role).toBe('assistant')
    expect(dump.messages[5]!.content).toContain('[plan_update]')
    expect(dump.messages[5]!.content).toContain('init')
  })

  test('tool_result ok=false → content 前缀 [error]', () => {
    const { repos } = setup()
    const rid = repos.requirements.create({
      title: 'T',
      description: 'D',
      budgetCap: DEFAULT_BUDGET_CAP,
    })
    const tid = repos.threads.createForRequirement(rid)
    repos.messages.append({
      threadId: tid,
      role: 'tool',
      type: 'tool_result',
      content: { type: 'tool_result', callId: 'cx', ok: false, error: 'EACCES' },
    })
    const dump = extractTrajectory(repos, rid)
    const toolMsg = dump.messages.find((m) => m.role === 'tool')!
    expect(toolMsg.content).toContain('[error] EACCES')
  })

  test('系统 error message → role=system + [error] prefix', () => {
    const { repos } = setup()
    const rid = repos.requirements.create({
      title: 'T',
      description: 'D',
      budgetCap: DEFAULT_BUDGET_CAP,
    })
    const tid = repos.threads.createForRequirement(rid)
    repos.messages.append({
      threadId: tid,
      role: 'system',
      type: 'error',
      content: { type: 'error', message: '出错啦', fatal: false },
    })
    const dump = extractTrajectory(repos, rid)
    const sysMsg = dump.messages.find((m) => m.role === 'system')!
    expect(sysMsg.content).toBe('[error] 出错啦')
  })

  test('找不到工单 → 抛错', () => {
    const { repos } = setup()
    expect(() => extractTrajectory(repos, 'no-such-id')).toThrow()
  })
})

describe('toJsonl', () => {
  test('第一行 __meta__ + 每条 message 一行', () => {
    const { repos } = setup()
    const rid = repos.requirements.create({
      title: 'T',
      description: 'D',
      budgetCap: DEFAULT_BUDGET_CAP,
    })
    const dump = extractTrajectory(repos, rid)
    const jsonl = toJsonl(dump)
    const lines = jsonl.trim().split('\n')
    expect(lines.length).toBe(2) // meta + 1 user prompt
    const meta = JSON.parse(lines[0]!) as { __meta__?: Record<string, unknown> }
    expect(meta.__meta__).toBeDefined()
    expect(meta.__meta__!.requirementId).toBe(rid)
    expect(meta.__meta__!.title).toBe('T')
    // 第二行是 user prompt
    const msg = JSON.parse(lines[1]!)
    expect(msg.role).toBe('user')
  })
})
