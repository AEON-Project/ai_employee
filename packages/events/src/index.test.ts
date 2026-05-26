import { describe, test, expect, beforeEach } from 'bun:test'
import { TypedEventBus, bus, parsePayload, safeParsePayload, eventSchemas } from './index.js'
import type { EventMap } from './event-map.js'

describe('TypedEventBus', () => {
  beforeEach(() => bus.clear())

  test('emit → on 收到正确 payload', () => {
    const received: EventMap['requirement.state_changed'][] = []
    bus.on('requirement.state_changed', (p) => received.push(p))

    bus.emit('requirement.state_changed', {
      reqId: 'r1',
      from: '待澄清',
      to: '进行中',
    })
    bus.emit('requirement.state_changed', {
      reqId: 'r2',
      from: '进行中',
      to: '待验收',
      reason: 'emit_deliverable',
    })

    expect(received).toHaveLength(2)
    expect(received[0]).toEqual({ reqId: 'r1', from: '待澄清', to: '进行中' })
    expect(received[1]?.reason).toBe('emit_deliverable')
  })

  test('unsubscribe 后不再收到', () => {
    let count = 0
    const off = bus.on('requirement.frame', () => count++)

    bus.emit('requirement.frame', {
      reqId: 'r1',
      currentStep: 0,
      budgetUsed: { iterations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0 },
    })
    expect(count).toBe(1)

    off()
    bus.emit('requirement.frame', {
      reqId: 'r1',
      currentStep: 1,
      budgetUsed: { iterations: 1, tokensIn: 0, tokensOut: 0, wallTimeMs: 0 },
    })
    expect(count).toBe(1)
  })

  test('监听器抛错不影响其他监听器', () => {
    const fired: string[] = []
    bus.on('requirement.created', () => {
      throw new Error('boom')
    })
    bus.on('requirement.created', () => fired.push('B'))
    bus.on('requirement.created', () => fired.push('C'))

    // 静默 console.error，避免污染测试输出
    const orig = console.error
    console.error = () => {}
    bus.emit('requirement.created', { reqId: 'r1' })
    console.error = orig

    expect(fired).toEqual(['B', 'C'])
  })

  test('listenerCount 反映订阅数量', () => {
    expect(bus.listenerCount('budget.warning')).toBe(0)
    const off1 = bus.on('budget.warning', () => {})
    bus.on('budget.warning', () => {})
    expect(bus.listenerCount('budget.warning')).toBe(2)
    off1()
    expect(bus.listenerCount('budget.warning')).toBe(1)
  })

  test('独立实例彼此隔离', () => {
    const a = new TypedEventBus<EventMap>()
    const b = new TypedEventBus<EventMap>()
    let aHit = 0
    let bHit = 0
    a.on('requirement.cancelled', () => aHit++)
    b.on('requirement.cancelled', () => bHit++)
    a.emit('requirement.cancelled', { reqId: 'x' })
    expect(aHit).toBe(1)
    expect(bHit).toBe(0)
  })
})

describe('eventSchemas（运行期校验）', () => {
  test('parsePayload 接受合法 payload', () => {
    const p = parsePayload('requirement.state_changed', {
      reqId: 'r1',
      from: '待澄清',
      to: '进行中',
    })
    expect(p.to).toBe('进行中')
  })

  test('parsePayload 拒绝非法 status', () => {
    expect(() =>
      parsePayload('requirement.state_changed', {
        reqId: 'r1',
        from: 'unknown',
        to: '进行中',
      }),
    ).toThrow()
  })

  test('safeParsePayload 返回结构化错误', () => {
    const r = safeParsePayload('budget.warning', {
      reqId: 'r1',
      gate: 'iterations',
      used: -1, // 非法：负数
      cap: 30,
    })
    expect(r.ok).toBe(false)
  })

  test('所有事件名都有 schema', () => {
    const names: (keyof EventMap)[] = [
      'requirement.created',
      'requirement.state_changed',
      'requirement.clarification_ready',
      'requirement.clarification_answered',
      'requirement.frame',
      'requirement.deliverable_ready',
      'requirement.completed',
      'requirement.rejected',
      'requirement.cancelled',
      'requirement.paused',
      'message.appended',
      'tool.invoked',
      'tool.result',
      'tool.failed',
      'budget.warning',
      'budget.exceeded',
      'context.compacted',
      'memory.recalled',
      'memory.persisted',
      'memory.pending_review',
      'runtime.heartbeat',
      'runtime.recovered',
      'runtime.scheduler_state',
      'tg.message_received',
      'tg.message_sent',
      'tg.error',
    ]
    for (const n of names) {
      expect(eventSchemas[n]).toBeDefined()
    }
    expect(names.length).toBe(Object.keys(eventSchemas).length)
  })

  test('schema 与 EventMap 类型对齐（编译期 satisfies + 运行期 round-trip）', () => {
    const payload: EventMap['memory.recalled'] = {
      reqId: 'r1',
      scope: 'project',
      items: [
        {
          id: 'm1',
          scope: 'project',
          scopeId: 'p1',
          kind: 'fact',
          content: '本项目用 Zustand',
        },
      ],
    }
    const parsed = parsePayload('memory.recalled', payload)
    expect(parsed.items[0]?.kind).toBe('fact')
  })
})
