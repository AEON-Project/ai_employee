/**
 * V2 O5 Cron parser 单测
 */
import { describe, expect, test } from 'bun:test'
import { parseCron, shouldTriggerCron } from './index.js'

describe('parseCron - every N minutes/hours', () => {
  test('every 5 minutes → next = from + 5min', () => {
    const s = parseCron('every 5 minutes')!
    expect(s).not.toBeNull()
    const from = new Date('2026-05-27T10:00:00.000Z')
    const next = s.nextAt(from)!
    expect(next.getTime() - from.getTime()).toBe(5 * 60_000)
    expect(s.describe()).toBe('every 5 minutes')
  })

  test('every 1 hour', () => {
    const s = parseCron('every 1 hour')!
    expect(s).not.toBeNull()
    expect(s.describe()).toBe('every 1 hours')
  })

  test('every 0 minutes → 无效', () => {
    expect(parseCron('every 0 minutes')).toBeNull()
  })
})

describe('parseCron - daily HH:MM', () => {
  test('daily 09:00 from 早上 8 点 → 当天 9 点', () => {
    const s = parseCron('daily 09:00')!
    expect(s).not.toBeNull()
    const from = new Date(2026, 4, 27, 8, 0, 0) // 2026-05-27 08:00 local
    const next = s.nextAt(from)!
    expect(next.getHours()).toBe(9)
    expect(next.getMinutes()).toBe(0)
    expect(next.getDate()).toBe(27)
  })

  test('daily 09:00 from 上午 10 点 → 次日 9 点', () => {
    const s = parseCron('daily 09:00')!
    const from = new Date(2026, 4, 27, 10, 0, 0) // 2026-05-27 10:00 local
    const next = s.nextAt(from)!
    expect(next.getDate()).toBe(28)
    expect(next.getHours()).toBe(9)
  })

  test('daily 25:00 → 无效', () => {
    expect(parseCron('daily 25:00')).toBeNull()
  })
})

describe('parseCron - weekly DAY HH:MM', () => {
  test('weekly mon 09:00 from 周一上午 8 点 → 当天 9 点', () => {
    const s = parseCron('weekly mon 09:00')!
    expect(s).not.toBeNull()
    // 2026-05-25 是周一
    const from = new Date(2026, 4, 25, 8, 0, 0)
    const next = s.nextAt(from)!
    expect(next.getDay()).toBe(1) // 周一
    expect(next.getDate()).toBe(25)
    expect(next.getHours()).toBe(9)
  })

  test('weekly mon 09:00 from 周一上午 10 点 → 下周一', () => {
    const s = parseCron('weekly mon 09:00')!
    const from = new Date(2026, 4, 25, 10, 0, 0)
    const next = s.nextAt(from)!
    // 5/25 + 7 跨月到 6/1（5 月只有 31 天）
    expect(next.getMonth()).toBe(5) // June (0-indexed)
    expect(next.getDate()).toBe(1)
    expect(next.getDay()).toBe(1) // 周一
    expect(next.getHours()).toBe(9)
  })

  test('weekly fri 18:00 from 周一 → 同周五', () => {
    const s = parseCron('weekly fri 18:00')!
    const from = new Date(2026, 4, 25, 10, 0, 0) // 周一
    const next = s.nextAt(from)!
    expect(next.getDay()).toBe(5)
    expect(next.getDate()).toBe(29)
    expect(next.getHours()).toBe(18)
  })

  test('weekly bad day → 无效', () => {
    expect(parseCron('weekly xyz 09:00')).toBeNull()
  })
})

describe('parseCron 边界', () => {
  test('空串 / 乱写 → null', () => {
    expect(parseCron('')).toBeNull()
    expect(parseCron('whenever')).toBeNull()
    expect(parseCron('every minutes')).toBeNull()
  })

  test('大小写不敏感', () => {
    expect(parseCron('DAILY 09:00')).not.toBeNull()
    expect(parseCron('Every 5 Minutes')).not.toBeNull()
  })
})

describe('shouldTriggerCron', () => {
  test('lastRunAt 之后 5 分钟 + every 5 minutes → 该触发', () => {
    const s = parseCron('every 5 minutes')!
    const lastRunAt = new Date(2026, 4, 27, 10, 0, 0)
    const now = new Date(2026, 4, 27, 10, 5, 0)
    expect(shouldTriggerCron({ spec: s, lastRunAt, createdAt: lastRunAt, now })).toBe(true)
  })

  test('lastRunAt 之后 2 分钟 + every 5 minutes → 不该触发', () => {
    const s = parseCron('every 5 minutes')!
    const lastRunAt = new Date(2026, 4, 27, 10, 0, 0)
    const now = new Date(2026, 4, 27, 10, 2, 0)
    expect(shouldTriggerCron({ spec: s, lastRunAt, createdAt: lastRunAt, now })).toBe(false)
  })

  test('lastRunAt=null → 用 createdAt 作 base', () => {
    const s = parseCron('every 5 minutes')!
    const createdAt = new Date(2026, 4, 27, 10, 0, 0)
    const now = new Date(2026, 4, 27, 10, 6, 0)
    expect(shouldTriggerCron({ spec: s, lastRunAt: null, createdAt, now })).toBe(true)
  })
})
