/**
 * 与后端 schema 形状一致的极简 TS 类型（避免引入 @ai-emp/domain 跨包构建）。
 */

export interface Project {
  id: string
  name: string
  description: string
  status: 'active' | 'archived'
  knowledgeStatus: 'idle' | 'indexing' | 'ready' | 'error'
  createdAt: string
  archivedAt: string | null
}

export interface Employee {
  id: string
  name: string
  role: string
  persona: string
  modelProvider: 'anthropic' | 'openai-compat'
  modelName: string
  modelKeyRef: string
  memoryStyleText: string
  status: 'active' | 'archived'
  createdAt: string
}

export type RequirementStatus =
  | '待分派'
  | '待澄清'
  | '进行中'
  | '等待回答'
  | '已暂停'
  | '待验收'
  | '已完成'
  | '已驳回'
  | '已取消'

export interface Requirement {
  id: string
  title: string
  description: string
  projectId: string | null
  assigneeId: string | null
  priority: 'P0' | 'P1' | 'P2'
  status: RequirementStatus
  planJson: { steps: { idx: number; text: string; status: string }[] } | null
  deliverableRef: string | null
  budgetCapJson: { maxIterations: number; maxTokens: number; maxWallTimeMs: number }
  createdAt: string
  completedAt: string | null
}

export interface Skill {
  id: string
  name: string
  category: string
  description: string
  promptTemplate: string
}

export interface ThreadResponse {
  thread: { id: string; requirementId: string; createdAt: string }
  messages: Message[]
}

export interface Message {
  id: string
  threadId: string
  seq: number
  role: 'system' | 'user' | 'assistant' | 'tool'
  type:
    | 'text'
    | 'thinking'
    | 'tool_call'
    | 'tool_result'
    | 'clarification_request'
    | 'clarification_answer'
    | 'plan_update'
    | 'error'
  contentJson: Record<string, unknown>
  tokensJson: { input: number; output: number; cached?: number } | null
  createdAt: string
}

export interface Clarification {
  id: string
  requirementId: string
  round: number
  trigger: string
  employeeUnderstanding: string | null
  proposedPlanJson: string[] | null
  questionsJson: { question: string; answer?: string; answerMode: 'user' | 'auto_proceed' }[]
  resolvedAt: string | null
  createdAt: string
}
