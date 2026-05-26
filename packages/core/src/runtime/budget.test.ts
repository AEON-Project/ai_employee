import { describe, expect, test } from 'bun:test'
import { DEFAULT_BUDGET_CAP, type BudgetCap } from '@ai-emp/domain'
import { BudgetTracker, ratiosOf } from './budget.js'

const SMALL_CAP: BudgetCap = {
  maxIterations: 10,
  maxTokens: 1000,
  maxWallTimeMs: 10_000,
}

describe('BudgetTracker', () => {
  test('未触达任何阈值返回 ok', () => {
    const b = new BudgetTracker(SMALL_CAP)
    b.startWallClock(0)
    b.recordIteration()
    b.recordTokens(100, 50)
    const r = b.check(1000)
    expect(r.kind).toBe('ok')
    expect(r.ratios.max).toBeLessThan(0.8)
  })

  test('iterations 80% → warning', () => {
    const b = new BudgetTracker(SMALL_CAP)
    b.startWallClock(0)
    for (let i = 0; i < 8; i++) b.recordIteration()
    const r = b.check(0)
    expect(r.kind).toBe('warning')
    if (r.kind === 'warning') {
      expect(r.gate).toBe('iterations')
      expect(r.used).toBe(8)
    }
  })

  test('warning 同一 gate 只发一次', () => {
    const b = new BudgetTracker(SMALL_CAP)
    b.startWallClock(0)
    for (let i = 0; i < 8; i++) b.recordIteration()
    expect(b.check(0).kind).toBe('warning')
    b.recordIteration()
    expect(b.check(0).kind).toBe('ok') // 已发过 warning，9/10 不再触发
  })

  test('iterations 100% → exceeded', () => {
    const b = new BudgetTracker(SMALL_CAP)
    b.startWallClock(0)
    for (let i = 0; i < 10; i++) b.recordIteration()
    const r = b.check(0)
    expect(r.kind).toBe('exceeded')
    if (r.kind === 'exceeded') {
      expect(r.gate).toBe('iterations')
    }
  })

  test('tokens 100% → exceeded', () => {
    const b = new BudgetTracker(SMALL_CAP)
    b.startWallClock(0)
    b.recordTokens(500, 500)
    const r = b.check(0)
    expect(r.kind).toBe('exceeded')
    if (r.kind === 'exceeded') {
      expect(r.gate).toBe('tokens')
    }
  })

  test('wallTime 100% → exceeded', () => {
    const b = new BudgetTracker(SMALL_CAP)
    b.startWallClock(0)
    const r = b.check(10_000)
    expect(r.kind).toBe('exceeded')
    if (r.kind === 'exceeded') {
      expect(r.gate).toBe('wallTime')
    }
  })

  test('snapshot 包含累计 wallTime', () => {
    const b = new BudgetTracker(SMALL_CAP)
    b.startWallClock(0)
    b.recordTokens(10, 20)
    const s = b.snapshot(5000)
    expect(s.wallTimeMs).toBe(5000)
    expect(s.tokensIn).toBe(10)
    expect(s.tokensOut).toBe(20)
  })

  test('从已用快照恢复', () => {
    const b = new BudgetTracker(SMALL_CAP, {
      iterations: 5,
      tokensIn: 200,
      tokensOut: 100,
      wallTimeMs: 3000,
    })
    b.startWallClock(10_000) // 模拟新进程在 10s 时启动
    const s = b.snapshot(11_000)
    expect(s.iterations).toBe(5)
    expect(s.wallTimeMs).toBe(4000) // 3000 + 1000
  })

  test('pauseReasonOf 映射', () => {
    expect(BudgetTracker.pauseReasonOf('iterations')).toBe('budget_iterations')
    expect(BudgetTracker.pauseReasonOf('tokens')).toBe('budget_tokens')
    expect(BudgetTracker.pauseReasonOf('wallTime')).toBe('budget_walltime')
  })
})

describe('ratiosOf', () => {
  test('计算正确', () => {
    const r = ratiosOf(
      { iterations: 15, tokensIn: 50000, tokensOut: 50000, wallTimeMs: 900_000 },
      DEFAULT_BUDGET_CAP,
    )
    expect(r.iterations).toBe(0.5)
    expect(r.tokens).toBe(0.5)
    expect(r.wallTime).toBe(0.5)
    expect(r.max).toBe(0.5)
  })
})
