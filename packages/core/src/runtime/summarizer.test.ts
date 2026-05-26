import { describe, expect, test } from 'bun:test'
import { createRepos, migrate, openDatabase } from '@ai-emp/storage'
import { DEFAULT_BUDGET_CAP } from '@ai-emp/domain'
import { compactThreadHistory, estimateTokens, shouldCompact } from './summarizer.js'

describe('estimateTokens / shouldCompact', () => {
  test('estimateTokens 粗略字符 / 2 × 1.2', () => {
    expect(estimateTokens([{ content: 'hello' }, { content: 'world' }])).toBe(6)
  })

  test('shouldCompact 阈值判定', () => {
    expect(shouldCompact(100, 1000)).toBe(false)
    expect(shouldCompact(900, 1000)).toBe(true)
    expect(shouldCompact(700, 1000, 0.7)).toBe(false)
  })
})

describe('compactThreadHistory', () => {
  test('压缩早期 N 条；保留最近 K 条', async () => {
    const { db, sqlite } = openDatabase({ path: ':memory:' })
    migrate(sqlite)
    const repos = createRepos(db)
    const rid = repos.requirements.create({
      title: 'T',
      description: 'D',
      budgetCap: DEFAULT_BUDGET_CAP,
    })
    const tid = repos.threads.createForRequirement(rid)
    for (let i = 0; i < 10; i++) {
      repos.messages.append({
        threadId: tid,
        role: 'assistant',
        type: 'text',
        content: { type: 'text', text: `msg ${i}` },
      })
    }

    const r = await compactThreadHistory(repos, {
      threadId: tid,
      keepRecent: 3,
      summarize: async (text) => `SUMMARY: ${text.length} chars`,
    })
    expect(r.compactedCount).toBe(7)
    expect(r.summary).toContain('SUMMARY')
  })

  test('消息少于 keepRecent → 不压缩', async () => {
    const { db, sqlite } = openDatabase({ path: ':memory:' })
    migrate(sqlite)
    const repos = createRepos(db)
    const rid = repos.requirements.create({
      title: 'T',
      description: 'D',
      budgetCap: DEFAULT_BUDGET_CAP,
    })
    const tid = repos.threads.createForRequirement(rid)
    for (let i = 0; i < 2; i++) {
      repos.messages.append({
        threadId: tid,
        role: 'user',
        type: 'text',
        content: { type: 'text', text: 'x' },
      })
    }
    const r = await compactThreadHistory(repos, {
      threadId: tid,
      keepRecent: 10,
      summarize: async () => 'never',
    })
    expect(r.compactedCount).toBe(0)
    expect(r.summary).toBe('')
  })
})
