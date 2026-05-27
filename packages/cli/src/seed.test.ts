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

describe('seedReset', () => {
  test('清空当前样板员工 + 重新导入', () => {
    const { db, sqlite } = openDatabase({ path: ':memory:' })
    migrate(sqlite)
    const repos = createRepos(db)
    seedAll(repos)
    expect(repos.employees.list().filter((e) => e.status === 'active')).toHaveLength(5)

    const r = seedReset(repos)
    expect(r.employees).toBe(5) // 5 个新建（旧的已 archive）
    expect(repos.employees.list().filter((e) => e.status === 'active')).toHaveLength(5)
    expect(repos.employees.list().filter((e) => e.status === 'archived')).toHaveLength(5)
  })
})
