import { describe, expect, test } from 'bun:test'
import { createRepos, migrate, openDatabase } from '@ai-emp/storage'
import { DEFAULT_BUDGET_CAP } from '@ai-emp/domain'
import { compose } from './composer.js'

function setup() {
  const { db, sqlite } = openDatabase({ path: ':memory:' })
  migrate(sqlite)
  const repos = createRepos(db)
  return { repos, sqlite }
}

describe('PromptComposer.cacheBreakpoints', () => {
  test('V2 O8: 三段 cache breakpoint（平台/项目/需求）严格递增', async () => {
    const { repos } = setup()
    const pid = repos.projects.create({ name: 'P', description: '' })
    repos.conventions.create({
      projectId: pid,
      content: '用 Zustand 而非 Redux',
      enforcement: 'required',
    })
    const eid = repos.employees.create({
      name: 'e',
      role: 'r',
      modelProvider: 'anthropic',
      modelName: 'm',
      modelKeyRef: 'k',
      persona: '简洁严谨',
    })
    const rid = repos.requirements.create({
      title: 'T',
      description: 'D',
      projectId: pid,
      assigneeId: eid,
      budgetCap: DEFAULT_BUDGET_CAP,
    })
    const tid = repos.threads.createForRequirement(rid)
    const p = await compose(repos, { reqId: rid, employeeId: eid, threadId: tid })
    // 至少 2 个 bp (平台 + 项目)；RAG 注入 0 时第 3 个会被去重掉，等于项目层
    expect(p.cacheBreakpoints.length).toBeGreaterThanOrEqual(2)
    // 严格递增
    for (let i = 1; i < p.cacheBreakpoints.length; i++) {
      expect(p.cacheBreakpoints[i]!).toBeGreaterThan(p.cacheBreakpoints[i - 1]!)
    }
    // 所有 bp ≤ system.length
    for (const bp of p.cacheBreakpoints) {
      expect(bp).toBeLessThanOrEqual(p.system.length)
    }
    // 平台层 bp 前应包含 persona / role
    const platformHead = p.system.slice(0, p.cacheBreakpoints[0])
    expect(platformHead).toContain('简洁严谨')
    // 项目层 bp 前应包含 conventions (Zustand)
    const projectHead = p.system.slice(0, p.cacheBreakpoints[1])
    expect(projectHead).toContain('Zustand')
    // 平台层 bp 不包含 conventions（项目内容在 bp1 之后）
    expect(platformHead).not.toContain('Zustand')
  })

  test('V2 O8: 无项目 / 无规范时也至少有平台层 bp', async () => {
    const { repos } = setup()
    const eid = repos.employees.create({
      name: 'e',
      role: 'r',
      modelProvider: 'anthropic',
      modelName: 'm',
      modelKeyRef: 'k',
      persona: '简洁',
    })
    const rid = repos.requirements.create({
      title: 'T',
      description: 'D',
      budgetCap: DEFAULT_BUDGET_CAP,
    })
    repos.requirements.assign(rid, eid)
    const tid = repos.threads.createForRequirement(rid)
    const p = await compose(repos, { reqId: rid, employeeId: eid, threadId: tid })
    // 无项目 → bp2(项目层) 和 bp1(平台层) 字节位置相同 → dedupe 后只留 1 个
    expect(p.cacheBreakpoints.length).toBeGreaterThanOrEqual(1)
    expect(p.cacheBreakpoints[0]!).toBeGreaterThan(0)
  })
})
