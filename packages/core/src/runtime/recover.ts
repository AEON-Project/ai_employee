/**
 * 启动恢复 — 扫表找出"进程崩溃前在 进行中 / 等待回答 状态"的需求。
 *
 * 规则（ARCHITECTURE §9.7）：
 *   - 等待回答：保持原状（无活跃协程，等用户回答 → answerClarification 自动重启）
 *   - 进行中：
 *     · lastHeartbeatAt 距今 < 60s → 视为有其他活跃实例，警告并 skip
 *     · 否则提示用户「继续 / 标记暂停」；caller 决定
 *
 * 当前实现：只返回扫到的结果，让 caller (CLI) 决策；不直接 mutate 状态。
 */

import type { RuntimeServices } from './services.js'

export interface InflightRequirement {
  reqId: string
  status: '进行中' | '等待回答'
  lastHeartbeatAt: Date | null
  /** 与"60s 内有心跳"的判定结果 */
  recentHeartbeat: boolean
}

export interface RecoverResult {
  inflight: InflightRequirement[]
}

const HEARTBEAT_FRESH_MS = 60_000

export function scanInflight(services: RuntimeServices): RecoverResult {
  const { repos } = services
  const all = repos.requirements.listActive()
  const candidates = all.filter((r) => r.status === '进行中' || r.status === '等待回答')

  const now = Date.now()
  const inflight: InflightRequirement[] = candidates.map((r) => {
    const rs = repos.runtimeState.find(r.id)
    const lastHB = rs?.lastHeartbeatAt ?? null
    return {
      reqId: r.id,
      status: r.status as '进行中' | '等待回答',
      lastHeartbeatAt: lastHB,
      recentHeartbeat: lastHB ? now - lastHB.getTime() < HEARTBEAT_FRESH_MS : false,
    }
  })

  services.bus.emit('runtime.recovered', { reqIds: inflight.map((i) => i.reqId) })
  return { inflight }
}
