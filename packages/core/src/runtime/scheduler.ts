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
import { assignRequirement } from './commands.js'
import { parseCron, shouldTriggerCron } from '../cron/index.js'
import type { RuntimeServices } from './services.js'
import { getLogger, type RequirementId } from '@ai-emp/domain'

const log = getLogger('scheduler')

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
  /** V2 O5 cron ticker handle；stop() 时清掉 */
  private cronTimer: ReturnType<typeof setInterval> | null = null
  /** V2 O5 cron 触发器（注入 services 时才有；测试时可不注入） */
  private cronServices: RuntimeServices | null = null

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
    const s = new RequirementScheduler(services.bus, opts, async (reqId) => {
      await executeRequirement(reqId, services)
    })
    s.cronServices = services
    return s
  }

  setMaxConcurrent(n: number) {
    this.maxConcurrent = n
    this.emitState()
    this.pump()
  }

  enqueue(reqId: RequirementId): void {
    if (this.active.has(reqId)) {
      log.debug('enqueue.skip', { reqId, reason: 'already_active' })
      return
    }
    if (this.queue.includes(reqId)) {
      log.debug('enqueue.skip', { reqId, reason: 'already_queued' })
      return
    }
    this.queue.push(reqId)
    log.info('enqueue', { reqId, queueSize: this.queue.length, active: this.active.size })
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
    const t0 = performance.now()
    log.info('run.start', { reqId })
    try {
      await this.runOnce(reqId)
      log.info('run.end', { reqId, ms: Math.round(performance.now() - t0) })
    } catch (e) {
      log.error('run.unexpected', {
        reqId,
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
        ms: Math.round(performance.now() - t0),
      })
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

  // ───────────── V2 O5 Cron ─────────────

  /**
   * 启动 cron ticker：每 intervalMs 扫一次定时模板，到期则创建 child + assign + enqueue。
   * 须先 bindServices() 调用过（cronServices 才有值）；否则 no-op。
   */
  startCronTicker(intervalMs = 60_000): void {
    if (this.cronTimer) return
    if (!this.cronServices) {
      log.warn('cron.skip_no_services')
      return
    }
    log.info('cron.start', { intervalMs })
    // 立即跑一次，避免冷启动时等一个完整间隔
    void this.cronTick()
    this.cronTimer = setInterval(() => {
      void this.cronTick()
    }, intervalMs)
  }

  stopCronTicker(): void {
    if (this.cronTimer) {
      clearInterval(this.cronTimer)
      this.cronTimer = null
      log.info('cron.stop')
    }
  }

  /** V2 O5: 单次 cron 扫描 — 测试可手动调用 */
  async cronTick(now: Date = new Date()): Promise<{ triggered: number; skipped: number }> {
    if (!this.cronServices) return { triggered: 0, skipped: 0 }
    const { repos } = this.cronServices
    const templates = repos.requirements.listCronTemplates()
    let triggered = 0
    let skipped = 0
    for (const tpl of templates) {
      if (!tpl.cronSpec) continue
      const spec = parseCron(tpl.cronSpec)
      if (!spec) {
        log.warn('cron.invalid_spec', { reqId: tpl.id, cronSpec: tpl.cronSpec })
        skipped++
        continue
      }
      const due = shouldTriggerCron({
        spec,
        lastRunAt: tpl.cronLastRunAt,
        createdAt: tpl.createdAt,
        now,
      })
      if (!due) {
        skipped++
        continue
      }
      // 模板必须已有 assigneeId（创建模板时必填）
      if (!tpl.assigneeId) {
        log.warn('cron.no_assignee', { reqId: tpl.id })
        skipped++
        continue
      }
      // 创建 child（不带 cronSpec；parentRequirementId 指向模板）
      const childId = repos.requirements.create({
        title: `${tpl.title}（定时触发）`,
        description: tpl.description,
        projectId: tpl.projectId,
        priority: tpl.priority,
        budgetCap: tpl.budgetCapJson,
        parentRequirementId: tpl.id,
        cronSpec: null,
      })
      try {
        assignRequirement(this.cronServices, childId, tpl.assigneeId, { skipClarification: true })
      } catch (err) {
        log.warn('cron.assign_fail', { reqId: tpl.id, childId, err: String(err) })
        skipped++
        continue
      }
      repos.requirements.setCronLastRun(tpl.id, now)
      this.enqueue(childId)
      log.info('cron.triggered', {
        templateId: tpl.id,
        childId,
        cronSpec: tpl.cronSpec,
        assigneeId: tpl.assigneeId,
      })
      triggered++
    }
    return { triggered, skipped }
  }
}
