/**
 * PromptComposer — 按 ARCHITECTURE §11.1 顺序拼装 system + chat history。
 *
 * 顺序（硬约束在前，软提示在后）：
 *   [persona]
 *   [memory.style]
 *   [main skill prompt_template]
 *   [project.conventions WHERE enforcement='required']   全量
 *   [project.conventions WHERE enforcement='recommended'] RAG Top-K   (α 暂全量)
 *   [project.facts]                                       RAG Top-K
 *   [project.pitfalls]                                    RAG Top-K
 *   [employee.lessons]                                    RAG Top-K
 *   [runtime: plan + currentStep]
 *   [runtime: historySummary]
 *   [runtime: recentMessages last N]                      作为 chat history
 *   [requirement.description]                             作为首条 user
 */

import type { Repos } from '@ai-emp/storage'
import type { MemoryServices, RecallHit } from '../memory/index.js'
import { recall } from '../memory/index.js'

export interface ComposeInput {
  reqId: string
  employeeId: string
  threadId: string
  /** 提供 memory 服务则启用 RAG；不传则跳过（α 单测时跳过） */
  memory?: MemoryServices
  recentMessageCount?: number
  recallK?: number
}

export interface ComposedPrompt {
  system: string
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  tokensEstimate: number
  /**
   * Prompt cache 断点（system 字符串中的字节偏移）。
   * 顺序：硬约束部分（persona/style/skill/required conventions）的尾部 ——
   *   这之前的内容稳定，可让 LLM provider 缓存（Anthropic / OpenAI 都支持）。
   * 缺省为空数组（不启用 cache）。
   */
  cacheBreakpoints: number[]
  debug: {
    recalledFacts: RecallHit[]
    recalledPitfalls: RecallHit[]
    recalledLessons: RecallHit[]
    requiredConventionCount: number
    recommendedConventionCount: number
  }
}

const DEFAULT_RECENT = 10
const DEFAULT_RECALL_K = 5

export async function compose(repos: Repos, input: ComposeInput): Promise<ComposedPrompt> {
  const req = repos.requirements.findById(input.reqId)
  if (!req) throw new Error(`requirement not found: ${input.reqId}`)
  const emp = repos.employees.findById(input.employeeId)
  if (!emp) throw new Error(`employee not found: ${input.employeeId}`)

  const skills = repos.skills.listForEmployee(emp.id)
  const main = skills[0]?.skill
  const others = skills.slice(1).map((s) => s.skill)

  // ① 硬约束部分
  const parts: string[] = []
  parts.push('# 你是一个 AI 员工', `## 角色\n${emp.role}`)
  if (emp.persona) parts.push(`## 人设\n${emp.persona}`)
  if (emp.memoryStyleText) parts.push(`## 工作风格（系统沉淀）\n${emp.memoryStyleText}`)
  if (main) {
    parts.push(`## 主技能：${main.name}\n${main.promptTemplate || main.description}`)
  }
  if (others.length > 0) {
    parts.push(
      `## 额外能力（按需引用）\n${others.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`,
    )
  }

  // ② 项目规范
  let requiredCount = 0
  let recommendedCount = 0
  if (req.projectId) {
    const conv = repos.conventions.listByProject(req.projectId)
    const required = conv.filter((c) => c.enforcement === 'required')
    const recommended = conv.filter((c) => c.enforcement === 'recommended')
    requiredCount = required.length
    recommendedCount = recommended.length
    if (required.length > 0) {
      parts.push(
        `## 项目规范（required，必须遵守）\n${required.map((c) => `- ${c.content}`).join('\n')}`,
      )
    }
    // α: recommended 也全量（避免再做一次 RAG）
    if (recommended.length > 0) {
      parts.push(
        `## 项目规范（recommended，相关时参考）\n${recommended.map((c) => `- ${c.content}`).join('\n')}`,
      )
    }
  }

  // ⚓ cache breakpoint — 到此为止的内容稳定，可缓存
  //   后续 RAG / plan / chat 都按需求变化，不能进 cache
  const cacheBreakpointBytes = parts.reduce((sum, p) => sum + p.length, 0) + parts.length * 2 // 加上 \n\n 分隔

  // ③ RAG：facts / pitfalls / lessons
  let facts: RecallHit[] = []
  let pitfalls: RecallHit[] = []
  let lessons: RecallHit[] = []
  if (input.memory) {
    const k = input.recallK ?? DEFAULT_RECALL_K
    const query = `${req.title}\n${req.description}`
    if (req.projectId) {
      facts = await recall(input.memory, {
        scope: 'project',
        scopeId: req.projectId,
        kinds: ['fact'],
        query,
        k,
      })
      pitfalls = await recall(input.memory, {
        scope: 'project',
        scopeId: req.projectId,
        kinds: ['pitfall'],
        query,
        k,
      })
    }
    lessons = await recall(input.memory, {
      scope: 'employee',
      scopeId: emp.id,
      kinds: ['lesson'],
      query,
      k,
    })
  }
  if (facts.length > 0) {
    parts.push(
      `## 项目知识（facts，按相关性 Top-K）\n${facts.map((f) => `- ${f.content}`).join('\n')}`,
    )
  }
  if (pitfalls.length > 0) {
    parts.push(
      `## 项目踩坑（pitfalls，避免重蹈）\n${pitfalls.map((p) => `- ${p.content}`).join('\n')}`,
    )
  }
  if (lessons.length > 0) {
    parts.push(`## 个人教训（lessons）\n${lessons.map((l) => `- ${l.content}`).join('\n')}`)
  }

  // ④ Plan / 当前步骤
  if (req.planJson) {
    parts.push(
      `## 当前 Plan\n${req.planJson.steps.map((s) => `  ${s.idx}. [${s.status}] ${s.text}`).join('\n')}`,
    )
  }

  // ④a 运行时状态：currentStep + historySummary
  //   注释 §13/§14 早就要求注入，但实现遗漏 → LLM 看不到自己干了啥，反复在同一 step 内
  //   advance_step / ask_user 死循环。这块是切断 LLM 重复输出的关键上下文。
  const rs = repos.runtimeState.find(input.reqId)
  if (rs) {
    const totalSteps = req.planJson?.steps.length ?? 0
    const stepHint =
      totalSteps > 0
        ? `共 ${totalSteps} 步，当前应该推进 step ${rs.currentStep}${rs.currentStep >= totalSteps ? '（已超出 plan 范围 → 应该 emit_deliverable）' : ''}`
        : `当前步索引 ${rs.currentStep}`
    parts.push(`## 当前进度\n- ${stepHint}`)
    if (rs.historySummary && rs.historySummary.trim().length > 0) {
      parts.push(
        [
          '## 已完成步骤摘要（不要重复总结已完成的 step）',
          rs.historySummary.trim(),
          '',
          '⚠️ 上面已经记录了之前完成的 step。**不要**再对同一个 step 调 advance_step。',
          '推进到下一 step 应该 `advance_step({ step_idx: <下一未完成 idx>, summary: "本步成果" })`。',
          '若所有 plan step 都 done，直接 `emit_deliverable`。',
        ].join('\n'),
      )
    }
  }

  // ⑤ 协作规则
  parts.push(
    [
      '## 协作规则',
      '- 你可以调用以下系统工具：',
      '  - `advance_step`：完成 plan 中一步后调用',
      '  - `update_plan`：当需要调整计划时调用',
      '  - `emit_deliverable`：交付最终产物，进入 待验收 状态',
      '  - `ask_user`：以下 5 种场景**必须**主动暂停发问（带正确 trigger_reason）：',
      '    · `decision_split`：方案 A vs B 不可自行决断',
      '    · `missing_info`：关键事实/参数缺失，无法继续',
      '    · `judgment`：3 个候选都说得通，需用户选偏好',
      '    · `pitfall_hit`：察觉到本项目 pitfall 命中，先与用户确认本次做法',
      '    · `cost_alert`：预估接下来要超出 budget，请用户决定是否继续',
      '    ⚠️ 调用 `ask_user` 时必须以结构化 args 传入：',
      '       { "questions": [ { "question": "..." }, ... ], "trigger_reason": "missing_info" }',
      '       **不要**把澄清问题写在 text 输出中；text 只放概述，问题列表只在 questions 字段。',
      '- 默认行为：当本步骤产出已写入交付，**必须** 调用 advance_step',
      '- 严格遵守"项目规范 required"；recommended 视相关性引用',
      '',
      '### 文件 / Shell 工具使用规则（防路径幻觉 + 防假装完成）',
      '- **Edit / Read / Write 的 path 必须来自之前 Glob / Grep / Read 的真实返回**；',
      '  禁止凭印象编路径（典型错误：根据模块名猜目录名却没用 Glob 验证过）。',
      '- 第一次接触一个项目目录时，**先 Glob 探索结构**（如 `**/*.java` 或 `*` 看顶层），',
      '  再决定 Edit 哪个文件。**不要**在没探索过的子目录里直接 Edit。',
      '- 如果 tool_result 返回 ENOENT / "not found" / ok=false：',
      '  · **立刻**用 Glob 重新探索该文件可能的真实位置（如 `**/<filename>`）；',
      '  · 不要重复 Edit 同一个错误 path；不要把失败的 step 假装标 done。',
      '- ⛔ tool_result.ok=false 时**严禁**调用 advance_step。',
      '  引擎会硬阻止并要求你先修复（用 Glob/Read 找到正确 path 再 Edit 成功）。',
      '- 完成本步骤后调 advance_step 前，确认最近一次工具调用是成功的（ok=true）。',
    ].join('\n'),
  )

  const system = parts.join('\n\n')

  // chat history
  const recent = repos.messages.tailByThread(
    input.threadId,
    input.recentMessageCount ?? DEFAULT_RECENT,
  )
  const messages: ComposedPrompt['messages'] = []
  messages.push({ role: 'user', content: `# 需求\n${req.title}\n\n${req.description}` })
  for (const m of recent) {
    const text = extractText(m.contentJson)
    if (!text) continue
    if (m.role === 'user' || m.role === 'assistant') {
      messages.push({ role: m.role, content: text })
    } else if (m.role === 'tool') {
      messages.push({ role: 'assistant', content: `[tool] ${text}` })
    }
  }

  return {
    system,
    messages,
    tokensEstimate:
      Math.round(system.length / 2) + messages.reduce((a, m) => a + m.content.length / 2, 0),
    cacheBreakpoints:
      cacheBreakpointBytes > 0 ? [Math.min(cacheBreakpointBytes, system.length)] : [],
    debug: {
      recalledFacts: facts,
      recalledPitfalls: pitfalls,
      recalledLessons: lessons,
      requiredConventionCount: requiredCount,
      recommendedConventionCount: recommendedCount,
    },
  }
}

function extractText(c: unknown): string | null {
  if (!c || typeof c !== 'object') return null
  const o = c as { type?: string; text?: string; reason?: string }
  if (o.type === 'text' || o.type === 'thinking') return o.text ?? null
  if (o.type === 'plan_update') return `plan_update: ${o.reason ?? ''}`
  if (o.type === 'tool_result') return `tool_result`
  return null
}
