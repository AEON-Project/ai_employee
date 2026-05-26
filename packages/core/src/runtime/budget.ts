/**
 * Budget Cap — 三道闸（iterations / tokens / wallTime）。
 *
 * 用法：
 *   const b = new BudgetTracker(cap)
 *   b.startWallClock()             // 一次性，记开始时间
 *   for (each iteration) {
 *     b.recordIteration()
 *     b.recordTokens(in, out, cached?)
 *     const r = b.check()
 *     if (r.kind === 'exceeded') { pause(`budget_${r.gate}`); break }
 *     if (r.kind === 'warning') emit('budget.warning', ...)
 *     b.snapshot() // 写入 runtime_state.budgetUsedJson
 *   }
 */

import type { BudgetCap, BudgetGate, BudgetUsed, PauseReason } from '@ai-emp/domain'

/** Budget 检查结果 */
export type BudgetCheck =
  | { kind: 'ok'; ratios: BudgetRatios }
  | { kind: 'warning'; gate: BudgetGate; used: number; cap: number; ratios: BudgetRatios }
  | { kind: 'exceeded'; gate: BudgetGate; used: number; cap: number; ratios: BudgetRatios }

export interface BudgetRatios {
  iterations: number
  tokens: number
  wallTime: number
  /** 最大比率（决定是否进入 warning） */
  max: number
}

const WARNING_THRESHOLD = 0.8

export class BudgetTracker {
  private used: BudgetUsed = {
    iterations: 0,
    tokensIn: 0,
    tokensOut: 0,
    wallTimeMs: 0,
  }
  /** null 表示墙钟未开始；用 null 而不是 0 避免 t=0 被当作"未启动" */
  private startedAt: number | null = null
  /** 标记 80% 警告已发过；避免每轮都重发 */
  private warned = new Set<BudgetGate>()

  constructor(
    readonly cap: BudgetCap,
    initial?: Partial<BudgetUsed>,
  ) {
    if (initial) Object.assign(this.used, initial)
  }

  /** 记开始时间；进程中断恢复时，把 startedAt 减去 used.wallTimeMs 即可继续累计 */
  startWallClock(now: number = Date.now()): void {
    this.startedAt = now - this.used.wallTimeMs
  }

  recordIteration(): void {
    this.used.iterations += 1
  }

  recordTokens(input: number, output: number, _cached?: number): void {
    this.used.tokensIn += input
    this.used.tokensOut += output
  }

  /** 把当前墙钟流入 used.wallTimeMs；通常在 check() 前调一次 */
  tickWallClock(now: number = Date.now()): void {
    if (this.startedAt === null) return
    this.used.wallTimeMs = now - this.startedAt
  }

  check(now: number = Date.now()): BudgetCheck {
    this.tickWallClock(now)

    const totalTokens = this.used.tokensIn + this.used.tokensOut
    const ratios: BudgetRatios = {
      iterations: this.used.iterations / this.cap.maxIterations,
      tokens: totalTokens / this.cap.maxTokens,
      wallTime: this.used.wallTimeMs / this.cap.maxWallTimeMs,
      max: 0,
    }
    ratios.max = Math.max(ratios.iterations, ratios.tokens, ratios.wallTime)

    // 100% 命中：取最先超出的 gate（按 max 找出）
    const exceeded = this.findExceeded(ratios)
    if (exceeded) return { kind: 'exceeded', ...exceeded, ratios }

    // 80% 警告：取首次进入 warning 的 gate
    const warn = this.findWarning(ratios)
    if (warn) return { kind: 'warning', ...warn, ratios }

    return { kind: 'ok', ratios }
  }

  /** 当前累积；用于持久化 runtime_state.budgetUsedJson */
  snapshot(now: number = Date.now()): BudgetUsed {
    this.tickWallClock(now)
    return { ...this.used }
  }

  /** 把 exceed 类型 gate 映射到 PauseReason 字符串（runtime 调用） */
  static pauseReasonOf(gate: BudgetGate): PauseReason {
    switch (gate) {
      case 'iterations':
        return 'budget_iterations'
      case 'tokens':
        return 'budget_tokens'
      case 'wallTime':
        return 'budget_walltime'
    }
  }

  // ── 私有 ────────────────────────────────────────────────────
  private findExceeded(r: BudgetRatios): { gate: BudgetGate; used: number; cap: number } | null {
    if (r.iterations >= 1) {
      return { gate: 'iterations', used: this.used.iterations, cap: this.cap.maxIterations }
    }
    if (r.tokens >= 1) {
      return {
        gate: 'tokens',
        used: this.used.tokensIn + this.used.tokensOut,
        cap: this.cap.maxTokens,
      }
    }
    if (r.wallTime >= 1) {
      return { gate: 'wallTime', used: this.used.wallTimeMs, cap: this.cap.maxWallTimeMs }
    }
    return null
  }

  private findWarning(r: BudgetRatios): { gate: BudgetGate; used: number; cap: number } | null {
    const candidates: Array<[BudgetGate, number, number, number]> = [
      ['iterations', r.iterations, this.used.iterations, this.cap.maxIterations],
      ['tokens', r.tokens, this.used.tokensIn + this.used.tokensOut, this.cap.maxTokens],
      ['wallTime', r.wallTime, this.used.wallTimeMs, this.cap.maxWallTimeMs],
    ]
    // 已 warn 过的不再发；从最先达到阈值的 gate 报警
    for (const [gate, ratio, used, cap] of candidates) {
      if (ratio >= WARNING_THRESHOLD && !this.warned.has(gate)) {
        this.warned.add(gate)
        return { gate, used, cap }
      }
    }
    return null
  }
}

/** 简便函数：从 BudgetUsed 计算 ratios（事件 payload 已包含 used/cap，无需 tracker 实例） */
export function ratiosOf(used: BudgetUsed, cap: BudgetCap): BudgetRatios {
  const totalTokens = used.tokensIn + used.tokensOut
  const r: BudgetRatios = {
    iterations: used.iterations / cap.maxIterations,
    tokens: totalTokens / cap.maxTokens,
    wallTime: used.wallTimeMs / cap.maxWallTimeMs,
    max: 0,
  }
  r.max = Math.max(r.iterations, r.tokens, r.wallTime)
  return r
}
