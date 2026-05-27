import { describe, expect, test } from 'bun:test'
import { createRepos, migrate, openDatabase } from '@ai-emp/storage'
import { seedAll } from './seed.js'

describe('seedAll', () => {
  test('首次导入 3 项目 + 5 员工 + 8 技能 + 若干规范', () => {
    const { db, sqlite } = openDatabase({ path: ':memory:' })
    migrate(sqlite)
    const repos = createRepos(db)

    const r = seedAll(repos)
    expect(r.projects).toBe(3)
    expect(r.employees).toBe(5)
    expect(r.skills).toBe(8)
    expect(r.conventions).toBeGreaterThan(5)

    expect(repos.projects.list()).toHaveLength(3)
    expect(repos.employees.list()).toHaveLength(5)
    expect(repos.skills.list()).toHaveLength(8)
  })

  test('幂等：二次跑跳过已存在项', () => {
    const { db, sqlite } = openDatabase({ path: ':memory:' })
    migrate(sqlite)
    const repos = createRepos(db)
    seedAll(repos)
    const r2 = seedAll(repos)
    expect(r2.projects).toBe(0)
    expect(r2.employees).toBe(0)
    expect(r2.skills).toBe(0)
  })

  test('员工与技能挂载正确（小李 ← 代码生成与解释 + 需求拆解）', () => {
    const { db, sqlite } = openDatabase({ path: ':memory:' })
    migrate(sqlite)
    const repos = createRepos(db)
    seedAll(repos)
    const xiaoli = repos.employees.list().find((e) => e.name === '小李')!
    const skills = repos.skills.listForEmployee(xiaoli.id)
    expect(skills.map((s) => s.skill.name)).toEqual(['代码生成与解释', '需求拆解'])
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
    }
    const deepseek = emps.find((e) => e.name === '小数')!
    expect(deepseek.modelBaseUrl).toStartWith('env://')
    expect(deepseek.modelProvider).toBe('openai-compat')
  })
})
