/**
 * V2 O5 Cron — 工单定时模板。
 *
 * 简化 cron 语法（不实现完整 5-field crontab 语法 — V2 第一版够用）：
 *   "every <N> minutes"     N >= 1，每 N 分钟跑一次（按 lastRunAt + N 算）
 *   "every <N> hours"       N >= 1
 *   "daily HH:MM"           每天 HH:MM
 *   "weekly <day> HH:MM"    每周指定天 HH:MM；day = mon|tue|wed|thu|fri|sat|sun
 *
 * 设计点：
 *   - parseCron 返回 null = 语法无效（caller 应忽略或写 system/error）
 *   - nextAt(from) 返回 from 之后下一次触发时间；null = 永不触发
 *   - 时区：用机器本地时区（new Date / getHours 等都是本地）
 *
 * 用法：
 *   const spec = parseCron('daily 09:00')
 *   if (!spec) ...
 *   const next = spec.nextAt(new Date())
 */

export interface CronSpec {
  /** 返回 from 之后下一次触发时间；null 表示永不触发（如解析后内部状态错乱） */
  nextAt(from: Date): Date | null
  /** debug 字符串 */
  describe(): string
}

const DAY_MAP: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}

export function parseCron(input: string): CronSpec | null {
  const s = input.trim().toLowerCase()
  if (!s) return null

  // every N minutes / hours
  const everyM = /^every\s+(\d+)\s+minutes?$/.exec(s)
  if (everyM) {
    const n = parseInt(everyM[1]!, 10)
    if (!Number.isFinite(n) || n < 1) return null
    return {
      describe: () => `every ${n} minutes`,
      nextAt(from) {
        // 从 from 之后 ≥ now 的 + N 分钟
        return new Date(from.getTime() + n * 60_000)
      },
    }
  }
  const everyH = /^every\s+(\d+)\s+hours?$/.exec(s)
  if (everyH) {
    const n = parseInt(everyH[1]!, 10)
    if (!Number.isFinite(n) || n < 1) return null
    return {
      describe: () => `every ${n} hours`,
      nextAt(from) {
        return new Date(from.getTime() + n * 3600_000)
      },
    }
  }

  // daily HH:MM
  const daily = /^daily\s+(\d{1,2}):(\d{2})$/.exec(s)
  if (daily) {
    const h = parseInt(daily[1]!, 10)
    const m = parseInt(daily[2]!, 10)
    if (h < 0 || h > 23 || m < 0 || m > 59) return null
    return {
      describe: () => `daily ${pad2(h)}:${pad2(m)}`,
      nextAt(from) {
        const next = new Date(from)
        next.setHours(h, m, 0, 0)
        if (next.getTime() <= from.getTime()) {
          next.setDate(next.getDate() + 1)
        }
        return next
      },
    }
  }

  // weekly DAY HH:MM
  const weekly = /^weekly\s+(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2}):(\d{2})$/.exec(s)
  if (weekly) {
    const day = DAY_MAP[weekly[1]!]!
    const h = parseInt(weekly[2]!, 10)
    const m = parseInt(weekly[3]!, 10)
    if (h < 0 || h > 23 || m < 0 || m > 59) return null
    return {
      describe: () => `weekly ${weekly[1]} ${pad2(h)}:${pad2(m)}`,
      nextAt(from) {
        const next = new Date(from)
        next.setHours(h, m, 0, 0)
        const currentDay = next.getDay()
        let delta = (day - currentDay + 7) % 7
        if (delta === 0 && next.getTime() <= from.getTime()) {
          delta = 7
        }
        next.setDate(next.getDate() + delta)
        return next
      },
    }
  }

  return null
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

/**
 * 判断 cron 模板是否到期需要触发：
 *   - 从 lastRunAt (或 createdAt 作 fallback) 出发，计算下一个触发时间
 *   - 若该时间 <= now 则到期
 */
export function shouldTriggerCron(opts: {
  spec: CronSpec
  lastRunAt: Date | null
  createdAt: Date
  now: Date
}): boolean {
  const base = opts.lastRunAt ?? opts.createdAt
  const next = opts.spec.nextAt(base)
  if (!next) return false
  return next.getTime() <= opts.now.getTime()
}
