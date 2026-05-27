import { describe, expect, test } from 'bun:test'
import { createRepos, migrate, openDatabase } from '@ai-emp/storage'
import { seedAll, seedReset } from './seed.js'

describe('seedAll', () => {
  test('首次导入 3 项目 + 5 员工 + 11 技能 + 若干规范', () => {
    const { db, sqlite } = openDatabase({ path: ':memory:' })
    migrate(sqlite)
    const repos = createRepos(db)

    const r = seedAll(repos)
    expect(r.projects).toBe(3)
    expect(r.employees).toBe(5)
    expect(r.skills).toBe(11)
    expect(r.conventions).toBeGreaterThan(10)
    expect(r.skipped.projects).toBe(0)
    expect(r.skipped.employees).toBe(0)

    expect(repos.projects.list()).toHaveLength(3)
    expect(repos.employees.list()).toHaveLength(5)
    expect(repos.skills.list()).toHaveLength(11)
  })

  test('幂等：二次跑跳过已存在项；skipped 计数正确', () => {
    const { db, sqlite } = openDatabase({ path: ':memory:' })
    migrate(sqlite)
    const repos = createRepos(db)
    seedAll(repos)
    const r2 = seedAll(repos)
    expect(r2.projects).toBe(0)
    expect(r2.employees).toBe(0)
    expect(r2.skills).toBe(0)
    expect(r2.skipped.projects).toBe(3)
    expect(r2.skipped.employees).toBe(5)
    expect(r2.skipped.skills).toBe(11)
  })

  test('员工与技能挂载正确（小后 ← API 设计 / 数据库设计 / ...）', () => {
    const { db, sqlite } = openDatabase({ path: ':memory:' })
    migrate(sqlite)
    const repos = createRepos(db)
    seedAll(repos)
    const houend = repos.employees.list().find((e) => e.name === '小后')!
    expect(houend.role).toBe('后端开发')
    const skills = repos.skills.listForEmployee(houend.id)
    expect(skills.map((s) => s.skill.name)).toEqual([
      'API 设计',
      '数据库设计',
      '代码生成与解释',
      '需求拆解',
      'Bug 分析',
    ])
  })

  test('五个员工角色齐全', () => {
    const { db, sqlite } = openDatabase({ path: ':memory:' })
    migrate(sqlite)
    const repos = createRepos(db)
    seedAll(repos)
    const roles = repos.employees
      .list()
      .map((e) => e.role)
      .sort()
    expect(roles).toEqual(['UI 设计师', '产品经理', '后端开发', '前端开发', '测试工程师'].sort())
  })

  test('样板员工的 model 字段全部是 env:// 引用', () => {
    const { db, sqlite } = openDatabase({ path: ':memory:' })
    migrate(sqlite)
    const repos = createRepos(db)
    seedAll(repos)
    const emps = repos.employees.list()
    for (const e of emps) {
      expect(e.modelKeyRef).toStartWith('env://')
      expect(e.modelName).toStartWith('env://')
      expect(e.modelProvider).toBe('anthropic')
    }
  })
})

describe('seedReset（真删，不是 archive）', () => {
  test('清空当前样板（含 archived 不残留）+ 重导入', () => {
    const { db, sqlite } = openDatabase({ path: ':memory:' })
    migrate(sqlite)
    const repos = createRepos(db)
    seedAll(repos)
    expect(repos.employees.list()).toHaveLength(5)

    const r = seedReset(repos, sqlite)
    expect(r.employees).toBe(5)
    // 真删后总数仍是 5（不是 10），无 archived 残留
    const allEmps = repos.employees.list()
    expect(allEmps).toHaveLength(5)
    expect(allEmps.every((e) => e.status === 'active')).toBe(true)

    // 技能也是 11（不是 22）
    expect(repos.skills.list()).toHaveLength(11)
    // 项目 3（不是 6）
    expect(repos.projects.list()).toHaveLength(3)
  })

  test('保留用户自建的员工 / 项目 / 技能', () => {
    const { db, sqlite } = openDatabase({ path: ':memory:' })
    migrate(sqlite)
    const repos = createRepos(db)
    seedAll(repos)
    const userEmp = repos.employees.create({
      name: '我自己',
      role: '杂工',
      modelProvider: 'anthropic',
      modelName: 'env://X',
      modelKeyRef: 'env://Y',
    })
    const userProj = repos.projects.create({ name: '我的项目', description: '' })
    const userSkill = repos.skills.create({
      name: '自创技能',
      category: '通用',
      description: '',
      promptTemplate: '',
    })

    seedReset(repos, sqlite)
    expect(repos.employees.findById(userEmp)).not.toBeNull()
    expect(repos.projects.findById(userProj)).not.toBeNull()
    expect(repos.skills.findById(userSkill)).not.toBeNull()
  })

  test('引用过样板员工的用户 requirement 的 assignee_id 被 NULL 化', () => {
    const { db, sqlite } = openDatabase({ path: ':memory:' })
    migrate(sqlite)
    const repos = createRepos(db)
    seedAll(repos)
    const xiaohou = repos.employees.list().find((e) => e.name === '小后')!

    const userProj = repos.projects.create({ name: '我的项目', description: '' })
    const reqId = repos.requirements.create({
      title: '需求 X',
      description: 'D',
      projectId: userProj,
      assigneeId: xiaohou.id,
      budgetCap: { maxIterations: 30, maxTokens: 100, maxWallTimeMs: 1000 },
    })

    seedReset(repos, sqlite)
    const after = repos.requirements.findById(reqId)!
    expect(after.assigneeId).toBeNull()
  })
})
