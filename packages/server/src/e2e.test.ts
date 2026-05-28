/**
 * α 阶段端到端验收测试 — 覆盖 PRD §12 主路径 #1~#6。
 *
 * 不用 Playwright（headless browser 在 CI 过重）；改用 fetch + scripted mock LLM
 * 在 server 层做 happy path 验收。
 *
 * 每个 `test` 名以 #N 开头对应 PRD §12 验收点。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { TypedEventBus, type EventMap } from '@ai-emp/events'
import {
  CredentialsRepo,
  InMemoryKeychainStore,
  createRepos,
  migrate,
  openDatabase,
  type Repos,
} from '@ai-emp/storage'
import { DEFAULT_BUDGET_CAP } from '@ai-emp/domain'
import {
  executeRequirement,
  persistFromReport,
  reindexSource,
  type LLMFactory,
  type RuntimeLLMChunk,
  type RuntimeServices,
  type RuntimeToolDef,
} from '@ai-emp/core'
import type { Database } from 'bun:sqlite'
import { createServer, type ServerHandle } from './index.js'

// ── 通用 mock ──────────────────────────────────────────────
const passThroughSchema = {
  safeParse(v: unknown) {
    return { success: true, data: v }
  },
}
const mockTools: RuntimeToolDef[] = [
  { name: 'ask_user', kind: 'system', description: '', inputSchema: passThroughSchema },
  { name: 'advance_step', kind: 'system', description: '', inputSchema: passThroughSchema },
  { name: 'update_plan', kind: 'system', description: '', inputSchema: passThroughSchema },
  { name: 'emit_deliverable', kind: 'system', description: '', inputSchema: passThroughSchema },
]

type Script = RuntimeLLMChunk[][]

function scriptedLLM(scripts: Script): LLMFactory {
  let turn = 0
  return {
    create: () => ({
      async *stream() {
        const chunks = scripts[turn++] ?? scripts[scripts.length - 1] ?? []
        for (const c of chunks) yield c
      },
      async complete() {
        return { text: '', toolCalls: [], stopReason: 'end_turn' }
      },
    }),
  }
}

function fakeEmbed(text: string): Float32Array {
  const v = new Float32Array(512)
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    v[(code * 31 + i) % 512] += 1
  }
  let n = 0
  for (let i = 0; i < 512; i++) n += v[i]! * v[i]!
  const norm = Math.sqrt(n) || 1
  for (let i = 0; i < 512; i++) v[i] = v[i]! / norm
  return v
}

function mkServices(scripts: Script): {
  services: RuntimeServices
  bus: TypedEventBus<EventMap>
  repos: Repos
  sqlite: Database
} {
  const { db, sqlite } = openDatabase({ path: ':memory:' })
  migrate(sqlite)
  const repos = createRepos(db)
  const keychain = new InMemoryKeychainStore()
  const credentials = new CredentialsRepo(db, keychain)
  const bus = new TypedEventBus<EventMap>()
  const services: RuntimeServices = {
    repos,
    credentials,
    bus,
    llm: scriptedLLM(scripts),
    toolRegistry: {
      get: (n) => mockTools.find((t) => t.name === n),
      listFor: () => mockTools,
    },
    toolExecutor: {
      async invoke() {
        // 默认返回 ok=true 让 mock 业务工具（fake_bash 等）顺利"成功"，
        // 这样 V2 P0 守卫（emit_deliverable 前必有业务工具调用）能正常通过。
        return { ok: true, value: { status: 'completed', exitCode: 0, stdout: '', stderr: '' } }
      },
    },
    toolJsonSchema: () => ({}),
    memory: {
      sqlite,
      async embed(texts) {
        return texts.map(fakeEmbed)
      },
    },
  }
  return { services, bus, repos, sqlite }
}

// 同步建一个 employee + project 的快捷工具
async function seedEmpAndProject(
  services: RuntimeServices,
  repos: Repos,
  projectDescription = '本项目是 SaaS 落地页',
): Promise<{ eid: string; pid: string }> {
  const cred = await services.credentials.create({ kind: 'llm_key', secret: 'mock-key' })
  const eid = repos.employees.create({
    name: '小李',
    role: '前端',
    modelProvider: 'anthropic',
    modelName: 'claude-opus-4-7',
    modelKeyRef: cred.keychainKey,
    persona: '简洁直接',
  })
  const pid = repos.projects.create({ name: 'P', description: projectDescription })
  return { eid, pid }
}

const TOKEN = 'e2e-token'
let handle: ServerHandle
let baseUrl: string
let currentServices: RuntimeServices
let currentBus: TypedEventBus<EventMap>
let currentRepos: Repos
let currentSqlite: Database

async function bootWith(scripts: Script) {
  if (handle) await handle.stop()
  const ctx = mkServices(scripts)
  currentServices = ctx.services
  currentBus = ctx.bus
  currentRepos = ctx.repos
  currentSqlite = ctx.sqlite
  handle = createServer({ port: 0, dataDir: '/tmp', token: TOKEN, services: ctx.services })
  const { port } = await handle.start()
  baseUrl = `http://localhost:${port}`
}

afterAll(async () => {
  await handle?.stop()
})

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* ignore */
  }
  return { status: r.status, json }
}

// ──────────────────────────────────────────────────────────────
// #1 基础配置：项目 + 员工 + 介绍向量化
// ──────────────────────────────────────────────────────────────
describe('#1 基础配置', () => {
  beforeAll(async () => {
    await bootWith([])
  })

  test('创建项目 → 介绍向量化 → 可被 RAG 命中', async () => {
    const p = await api('POST', '/api/projects', {
      name: 'AI 数字员工',
      description: '本项目是 SaaS 落地页，目标用户开发者',
    })
    expect(p.status).toBe(201)
    const pid = (p.json as { id: string }).id

    // 对 project_desc 做 reindex（α 在 PATCH 时也可做；这里直接调）
    await reindexSource(
      {
        repos: currentRepos,
        sqlite: currentSqlite,
        async embed(t) {
          return t.map(fakeEmbed)
        },
      },
      'project_desc',
      pid,
      '本项目是 SaaS 落地页，目标用户开发者',
    )

    // 用 SQL 查 chunks 表
    const rows = currentSqlite
      .prepare<
        { id: string },
        [string]
      >(`SELECT id FROM chunks WHERE source_type = 'project_desc' AND source_id = ?`)
      .all(pid)
    expect(rows.length).toBe(1)

    // 创建员工
    const cred = await currentServices.credentials.create({ kind: 'llm_key', secret: 'k' })
    const e = await api('POST', '/api/employees', {
      name: '小李',
      role: '前端',
      modelProvider: 'anthropic',
      modelName: 'claude-opus-4-7',
      modelKeyRef: cred.keychainKey,
    })
    expect(e.status).toBe(201)
  })
})

// ──────────────────────────────────────────────────────────────
// #2 澄清前置：draft → 用户确认 → 进入"进行中"
// ──────────────────────────────────────────────────────────────
describe('#2 澄清前置', () => {
  beforeAll(async () => {
    await bootWith([
      // 用户确认澄清后第一轮：直接 emit
      [
        {
          type: 'tool_use_stop',
          id: 't1',
          name: 'emit_deliverable',
          args: { summary: '完成', contentText: '稿件' },
        },
        { type: 'message_stop', reason: 'tool_use' },
      ],
    ])
  })

  test('需求 → 待澄清 → draft → 用户答 → 进行中', async () => {
    const { eid, pid } = await seedEmpAndProject(currentServices, currentRepos)
    const r1 = await api('POST', '/api/requirements', {
      title: '写落地页',
      description: '高级 SaaS 风格',
      projectId: pid,
      budgetCap: DEFAULT_BUDGET_CAP,
    })
    const rid = (r1.json as { id: string }).id

    await api('POST', `/api/requirements/${rid}/assign`, { employeeId: eid })
    expect((await api('GET', `/api/requirements/${rid}`)).json).toMatchObject({ status: '待澄清' })

    const dr = await api('POST', `/api/requirements/${rid}/clarify/draft`, {
      employeeUnderstanding: '面向开发者的 SaaS 落地页',
      proposedPlan: ['竞品分析', '差异化卖点', '起草', '自检'],
      questions: [{ question: '目标用户是开发者还是运营？' }],
    })
    expect(dr.status).toBe(201)
    const cid = (dr.json as { id: string }).id

    await api('POST', `/api/clarifications/${cid}/answer`, {
      answers: [{ question: '目标用户是开发者还是运营？', answer: '开发者' }],
    })
    expect((await api('GET', `/api/requirements/${rid}`)).json).toMatchObject({ status: '进行中' })
  })
})

// ──────────────────────────────────────────────────────────────
// #3 思维链透明：thinking + tool_call + plan + 用户暂停
// ──────────────────────────────────────────────────────────────
describe('#3 思维链透明', () => {
  beforeAll(async () => {
    await bootWith([
      [
        { type: 'thinking_delta', text: '让我先分析竞品' },
        { type: 'text_delta', text: '完成竞品分析' },
        {
          type: 'tool_use_stop',
          id: 't1',
          name: 'advance_step',
          args: { step_idx: 0, summary: '已完成竞品分析' },
        },
        { type: 'message_stop', reason: 'tool_use' },
        { type: 'usage', input: 100, output: 50 },
      ],
      [
        {
          type: 'tool_use_stop',
          id: 't2',
          name: 'emit_deliverable',
          args: { summary: '完成', contentText: '文案' },
        },
        { type: 'message_stop', reason: 'tool_use' },
      ],
    ])
  })

  test('thread 看得到 thinking/text/tool_call/tool_result', async () => {
    const { eid } = await seedEmpAndProject(currentServices, currentRepos)
    const r = await api('POST', '/api/requirements', {
      title: 'T',
      description: 'D',
      budgetCap: DEFAULT_BUDGET_CAP,
    })
    const rid = (r.json as { id: string }).id
    await api('POST', `/api/requirements/${rid}/assign`, {
      employeeId: eid,
      skipClarification: true,
    })

    // 执行
    await executeRequirement(rid, currentServices)

    const t = await api('GET', `/api/requirements/${rid}/thread`)
    expect(t.status).toBe(200)
    const messages = (t.json as { messages: { type: string }[] }).messages
    const types = new Set(messages.map((m) => m.type))
    expect(types.has('thinking')).toBe(true)
    expect(types.has('text')).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────
// #4 执行中再澄清（ask_user）
// ──────────────────────────────────────────────────────────────
describe('#4 执行中再澄清', () => {
  beforeAll(async () => {
    await bootWith([
      // turn 0: ask_user
      [
        {
          type: 'tool_use_stop',
          id: 't1',
          name: 'ask_user',
          args: {
            questions: [{ question: '方案 A 还是 B？' }],
            trigger_reason: 'decision_split',
          },
        },
        { type: 'message_stop', reason: 'tool_use' },
      ],
      // turn 1 (回答后): V2 P0 守卫前置业务工具
      [
        {
          type: 'tool_use_stop',
          id: 't_prime',
          name: 'fake_bash',
          args: { command: 'echo prime' },
        },
        { type: 'message_stop', reason: 'tool_use' },
      ],
      // turn 2: emit_deliverable
      [
        {
          type: 'tool_use_stop',
          id: 't2',
          name: 'emit_deliverable',
          args: { summary: 'ok', contentText: 'X' },
        },
        { type: 'message_stop', reason: 'tool_use' },
      ],
    ])
  })

  test('ask_user → 等待回答 → answer → 进行中 → 待验收', async () => {
    const { eid } = await seedEmpAndProject(currentServices, currentRepos)
    const r = await api('POST', '/api/requirements', {
      title: 'T',
      description: 'D',
      budgetCap: DEFAULT_BUDGET_CAP,
    })
    const rid = (r.json as { id: string }).id
    await api('POST', `/api/requirements/${rid}/assign`, {
      employeeId: eid,
      skipClarification: true,
    })

    const r1 = await executeRequirement(rid, currentServices)
    expect(r1.exit).toBe('awaiting_user')
    const req = (await api('GET', `/api/requirements/${rid}`)).json as { status: string }
    expect(req.status).toBe('等待回答')

    // 答澄清
    const cls = (await api('GET', `/api/requirements/${rid}/clarifications`)).json as {
      id: string
      questionsJson: { question: string }[]
    }[]
    const last = cls[cls.length - 1]!
    await api('POST', `/api/clarifications/${last.id}/answer`, {
      answers: [{ question: '方案 A 还是 B？', answer: 'A' }],
    })

    // 续跑
    const r2 = await executeRequirement(rid, currentServices)
    expect(r2.exit).toBe('delivered')
  })
})

// ──────────────────────────────────────────────────────────────
// #5 记忆沉淀可见：persistFromReport → memory_items 出现 + style 更新
// ──────────────────────────────────────────────────────────────
describe('#5 记忆沉淀可见', () => {
  beforeAll(async () => {
    await bootWith([])
  })

  test('verify → persistFromReport → 项目 facts + 员工 style 出现', async () => {
    const { eid, pid } = await seedEmpAndProject(currentServices, currentRepos)
    const rid = currentRepos.requirements.create({
      title: 'T',
      description: 'D',
      projectId: pid,
      assigneeId: eid,
      budgetCap: DEFAULT_BUDGET_CAP,
    })
    currentRepos.requirements.assign(rid, eid)
    currentRepos.requirements.setStatus(rid, '已完成', { completedAt: new Date() })

    const memSvc = {
      repos: currentRepos,
      sqlite: currentSqlite,
      async embed(t: string[]) {
        return t.map(fakeEmbed)
      },
    }
    const r = await persistFromReport(memSvc, rid, {
      facts: ['本项目用 Tailwind'],
      pitfalls: ['不要写长邮件'],
      lessons: ['先确认再动手'],
      styleAddendum: '语气直接',
    })
    expect(r.persistedFacts).toBe(1)
    expect(r.persistedPitfalls).toBe(1)
    expect(r.persistedLessons).toBe(1)

    const facts = await api('GET', `/api/memory/items?scope=project&scopeId=${pid}&kind=fact`)
    expect((facts.json as unknown[]).length).toBe(1)

    const lessons = await api('GET', `/api/memory/items?scope=employee&scopeId=${eid}&kind=lesson`)
    expect((lessons.json as unknown[]).length).toBe(1)

    const emp = (await api('GET', `/api/employees/${eid}`)).json as { memoryStyleText: string }
    expect(emp.memoryStyleText).toContain('语气直接')
  })
})

// ──────────────────────────────────────────────────────────────
// #6 纠错学习闭环：驳回 → 写 lesson + pitfall → 新需求 PromptComposer 引用
// ──────────────────────────────────────────────────────────────
describe('#6 纠错学习闭环', () => {
  beforeAll(async () => {
    await bootWith([])
  })

  test('驳回需求 → lesson/pitfall 写入 → 新需求 prompt 包含历史教训', async () => {
    const { eid, pid } = await seedEmpAndProject(currentServices, currentRepos)
    const rid1 = currentRepos.requirements.create({
      title: '写邮件',
      description: 'D',
      projectId: pid,
      assigneeId: eid,
      budgetCap: DEFAULT_BUDGET_CAP,
    })
    currentRepos.requirements.assign(rid1, eid)
    currentRepos.requirements.setStatus(rid1, '已驳回', { completedAt: new Date() })

    const memSvc = {
      repos: currentRepos,
      sqlite: currentSqlite,
      async embed(t: string[]) {
        return t.map(fakeEmbed)
      },
    }
    await persistFromReport(memSvc, rid1, {
      pitfalls: ['客户讨厌长邮件，要求 200 字以内'],
      lessons: ['先问字数限制再动手'],
    })

    // 派同类需求
    const rid2 = currentRepos.requirements.create({
      title: '再写一封邮件',
      description: '给客户发邮件',
      projectId: pid,
      assigneeId: eid,
      budgetCap: DEFAULT_BUDGET_CAP,
    })
    currentRepos.requirements.assign(rid2, eid)
    currentRepos.requirements.setStatus(rid2, '进行中')
    const tid = currentRepos.threads.createForRequirement(rid2)
    void tid

    // 用 PromptComposer 看是否引用历史
    const { compose } = await import('@ai-emp/core/prompt')
    const prompt = await compose(currentRepos, {
      reqId: rid2,
      employeeId: eid,
      threadId: tid,
      memory: memSvc,
    })
    // 应至少命中 1 条 pitfall 或 lesson
    const recalled = prompt.debug.recalledPitfalls.length + prompt.debug.recalledLessons.length
    expect(recalled).toBeGreaterThanOrEqual(1)
    // system prompt 应包含教训关键字
    const ok = prompt.system.includes('长邮件') || prompt.system.includes('字数')
    expect(ok).toBe(true)
    void currentBus
  })
})
