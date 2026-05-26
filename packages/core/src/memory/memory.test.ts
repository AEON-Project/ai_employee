/**
 * Memory 集成测试 — sqlite-vec + 假 embed（不依赖真实 transformers）。
 */
import { describe, expect, test } from 'bun:test'
import { createRepos, migrate, openDatabase } from '@ai-emp/storage'
import { persistFromReport, recall, reindexSource, type MemoryServices } from './index.js'
import { DEFAULT_BUDGET_CAP } from '@ai-emp/domain'

/** 简单哈希 → 512 维稳定 embedding；同样输入产同样向量，不同输入差异显著 */
function fakeEmbed(text: string): Float32Array {
  const v = new Float32Array(512)
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    v[(code * 31 + i) % 512] += 1
  }
  // L2 normalize
  let n = 0
  for (let i = 0; i < 512; i++) n += v[i]! * v[i]!
  const norm = Math.sqrt(n) || 1
  for (let i = 0; i < 512; i++) v[i] = v[i]! / norm
  return v
}

function setup() {
  const { db, sqlite } = openDatabase({ path: ':memory:' })
  migrate(sqlite)
  const repos = createRepos(db)
  const svc: MemoryServices = {
    repos,
    sqlite,
    async embed(texts) {
      return texts.map(fakeEmbed)
    },
  }
  return { repos, sqlite, svc }
}

describe('reindexSource + recall', () => {
  test('插入 memory_item 后能被 recall 命中', async () => {
    const { repos, svc } = setup()
    const pid = repos.projects.create({ name: 'P' })
    const id1 = repos.memoryItems.create({
      scope: 'project',
      scopeId: pid,
      kind: 'fact',
      content: '本项目用 Zustand 而非 Redux',
      importanceScore: 0.8,
    })
    const id2 = repos.memoryItems.create({
      scope: 'project',
      scopeId: pid,
      kind: 'fact',
      content: '今天天气晴朗',
      importanceScore: 0.5,
    })

    await reindexSource(svc, 'memory_item', id1, '本项目用 Zustand 而非 Redux')
    await reindexSource(svc, 'memory_item', id2, '今天天气晴朗')

    const hits = await recall(svc, {
      scope: 'project',
      scopeId: pid,
      kinds: ['fact'],
      query: 'Zustand 状态管理',
      k: 3,
    })
    expect(hits.length).toBeGreaterThan(0)
    // 命中应该排序 Zustand 在前
    expect(hits[0]?.content).toContain('Zustand')
  })

  test('scope/kind 过滤生效', async () => {
    const { repos, svc } = setup()
    const pid = repos.projects.create({ name: 'P' })
    const otherPid = repos.projects.create({ name: 'O' })

    const aId = repos.memoryItems.create({
      scope: 'project',
      scopeId: pid,
      kind: 'pitfall',
      content: '客户讨厌长邮件',
    })
    const bId = repos.memoryItems.create({
      scope: 'project',
      scopeId: otherPid,
      kind: 'pitfall',
      content: '客户讨厌长邮件',
    })
    await reindexSource(svc, 'memory_item', aId, '客户讨厌长邮件')
    await reindexSource(svc, 'memory_item', bId, '客户讨厌长邮件')

    const hits = await recall(svc, {
      scope: 'project',
      scopeId: pid,
      kinds: ['pitfall'],
      query: '邮件',
      k: 5,
    })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.itemId).toBe(aId)
  })

  test('reindex 替换旧 chunk', async () => {
    const { repos, svc, sqlite } = setup()
    const pid = repos.projects.create({ name: 'P' })
    const id = repos.memoryItems.create({
      scope: 'project',
      scopeId: pid,
      kind: 'fact',
      content: '旧版本',
    })
    await reindexSource(svc, 'memory_item', id, '旧版本')
    let count = sqlite
      .prepare<{ c: number }, []>(`SELECT COUNT(*) AS c FROM chunks WHERE source_id = ?`)
      .all(id)
    expect(count[0]?.c).toBe(1)

    await reindexSource(svc, 'memory_item', id, '新版本')
    count = sqlite
      .prepare<{ c: number }, []>(`SELECT COUNT(*) AS c FROM chunks WHERE source_id = ?`)
      .all(id)
    expect(count[0]?.c).toBe(1)
  })
})

describe('persistFromReport', () => {
  test('分流 facts/pitfalls/lessons 到正确 scope', async () => {
    const { repos, svc } = setup()
    const pid = repos.projects.create({ name: 'P' })
    const eid = repos.employees.create({
      name: 'e',
      role: 'r',
      modelProvider: 'anthropic',
      modelName: 'm',
      modelKeyRef: 'k',
    })
    const rid = repos.requirements.create({
      title: 'T',
      description: 'D',
      projectId: pid,
      assigneeId: eid,
      budgetCap: DEFAULT_BUDGET_CAP,
    })
    repos.requirements.assign(rid, eid)

    const r = await persistFromReport(svc, rid, {
      facts: ['用 Zustand'],
      pitfalls: ['不要发长邮件'],
      lessons: ['先问再做'],
      styleAddendum: '更简洁',
    })
    expect(r).toEqual({ persistedFacts: 1, persistedPitfalls: 1, persistedLessons: 1 })

    const proj = repos.memoryItems.list({ scope: 'project', scopeId: pid })
    expect(proj.map((m) => m.kind).sort()).toEqual(['fact', 'pitfall'])
    const emp = repos.memoryItems.list({ scope: 'employee', scopeId: eid })
    expect(emp.map((m) => m.kind)).toEqual(['lesson'])
    expect(repos.employees.findById(eid)?.memoryStyleText).toContain('更简洁')
  })
})
