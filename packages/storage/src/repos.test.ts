import { beforeEach, describe, expect, test } from 'bun:test'
import { DEFAULT_BUDGET_CAP, type BudgetUsed } from '@ai-emp/domain'
import { closeDatabase, createRepos, migrate, openDatabase, type Repos } from './index.js'
import type { Database } from 'bun:sqlite'

function setup(): { sqlite: Database; repos: Repos } {
  const { db, sqlite } = openDatabase({ path: ':memory:' })
  migrate(sqlite)
  return { sqlite, repos: createRepos(db) }
}

describe('ProjectsRepo', () => {
  let env: ReturnType<typeof setup>
  beforeEach(() => {
    env = setup()
  })

  test('create + findById + list + update + archive + delete', () => {
    const { repos } = env
    const id = repos.projects.create({ name: 'P', description: 'D' })
    expect(repos.projects.findById(id)?.name).toBe('P')
    repos.projects.update(id, { description: 'D2' })
    expect(repos.projects.findById(id)?.description).toBe('D2')
    repos.projects.archive(id)
    expect(repos.projects.findById(id)?.status).toBe('archived')
    repos.projects.delete(id)
    expect(repos.projects.findById(id)).toBeNull()
  })
})

describe('EmployeesRepo + SkillsRepo', () => {
  let env: ReturnType<typeof setup>
  beforeEach(() => {
    env = setup()
  })

  test('员工挂技能；主技能 order=0 在前', () => {
    const { repos } = env
    const eid = repos.employees.create({
      name: '小李',
      role: '前端',
      modelProvider: 'anthropic',
      modelName: 'claude-opus-4-7',
      modelKeyRef: 'k1',
    })
    const s1 = repos.skills.create({
      name: 'React',
      category: '技术',
      description: '',
      promptTemplate: '',
    })
    const s2 = repos.skills.create({
      name: 'TS',
      category: '技术',
      description: '',
      promptTemplate: '',
    })
    repos.skills.attach(eid, s2, 1)
    repos.skills.attach(eid, s1, 0)

    const list = repos.skills.listForEmployee(eid)
    expect(list.map((x) => x.skill.name)).toEqual(['React', 'TS'])
  })

  test('updateStyle / archive', () => {
    const { repos } = env
    const eid = repos.employees.create({
      name: '小李',
      role: '前端',
      modelProvider: 'anthropic',
      modelName: 'c',
      modelKeyRef: 'k',
    })
    repos.employees.updateStyle(eid, '简洁直接')
    expect(repos.employees.findById(eid)?.memoryStyleText).toBe('简洁直接')
    repos.employees.archive(eid)
    expect(repos.employees.findById(eid)?.status).toBe('archived')
  })
})

describe('RequirementsRepo', () => {
  let env: ReturnType<typeof setup>
  beforeEach(() => {
    env = setup()
  })

  test('create + assign + setStatus + listByStatus / listActive', () => {
    const { repos } = env
    const pid = repos.projects.create({ name: 'P' })
    const eid = repos.employees.create({
      name: '小李',
      role: '前端',
      modelProvider: 'anthropic',
      modelName: 'c',
      modelKeyRef: 'k',
    })
    const r1 = repos.requirements.create({
      title: 'T1',
      description: 'D',
      projectId: pid,
      budgetCap: DEFAULT_BUDGET_CAP,
    })
    const r2 = repos.requirements.create({
      title: 'T2',
      description: 'D',
      projectId: pid,
      budgetCap: DEFAULT_BUDGET_CAP,
    })

    repos.requirements.assign(r1, eid)
    repos.requirements.setStatus(r1, '待澄清')
    repos.requirements.setStatus(r2, '已完成', { completedAt: new Date() })

    expect(repos.requirements.listByStatus('待澄清').map((r) => r.id)).toEqual([r1])
    expect(repos.requirements.listActive().map((r) => r.id)).toEqual([r1])
  })
})

describe('Threads + Messages', () => {
  let env: ReturnType<typeof setup>
  beforeEach(() => {
    env = setup()
  })

  test('append 自动递增 seq；并发安全（事务） + tail/listByThread', () => {
    const { repos } = env
    const rid = repos.requirements.create({
      title: 'T',
      description: 'D',
      budgetCap: DEFAULT_BUDGET_CAP,
    })
    const tid = repos.threads.createForRequirement(rid)

    const seqs: number[] = []
    for (let i = 0; i < 5; i++) {
      const r = repos.messages.append({
        threadId: tid,
        role: 'assistant',
        type: 'text',
        content: { type: 'text', text: `chunk ${i}` },
      })
      seqs.push(r.seq)
    }
    expect(seqs).toEqual([0, 1, 2, 3, 4])

    const all = repos.messages.listByThread(tid)
    expect(all).toHaveLength(5)

    const tail = repos.messages.tailByThread(tid, 2)
    expect(tail.map((m) => m.seq)).toEqual([3, 4])

    const since = repos.messages.listByThread(tid, { sinceSeq: 2 })
    expect(since.map((m) => m.seq)).toEqual([3, 4])
  })

  test('pageByThread：seq 倒序分页 + hasMore + beforeSeq', () => {
    const { repos } = env
    const rid = repos.requirements.create({
      title: 'T',
      description: 'D',
      budgetCap: DEFAULT_BUDGET_CAP,
    })
    const tid = repos.threads.createForRequirement(rid)
    for (let i = 0; i < 7; i++) {
      repos.messages.append({
        threadId: tid,
        role: 'assistant',
        type: 'text',
        content: { type: 'text', text: `c${i}` },
      })
    }

    // 第一页：最新 3 条 seq desc，还有更早 → hasMore=true
    const p1 = repos.messages.pageByThread(tid, { limit: 3 })
    expect(p1.rows.map((m) => m.seq)).toEqual([6, 5, 4])
    expect(p1.hasMore).toBe(true)

    // 第二页：beforeSeq=4，最新 3 条 (3,2,1) → 还有 seq=0 → hasMore=true
    const p2 = repos.messages.pageByThread(tid, { limit: 3, beforeSeq: 4 })
    expect(p2.rows.map((m) => m.seq)).toEqual([3, 2, 1])
    expect(p2.hasMore).toBe(true)

    // 第三页：beforeSeq=1，仅剩 seq=0 → hasMore=false
    const p3 = repos.messages.pageByThread(tid, { limit: 3, beforeSeq: 1 })
    expect(p3.rows.map((m) => m.seq)).toEqual([0])
    expect(p3.hasMore).toBe(false)

    // 边界：beforeSeq=0 → 无更早 → 空 + hasMore=false
    const p4 = repos.messages.pageByThread(tid, { limit: 3, beforeSeq: 0 })
    expect(p4.rows).toHaveLength(0)
    expect(p4.hasMore).toBe(false)
  })
})

describe('ClarificationsRepo', () => {
  let env: ReturnType<typeof setup>
  beforeEach(() => {
    env = setup()
  })

  test('round 自递增；多轮记录 + resolve 写回答', () => {
    const { repos } = env
    const rid = repos.requirements.create({
      title: 'T',
      description: 'D',
      budgetCap: DEFAULT_BUDGET_CAP,
    })

    const c0 = repos.clarifications.create({
      requirementId: rid,
      trigger: 'initial',
      questions: [{ question: '目标用户?', answerMode: 'user' }],
    })
    expect(c0.round).toBe(0)

    const c1 = repos.clarifications.create({
      requirementId: rid,
      trigger: 'decision_split',
      questions: [{ question: '方案 A 还是 B?', answerMode: 'user' }],
    })
    expect(c1.round).toBe(1)

    repos.clarifications.resolve(c0.id, [
      { question: '目标用户?', answer: '开发者', answerMode: 'user' },
    ])
    const r = repos.clarifications.findById(c0.id)
    expect(r?.questionsJson[0]?.answer).toBe('开发者')
    expect(r?.resolvedAt).toBeTruthy()
  })
})

describe('RuntimeStateRepo', () => {
  let env: ReturnType<typeof setup>
  beforeEach(() => {
    env = setup()
  })

  test('upsert + heartbeat + delete', async () => {
    const { repos } = env
    const rid = repos.requirements.create({
      title: 'T',
      description: 'D',
      budgetCap: DEFAULT_BUDGET_CAP,
    })

    const used: BudgetUsed = { iterations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0 }
    repos.runtimeState.upsert({
      requirementId: rid,
      currentStep: 0,
      historySummary: '',
      budgetUsed: used,
    })
    const s1 = repos.runtimeState.find(rid)!
    expect(s1.currentStep).toBe(0)

    repos.runtimeState.upsert({
      requirementId: rid,
      currentStep: 3,
      historySummary: '前 3 步...',
      budgetUsed: { iterations: 3, tokensIn: 100, tokensOut: 50, wallTimeMs: 5000 },
    })
    const s2 = repos.runtimeState.find(rid)!
    expect(s2.currentStep).toBe(3)
    expect(s2.budgetUsedJson.tokensIn).toBe(100)

    const before = s2.lastHeartbeatAt.getTime()
    await Bun.sleep(5)
    repos.runtimeState.heartbeat(rid)
    expect(repos.runtimeState.find(rid)!.lastHeartbeatAt.getTime()).toBeGreaterThan(before)

    repos.runtimeState.delete(rid)
    expect(repos.runtimeState.find(rid)).toBeNull()
  })
})

describe('MemoryItemsRepo', () => {
  let env: ReturnType<typeof setup>
  beforeEach(() => {
    env = setup()
  })

  test('create + list 按 importance 排序 + incrementHit + archive', () => {
    const { repos } = env
    const pid = repos.projects.create({ name: 'P' })

    const m1 = repos.memoryItems.create({
      scope: 'project',
      scopeId: pid,
      kind: 'fact',
      content: 'A',
      importanceScore: 0.3,
    })
    const m2 = repos.memoryItems.create({
      scope: 'project',
      scopeId: pid,
      kind: 'fact',
      content: 'B',
      importanceScore: 0.9,
    })
    const m3 = repos.memoryItems.create({
      scope: 'project',
      scopeId: pid,
      kind: 'pitfall',
      content: 'C',
      importanceScore: 0.5,
    })

    const facts = repos.memoryItems.list({ scope: 'project', scopeId: pid, kind: 'fact' })
    expect(facts.map((m) => m.id)).toEqual([m2, m1])

    const pitfalls = repos.memoryItems.list({ scope: 'project', scopeId: pid, kind: 'pitfall' })
    expect(pitfalls).toHaveLength(1)

    repos.memoryItems.incrementHit(m1)
    expect(repos.memoryItems.findById(m1)?.hitCount).toBe(1)

    repos.memoryItems.archive(m3)
    expect(
      repos.memoryItems.list({ scope: 'project', scopeId: pid, kind: 'pitfall' }),
    ).toHaveLength(0)
    expect(
      repos.memoryItems.list({
        scope: 'project',
        scopeId: pid,
        kind: 'pitfall',
        includeArchived: true,
      }),
    ).toHaveLength(1)
  })
})

describe('ConventionsRepo + ChunksRepo + ReportsRepo', () => {
  let env: ReturnType<typeof setup>
  beforeEach(() => {
    env = setup()
  })

  test('conventions create + listByProject + delete', () => {
    const { repos } = env
    const pid = repos.projects.create({ name: 'P' })
    const c1 = repos.conventions.create({
      projectId: pid,
      content: '用 Zustand',
      enforcement: 'required',
    })
    repos.conventions.create({
      projectId: pid,
      content: 'API tRPC',
      enforcement: 'recommended',
      source: 'agents_md',
    })
    expect(repos.conventions.listByProject(pid)).toHaveLength(2)
    repos.conventions.delete(c1)
    expect(repos.conventions.listByProject(pid)).toHaveLength(1)
  })

  test('chunks create + findByIds + deleteBySource', () => {
    const { repos } = env
    const pid = repos.projects.create({ name: 'P' })
    const c1 = repos.chunks.create({
      sourceType: 'project_desc',
      sourceId: pid,
      chunkIdx: 0,
      content: 'hello',
      tokens: 1,
    })
    const c2 = repos.chunks.create({
      sourceType: 'project_desc',
      sourceId: pid,
      chunkIdx: 1,
      content: 'world',
      tokens: 1,
    })
    expect(repos.chunks.findByIds([c1, c2])).toHaveLength(2)
    repos.chunks.deleteBySource('project_desc', pid)
    expect(repos.chunks.findByIds([c1, c2])).toHaveLength(0)
  })

  test('reports create + findByRequirement', () => {
    const { repos } = env
    const rid = repos.requirements.create({
      title: 'T',
      description: 'D',
      budgetCap: DEFAULT_BUDGET_CAP,
    })
    repos.reports.create({
      requirementId: rid,
      contentMd: '# 总结',
      metrics: {
        durationMs: 1000,
        tokens: { input: 100, output: 50 },
        iterations: 3,
        rejected: false,
      },
    })
    const r = repos.reports.findByRequirement(rid)
    expect(r?.contentMd).toBe('# 总结')
  })
})

afterAllClose()

function afterAllClose() {
  // bun:test 没有"全局 afterAll"; setup 的每次创建会被 GC。
  // 这里只是占位，避免 lint 警告未使用导入。
  void closeDatabase
}
