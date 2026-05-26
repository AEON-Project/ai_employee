import { describe, test, expect } from 'bun:test'
import {
  BudgetCapZ,
  BudgetUsedZ,
  ClarificationQuestionZ,
  DEFAULT_BUDGET_CAP,
  MessageContentZ,
  ModelConfigZ,
  PlanZ,
  REQUIREMENT_STATUSES,
  ReportMetricsZ,
  RequirementStatusZ,
  type Plan,
  type RequirementStatus,
} from './index.js'

describe('domain enums', () => {
  test('REQUIREMENT_STATUSES 9 项与 schema 对齐', () => {
    expect(REQUIREMENT_STATUSES).toHaveLength(9)
    for (const s of REQUIREMENT_STATUSES) {
      expect(RequirementStatusZ.parse(s)).toBe(s as RequirementStatus)
    }
  })

  test('非法 status 被 Z 拒绝', () => {
    expect(() => RequirementStatusZ.parse('unknown')).toThrow()
  })
})

describe('Budget', () => {
  test('DEFAULT_BUDGET_CAP 通过校验', () => {
    expect(BudgetCapZ.parse(DEFAULT_BUDGET_CAP).maxIterations).toBe(30)
  })

  test('BudgetCap 必须正数', () => {
    expect(() =>
      BudgetCapZ.parse({ maxIterations: 0, maxTokens: 100, maxWallTimeMs: 1000 }),
    ).toThrow()
  })

  test('BudgetUsed 接受 0', () => {
    expect(
      BudgetUsedZ.parse({ iterations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0 }).iterations,
    ).toBe(0)
  })
})

describe('Plan', () => {
  test('合法 plan parse 通过', () => {
    const p: Plan = {
      steps: [
        { idx: 0, text: '分析需求', status: 'done' },
        { idx: 1, text: '起草', status: 'doing' },
        { idx: 2, text: '自检', status: 'pending' },
      ],
    }
    expect(PlanZ.parse(p).steps).toHaveLength(3)
  })

  test('非法 step status 被拒', () => {
    expect(() => PlanZ.parse({ steps: [{ idx: 0, text: 'x', status: 'unknown' }] })).toThrow()
  })
})

describe('ClarificationQuestion', () => {
  test('answer 可选', () => {
    expect(
      ClarificationQuestionZ.parse({ question: '目标用户?', answerMode: 'user' }).question,
    ).toBe('目标用户?')
  })

  test('answerMode 非法被拒', () => {
    expect(() => ClarificationQuestionZ.parse({ question: 'x', answerMode: 'invalid' })).toThrow()
  })
})

describe('ModelConfig', () => {
  test('Anthropic + 无 baseUrl', () => {
    const m = ModelConfigZ.parse({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      keyRef: 'keychain://k1',
    })
    expect(m.provider).toBe('anthropic')
  })

  test('OpenAI 兼容 + baseUrl', () => {
    const m = ModelConfigZ.parse({
      provider: 'openai-compat',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      keyRef: 'keychain://k2',
    })
    expect(m.baseUrl).toContain('deepseek')
  })

  test('temperature 越界被拒', () => {
    expect(() =>
      ModelConfigZ.parse({
        provider: 'anthropic',
        model: 'x',
        keyRef: 'k',
        temperature: 5,
      }),
    ).toThrow()
  })
})

describe('MessageContent discriminated union', () => {
  test('text 形态', () => {
    const c = MessageContentZ.parse({ type: 'text', text: 'hi' })
    expect(c.type).toBe('text')
  })

  test('tool_call 形态', () => {
    const c = MessageContentZ.parse({
      type: 'tool_call',
      name: 'ask_user',
      args: { q: 'why?' },
      callId: 'c1',
    })
    expect(c.type).toBe('tool_call')
  })

  test('plan_update 形态嵌套 PlanZ', () => {
    const c = MessageContentZ.parse({
      type: 'plan_update',
      plan: { steps: [{ idx: 0, text: 'a', status: 'pending' }] },
      reason: '用户改步骤',
    })
    expect(c.type).toBe('plan_update')
  })

  test('未知 type 被拒', () => {
    expect(() => MessageContentZ.parse({ type: 'unknown' })).toThrow()
  })
})

describe('ReportMetrics', () => {
  test('完整 metrics', () => {
    const m = ReportMetricsZ.parse({
      durationMs: 1500,
      tokens: { input: 100, output: 50, cached: 30 },
      iterations: 5,
      rejected: false,
    })
    expect(m.tokens.cached).toBe(30)
  })
})
