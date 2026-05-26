/**
 * 复杂度阈值评估 — PRD §5.1。
 *
 * LLM 在接需求后先评估 simple / standard / complex：
 *   - simple        → 跳过澄清直接执行
 *   - standard/complex → 走澄清卡片
 *
 * 用户全局开关：always_clarify / smart (默认) / always_skip
 * 强制澄清条件：命中 pitfall / 工具未授权（β 阶段扩展）
 *
 * α 阶段简化策略：调用方提供 evaluator；本模块只暴露类型 + 决策函数。
 */

export type Complexity = 'simple' | 'standard' | 'complex'
export type ClarifyPolicy = 'smart' | 'always_clarify' | 'always_skip'

export interface ComplexityEvaluation {
  complexity: Complexity
  /** ≤ 50 字理由（会写入思维链开头） */
  rationale: string
}

export interface DecideClarifyInput {
  evaluation: ComplexityEvaluation
  policy: ClarifyPolicy
  /** 强制澄清的预判（β 阶段：pitfall 命中 / 关键工具未授权等） */
  forceClarify?: boolean
}

export interface ClarifyDecision {
  /** true = 走澄清卡片；false = 直接执行 */
  shouldClarify: boolean
  /** 决策原因（写入思维链/调试） */
  reason: string
}

export function decideClarify(input: DecideClarifyInput): ClarifyDecision {
  const { evaluation, policy, forceClarify } = input

  if (forceClarify) {
    return { shouldClarify: true, reason: 'force (pitfall/tool unauthorized)' }
  }
  if (policy === 'always_clarify') {
    return { shouldClarify: true, reason: 'policy=always_clarify' }
  }
  if (policy === 'always_skip') {
    return { shouldClarify: false, reason: 'policy=always_skip' }
  }
  // smart：根据复杂度
  if (evaluation.complexity === 'simple') {
    return { shouldClarify: false, reason: `simple: ${evaluation.rationale}` }
  }
  return {
    shouldClarify: true,
    reason: `${evaluation.complexity}: ${evaluation.rationale}`,
  }
}

/**
 * 默认 evaluator：根据 description 的启发式（α 实用版）。
 * - description 字数 < 30 且无"对比/方案/选项/规范"等关键词 → simple
 * - 含"重构/集成/大型/复杂"等 → complex
 * - 其余 → standard
 */
const SIMPLE_KEYWORDS = ['翻译', '改错', '总结', '提取', '格式', '校对', '问候']
const COMPLEX_KEYWORDS = ['重构', '集成', '大型', '复杂', '迁移', '设计架构', 'codebase']

export function heuristicEvaluator(description: string): ComplexityEvaluation {
  const text = description.trim()
  if (text.length < 30 && SIMPLE_KEYWORDS.some((k) => text.includes(k))) {
    return { complexity: 'simple', rationale: '短描述 + 简单操作关键词' }
  }
  if (COMPLEX_KEYWORDS.some((k) => text.includes(k))) {
    return { complexity: 'complex', rationale: '含重构/集成/大型等关键词' }
  }
  return { complexity: 'standard', rationale: '默认中等复杂度' }
}
