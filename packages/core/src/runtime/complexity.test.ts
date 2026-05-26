import { describe, expect, test } from 'bun:test'
import { decideClarify, heuristicEvaluator } from './complexity.js'

describe('decideClarify', () => {
  const baseEval = { complexity: 'standard' as const, rationale: 'r' }

  test('smart + simple → 跳过', () => {
    const r = decideClarify({
      evaluation: { complexity: 'simple', rationale: 'short' },
      policy: 'smart',
    })
    expect(r.shouldClarify).toBe(false)
  })

  test('smart + standard → 澄清', () => {
    expect(decideClarify({ evaluation: baseEval, policy: 'smart' }).shouldClarify).toBe(true)
  })

  test('smart + complex → 澄清', () => {
    expect(
      decideClarify({
        evaluation: { complexity: 'complex', rationale: '' },
        policy: 'smart',
      }).shouldClarify,
    ).toBe(true)
  })

  test('always_clarify 覆盖 simple', () => {
    expect(
      decideClarify({
        evaluation: { complexity: 'simple', rationale: '' },
        policy: 'always_clarify',
      }).shouldClarify,
    ).toBe(true)
  })

  test('always_skip 覆盖 complex', () => {
    expect(
      decideClarify({
        evaluation: { complexity: 'complex', rationale: '' },
        policy: 'always_skip',
      }).shouldClarify,
    ).toBe(false)
  })

  test('forceClarify 优先于 always_skip', () => {
    const r = decideClarify({
      evaluation: { complexity: 'simple', rationale: '' },
      policy: 'always_skip',
      forceClarify: true,
    })
    expect(r.shouldClarify).toBe(true)
    expect(r.reason).toContain('force')
  })
})

describe('heuristicEvaluator', () => {
  test('短文本 + simple 关键词', () => {
    expect(heuristicEvaluator('帮我翻译').complexity).toBe('simple')
  })

  test('含重构关键词', () => {
    expect(heuristicEvaluator('重构整个 codebase').complexity).toBe('complex')
  })

  test('默认 standard', () => {
    expect(heuristicEvaluator('写一段落地页文案，800 字面向开发者').complexity).toBe('standard')
  })
})
