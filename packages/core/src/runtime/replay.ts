/**
 * Replay & Debug — PRD §M9 最小可用版。
 *
 * 在已完成 / 已驳回的需求上点 Replay：
 *   - 复制原需求的 title / description / projectId / assigneeId
 *   - 用**当前**的 prompt 模板 + 记忆库重跑一次
 *   - 与原结果并排展示（UI 层）
 *   - **不写回任何记忆库**（不污染历史）：设 replayMode=true 时引擎跳过 persist
 *
 * 实现：创建一条"副本需求"，加上 replay_of=<原 reqId> 标记（用 description 头部前缀，避免 schema 改动）。
 */

import type { RequirementId } from '@ai-emp/domain'
import type { RuntimeServices } from './services.js'
import { executeRequirement } from './execute.js'
import { assignRequirement } from './commands.js'

export interface ReplayResult {
  replayReqId: RequirementId
  originalReqId: RequirementId
  exit: 'paused' | 'awaiting_user' | 'delivered' | 'forced_end'
}

export const REPLAY_TAG_PREFIX = '[REPLAY]'

export async function replayRequirement(
  services: RuntimeServices,
  originalReqId: RequirementId,
): Promise<ReplayResult> {
  const { repos } = services
  const orig = repos.requirements.findById(originalReqId)
  if (!orig) throw new Error(`requirement not found: ${originalReqId}`)
  if (orig.status !== '已完成' && orig.status !== '已驳回') {
    throw new Error(`仅 已完成/已驳回 可 replay；当前 ${orig.status}`)
  }
  if (!orig.assigneeId) throw new Error(`原需求无 assignee，无法 replay`)

  // 创建副本；description 头部加 [REPLAY] tag
  const replayId = repos.requirements.create({
    title: `${REPLAY_TAG_PREFIX} ${orig.title}`,
    description: `${REPLAY_TAG_PREFIX} of:${originalReqId}\n\n${orig.description}`,
    projectId: orig.projectId,
    priority: orig.priority,
    budgetCap: orig.budgetCapJson,
  })

  // assign + skipClarification（replay 不再走澄清）
  assignRequirement(services, replayId, orig.assigneeId, { skipClarification: true })

  // 执行（mock LLM 或真实 LLM 由 services.llm 决定）
  const r = await executeRequirement(replayId, services)

  // 注：replay 完成后不调用 persistFromReport，调用方决定
  return { replayReqId: replayId, originalReqId, exit: r.exit }
}

/** 判断某 reqId 是否是 replay 副本 */
export function isReplayOf(description: string): RequirementId | null {
  const m = /^\[REPLAY\] of:([\w-]+)/.exec(description.trim())
  return m ? (m[1] as RequirementId) : null
}
