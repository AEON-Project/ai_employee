/**
 * RequirementScheduler — α 阶段串行调度（maxConcurrent=1），β 阶段开放真并发。
 *
 * 提供：
 *   - enqueue(reqId)：要求执行该 req（push 队列）
 *   - 内部 worker loop：从队列取出 → executeRequirement → emit scheduler_state
 *   - 同步 maxConcurrent：实时切换串行/并发（修改后下次 pump 生效）
 */

import type { TypedEventBus, EventMap } from '@ai-emp/events'
import { executeRequirement } from './execute.js'
import type { RuntimeServices } from './services.js'
import type { RequirementId } from '@ai-emp/domain'

export interface SchedulerOptions {
  /** α=1；β 阶段可放大 */
  maxConcurrent: number
}

type RunOnce = (reqId: RequirementId) => Promise<void>

export class RequirementScheduler {
  private queue: RequirementId[] = []
  private active = new Set<RequirementId>()
  private maxConcurrent: number
  private runOnce: RunOnce

  constructor(
    private readonly bus: TypedEventBus<EventMap>,
    opts: SchedulerOptions,
    runOnce?: RunOnce,
  ) {
    this.maxConcurrent = opts.maxConcurrent
    this.runOnce = runOnce ?? (async () => {})
  }

  /** 默认 worker 函数：直接调 executeRequirement(services) */
  static bindServices(
    services: RuntimeServices,
    opts: SchedulerOptions = { maxConcurrent: 1 },
  ): RequirementScheduler {
    return new RequirementScheduler(services.bus, opts, async (reqId) => {
      await executeRequirement(reqId, services)
    })
  }

  setMaxConcurrent(n: number) {
    this.maxConcurrent = n
    this.emitState()
    this.pump()
  }

  enqueue(reqId: RequirementId): void {
    if (this.active.has(reqId)) return
    if (this.queue.includes(reqId)) return
    this.queue.push(reqId)
    this.emitState()
    this.pump()
  }

  /** 立即停止接受新需求；正在跑的会跑到下一次 IDLE 边界（execute() 自己处理） */
  drain(): void {
    this.queue.length = 0
    this.emitState()
  }

  size(): { active: number; queued: number; max: number } {
    return { active: this.active.size, queued: this.queue.length, max: this.maxConcurrent }
  }

  private pump(): void {
    while (this.active.size < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift()!
      this.active.add(next)
      this.emitState()
      // 不 await — 让多个 run 并发；α 因 maxConcurrent=1 实际等同串行
      void this.runOne(next)
    }
  }

  private async runOne(reqId: RequirementId): Promise<void> {
    try {
      await this.runOnce(reqId)
    } catch (e) {
      // 已由 execute 内部处理；这里只做兜底
      // eslint-disable-next-line no-console
      console.error('[scheduler] runOne unexpected:', e)
    } finally {
      this.active.delete(reqId)
      this.emitState()
      this.pump()
    }
  }

  private emitState(): void {
    this.bus.emit('runtime.scheduler_state', {
      active: this.active.size,
      queued: this.queue.length,
      max: this.maxConcurrent,
    })
  }
}
