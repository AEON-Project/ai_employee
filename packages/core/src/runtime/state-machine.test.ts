import { describe, expect, test } from 'bun:test'
import {
  IllegalTransition,
  canTransition,
  isExecuting,
  isTerminal,
  listAllowedEvents,
  transition,
  type RequirementEvent,
} from './state-machine.js'
import { REQUIREMENT_STATUSES, type RequirementStatus } from '@ai-emp/domain'

describe('transition()', () => {
  test('待分派 + assign(skip) → 进行中', () => {
    const r = transition('待分派', { kind: 'assign', skipClarification: true })
    expect(r.to).toBe('进行中')
  })

  test('待分派 + assign(无 skip) → 待澄清', () => {
    const r = transition('待分派', { kind: 'assign', skipClarification: false })
    expect(r.to).toBe('待澄清')
  })

  test('待澄清 + clarify_confirmed → 进行中', () => {
    expect(transition('待澄清', { kind: 'clarify_confirmed' }).to).toBe('进行中')
  })

  test('进行中 + ask_user → 等待回答', () => {
    expect(transition('进行中', { kind: 'ask_user' }).to).toBe('等待回答')
  })

  test('等待回答 + answer → 进行中', () => {
    expect(transition('等待回答', { kind: 'answer' }).to).toBe('进行中')
  })

  test('进行中 + system_pause → 已暂停（reason 带前缀）', () => {
    const r = transition('进行中', { kind: 'system_pause', reason: 'budget_iterations' })
    expect(r.to).toBe('已暂停')
    expect(r.reason).toContain('budget_iterations')
  })

  test('已暂停 + resume → 进行中', () => {
    expect(transition('已暂停', { kind: 'resume' }).to).toBe('进行中')
  })

  test('进行中 + deliver → 待验收', () => {
    expect(transition('进行中', { kind: 'deliver' }).to).toBe('待验收')
  })

  test('待验收 + approve/reject → 已完成/已驳回', () => {
    expect(transition('待验收', { kind: 'approve' }).to).toBe('已完成')
    expect(transition('待验收', { kind: 'reject' }).to).toBe('已驳回')
  })

  test('进行中 + force_end(keep) → 已完成；force_end(discard) → 已取消', () => {
    expect(transition('进行中', { kind: 'force_end', keep: true }).to).toBe('已完成')
    expect(transition('进行中', { kind: 'force_end', keep: false }).to).toBe('已取消')
  })

  test('待澄清/等待回答/已暂停 + cancel → 已取消', () => {
    for (const s of ['待澄清', '等待回答', '已暂停'] as const) {
      expect(transition(s, { kind: 'cancel' }).to).toBe('已取消')
    }
  })

  test('终态不允许转移', () => {
    for (const s of ['已完成', '已驳回', '已取消'] as const) {
      expect(() => transition(s, { kind: 'resume' })).toThrow(IllegalTransition)
    }
  })

  test('非法转移抛 IllegalTransition', () => {
    const ev: RequirementEvent = { kind: 'approve' }
    expect(() => transition('进行中', ev)).toThrow(IllegalTransition)
    expect(() => transition('待澄清', { kind: 'ask_user' })).toThrow(IllegalTransition)
    expect(() => transition('待分派', { kind: 'answer' })).toThrow(IllegalTransition)
  })
})

describe('canTransition()', () => {
  test('合法返回 result，非法返回 null', () => {
    expect(canTransition('进行中', { kind: 'ask_user' })?.to).toBe('等待回答')
    expect(canTransition('进行中', { kind: 'approve' })).toBeNull()
  })
})

describe('listAllowedEvents()', () => {
  test('待分派 允许 assign + cancel', () => {
    const e = listAllowedEvents('待分派').sort()
    expect(e).toEqual(['assign', 'cancel'])
  })

  test('进行中 允许 ask_user/deliver/暂停/force_end', () => {
    const e = new Set(listAllowedEvents('进行中'))
    expect(e.has('ask_user')).toBe(true)
    expect(e.has('deliver')).toBe(true)
    expect(e.has('user_pause')).toBe(true)
    expect(e.has('system_pause')).toBe(true)
    expect(e.has('force_end')).toBe(true)
    expect(e.has('approve')).toBe(false)
  })

  test('终态空集', () => {
    expect(listAllowedEvents('已完成')).toEqual([])
    expect(listAllowedEvents('已驳回')).toEqual([])
    expect(listAllowedEvents('已取消')).toEqual([])
  })
})

describe('isTerminal / isExecuting', () => {
  test('终态判断', () => {
    expect(isTerminal('已完成')).toBe(true)
    expect(isTerminal('已驳回')).toBe(true)
    expect(isTerminal('已取消')).toBe(true)
    expect(isTerminal('进行中')).toBe(false)
  })

  test('只有进行中是执行态', () => {
    for (const s of REQUIREMENT_STATUSES) {
      expect(isExecuting(s)).toBe(s === '进行中')
    }
  })
})

describe('全状态覆盖', () => {
  test('每个非终态至少有 1 个合法 event', () => {
    const nonTerminal: RequirementStatus[] = REQUIREMENT_STATUSES.filter((s) => !isTerminal(s))
    for (const s of nonTerminal) {
      expect(listAllowedEvents(s).length).toBeGreaterThan(0)
    }
  })
})
