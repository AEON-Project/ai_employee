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
  test('包含 required conventions 时产生断点', async () => {
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
      persona: '简洁',
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
    expect(p.cacheBreakpoints.length).toBe(1)
    expect(p.cacheBreakpoints[0]!).toBeGreaterThan(0)
    expect(p.cacheBreakpoints[0]!).toBeLessThanOrEqual(p.system.length)
    // 断点前应包含 required conventions
    const head = p.system.slice(0, p.cacheBreakpoints[0])
    expect(head).toContain('Zustand')
  })
})
