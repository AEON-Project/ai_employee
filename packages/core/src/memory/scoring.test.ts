import { describe, expect, test } from 'bun:test'
import { createRepos, migrate, openDatabase } from '@ai-emp/storage'
import { computeImportance, recencyScore, rescoreAll } from './scoring.js'

describe('computeImportance', () => {
  test('positive + 高 hit + 刚命中 + manual → 接近 1', () => {
    const s = computeImportance(
      {
        hitCount: 100,
        userFeedback: 'positive',
        lastHitAtMs: 1_000_000,
        source: 'manual',
      },
      { now: 1_000_000 },
    )
    expect(s).toBeGreaterThan(0.85)
  })

  test('negative + 久未命中 + auto → 接近 0', () => {
    const s = computeImportance(
      {
        hitCount: 0,
        userFeedback: 'negative',
        lastHitAtMs: 0,
        source: 'auto',
      },
      { now: 100 * 24 * 3600 * 1000 },
    )
    expect(s).toBeLessThan(0.15)
  })

  test('none feedback 中庸', () => {
    const s = computeImportance(
      {
        hitCount: 5,
        userFeedback: 'none',
        lastHitAtMs: 1000,
        source: 'auto',
      },
      { now: 1000 },
    )
    expect(s).toBeGreaterThan(0.4)
    expect(s).toBeLessThan(0.8)
  })

  test('recencyScore 越近越高', () => {
    expect(recencyScore(0, 0)).toBe(1)
    expect(recencyScore(0, 30 * 24 * 3600 * 1000)).toBeCloseTo(Math.exp(-1), 3)
    expect(recencyScore(null, 1000)).toBe(0)
  })
})

describe('rescoreAll', () => {
  test('低分 + 30 天未命中 → archive', () => {
    const { db, sqlite } = openDatabase({ path: ':memory:' })
    migrate(sqlite)
    const repos = createRepos(db)
    const pid = repos.projects.create({ name: 'P' })
    // 写一个旧条目（30+ 天前）
    const old = new Date(Date.now() - 60 * 24 * 3600 * 1000)
    const id = repos.memoryItems.create({
      scope: 'project',
      scopeId: pid,
      kind: 'fact',
      content: '陈年信息',
      importanceScore: 0.5,
    })
    // 把 hitCount 设为 0 + lastHitAt 设为 60 天前；后者需要走 SQL
    sqlite.exec(
      `UPDATE memory_items SET hit_count = 0, last_hit_at = ${old.getTime()}, user_feedback = 'negative' WHERE id = '${id}'`,
    )

    const r = rescoreAll(repos, [{ scope: 'project', scopeId: pid }])
    expect(r.scanned).toBe(1)
    expect(r.archived).toBe(1)
    const after = repos.memoryItems.findById(id)
    expect(after?.archived).toBe(true)
  })

  test('高分条目不归档', () => {
    const { db, sqlite } = openDatabase({ path: ':memory:' })
    migrate(sqlite)
    const repos = createRepos(db)
    const pid = repos.projects.create({ name: 'P' })
    const id = repos.memoryItems.create({
      scope: 'project',
      scopeId: pid,
      kind: 'fact',
      content: '重要',
      importanceScore: 0.3,
    })
    sqlite.exec(
      `UPDATE memory_items SET hit_count = 50, last_hit_at = ${Date.now()}, user_feedback = 'positive' WHERE id = '${id}'`,
    )

    const r = rescoreAll(repos, [{ scope: 'project', scopeId: pid }])
    expect(r.archived).toBe(0)
    const after = repos.memoryItems.findById(id)
    expect(after?.importanceScore).toBeGreaterThan(0.7)
  })
})
