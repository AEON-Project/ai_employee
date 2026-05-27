/**
 * executeRequirement — Engine-driven Agent loop。
 *
 * 主流程：
 *   ① Budget gate → exceeded 直接 pause
 *   ② Compose prompt（最小版；T3.1 替换）
 *   ③ LLM stream，消费 chunk：
 *      - thinking/text → append messages（throttled flush 留给 T2.10 优化）
 *      - tool_use_stop → 暂停消费，dispatch
 *      - usage → 累计 budget
 *      - error → pause('llm_error')
 *   ④ Dispatch tool call：
 *      - 系统级 tool 直接驱动状态机（ask_user / advance_step / update_plan / emit_deliverable）
 *      - 普通 tool 走 ToolExecutor → 写 tool_result message → 回 IDLE
 *      - 无 tool_call → 隐式 advance_step
 *   ⑤ Persist runtime_state + emit frame
 */

import {
  getLogger,
  type Plan,
  type RequirementId,
  type PauseReason,
  type BudgetUsed,
} from '@ai-emp/domain'
import { resolveEnvRef, resolveEnvRefStrict } from '@ai-emp/storage'

const log = getLogger('runtime.execute')
import { BudgetTracker } from './budget.js'
import { transition } from './state-machine.js'
import { composeMinimalPrompt } from './prompt-minimal.js'
import { compose as composeFullPrompt } from '../prompt/composer.js'
import type { RuntimeServices, RuntimeLLMChunk, RuntimeToolDef } from './services.js'

/** 终止信号：执行循环退出的几种方式 */
type ExitKind = 'paused' | 'awaiting_user' | 'delivered' | 'forced_end'

export interface ExecuteOptions {
  /** 单次循环最大轮数（防止本进程内死循环；与 budget.maxIterations 不同） */
  maxLoops?: number
}

const DEFAULT_MAX_LOOPS = 50

export async function executeRequirement(
  reqId: RequirementId,
  services: RuntimeServices,
  opts: ExecuteOptions = {},
): Promise<{ exit: ExitKind }> {
  const { repos, bus, credentials } = services
  const req = repos.requirements.findById(reqId)
  if (!req) throw new Error(`requirement not found: ${reqId}`)
  if (req.status !== '进行中') {
    throw new Error(`requirement not in 进行中: ${reqId} (${req.status})`)
  }
  if (!req.assigneeId) throw new Error(`requirement has no assignee: ${reqId}`)
  const employee = repos.employees.findById(req.assigneeId)
  if (!employee) throw new Error(`employee not found: ${req.assigneeId}`)

  const thread = repos.threads.findByRequirement(reqId)
  if (!thread) throw new Error(`thread not found for ${reqId}`)

  // 解密 apiKey
  const apiKey = await credentials.readSecretByKey(employee.modelKeyRef)
  if (!apiKey) {
    return systemPause(
      services,
      reqId,
      'llm_error',
      `apiKey missing for keyRef ${employee.modelKeyRef}`,
    )
  }

  // 员工字段支持 env:// 协议；model/baseUrl 解析失败时降级或抛错
  const resolvedModel = resolveEnvRefStrict(employee.modelName, 'employee.modelName')
  const resolvedBaseUrl = resolveEnvRef(employee.modelBaseUrl ?? null) ?? undefined

  const llm = services.llm.create({
    provider: employee.modelProvider,
    model: resolvedModel,
    apiKey,
    baseUrl: resolvedBaseUrl,
    temperature: employee.modelTemperature ?? undefined,
    maxTokens: employee.modelMaxTokens ?? undefined,
  })

  // 加载 / 初始化 runtime_state（本函数内只跟踪可变字段）
  const persisted = repos.runtimeState.find(reqId)
  let execState: {
    currentStep: number
    historySummary: string
    budgetUsedJson: BudgetUsed
  } = persisted
    ? {
        currentStep: persisted.currentStep,
        historySummary: persisted.historySummary,
        budgetUsedJson: persisted.budgetUsedJson,
      }
    : (() => {
        repos.runtimeState.upsert({
          requirementId: reqId,
          currentStep: 0,
          historySummary: '',
          budgetUsed: { iterations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0 },
        })
        return {
          currentStep: 0,
          historySummary: '',
          budgetUsedJson: { iterations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0 },
        }
      })()

  const budget = new BudgetTracker(req.budgetCapJson, execState.budgetUsedJson)
  budget.startWallClock()

  // V1.1: 所有 standard tool（file/shell）默认授权给员工 —— 单用户本地引擎，等同于用户在终端跑命令。
  const grantedNames: string[] = services.standardToolNames ?? []
  const visibleTools = services.toolRegistry.listFor(grantedNames)
  const tools = visibleTools
    .map((t) => buildLLMTool(t, services))
    .filter(
      (x): x is { name: string; description: string; inputSchema: Record<string, unknown> } =>
        x !== null,
    )

  const maxLoops = opts.maxLoops ?? DEFAULT_MAX_LOOPS

  for (let loop = 0; loop < maxLoops; loop++) {
    // ① Budget gate
    const r = budget.check()
    if (r.kind === 'exceeded') {
      return systemPause(
        services,
        reqId,
        BudgetTracker.pauseReasonOf(r.gate),
        `budget exceeded: ${r.gate}`,
      )
    }
    if (r.kind === 'warning') {
      bus.emit('budget.warning', { reqId, gate: r.gate, used: r.used, cap: r.cap })
    }

    // ② Compose prompt — 有 memory 服务则走完整 RAG，否则降级 minimal
    const prompt = services.memory
      ? await composeFullPrompt(repos, {
          reqId,
          employeeId: employee.id,
          threadId: thread.id,
          memory: { repos, sqlite: services.memory.sqlite, embed: services.memory.embed },
        })
      : composeMinimalPrompt(repos, {
          reqId,
          employeeId: employee.id,
          threadId: thread.id,
        })

    // ③ LLM stream
    let decision: { callId: string; name: string; args: unknown } | null = null
    let textBuf = ''
    let llmError: string | null = null
    let saw_stop = false
    const streamBuffer = createStreamingBuffer({ repos, bus, threadId: thread.id })

    const cacheBp = (prompt as unknown as { cacheBreakpoints?: number[] }).cacheBreakpoints
    const llmT0 = performance.now()
    log.info('llm.call.start', {
      reqId,
      employeeId: employee.id,
      model: resolvedModel,
      provider: employee.modelProvider,
      systemBlocks: prompt.system.length,
      messages: prompt.messages.length,
      tools: tools.length,
      iteration: execState.currentStep,
    })
    log.debug('llm.call.request', {
      reqId,
      system: prompt.system,
      messages: prompt.messages,
      toolNames: tools.map((t) => t.name),
    })
    let chunkCount = 0
    let firstChunkMs: number | undefined
    for await (const chunk of llm.stream({
      system: prompt.system,
      messages: prompt.messages,
      tools,
      ...(cacheBp && cacheBp.length > 0 ? { cacheBreakpoints: cacheBp } : {}),
      ...(employee.modelTemperature == null ? {} : { temperature: employee.modelTemperature }),
      ...(employee.modelMaxTokens == null ? {} : { maxTokens: employee.modelMaxTokens }),
    })) {
      chunkCount++
      if (chunkCount === 1) {
        firstChunkMs = Math.round(performance.now() - llmT0)
        log.info('llm.call.first_chunk', { reqId, firstChunkMs, chunkType: chunk.type })
      }
      const out = handleChunk(chunk, { buffer: streamBuffer, budget })
      if (out.kind === 'tool') {
        decision = out.call
        break
      }
      if (out.kind === 'text') textBuf += out.text
      if (out.kind === 'error') {
        llmError = out.message
        break
      }
      if (out.kind === 'stop') saw_stop = true
      if (decision) break
    }
    // 兜底 flush：provider 没发 message_stop / tool_use_stop / error，
    // 直接断流时仍要把累积的 text 落库。
    streamBuffer.flush()
    const llmMs = Math.round(performance.now() - llmT0)
    if (llmError) {
      log.error('llm.call.error', { reqId, error: llmError, ms: llmMs, chunks: chunkCount })
      return systemPause(services, reqId, 'llm_error', llmError)
    }
    log.info('llm.call.end', {
      reqId,
      ms: llmMs,
      firstChunkMs,
      chunks: chunkCount,
      decision: decision?.name ?? (saw_stop ? 'stop' : 'unknown'),
      textLen: textBuf.length,
    })
    log.debug('llm.call.response', { reqId, decision, textBuf })
    if (!decision && saw_stop && textBuf) {
      // 隐式 advance_step：把累积文本视为本步 summary
      decision = {
        callId: `implicit-${Date.now()}`,
        name: 'advance_step',
        args: { step_idx: execState.currentStep, summary: textBuf.trim() },
      }
    }

    budget.recordIteration()

    // ④ Dispatch
    if (!decision) {
      // 没 tool_call 也没 stop —— stream 异常退出
      return systemPause(services, reqId, 'llm_error', 'stream ended without decision')
    }
    let exit: Awaited<ReturnType<typeof dispatch>>
    try {
      exit = await dispatch(decision, {
        services,
        reqId,
        thread,
        employee,
        currentStep: execState.currentStep,
        historySummary: execState.historySummary,
        plan: req.planJson ?? null,
        grantedNames,
      })
    } catch (e) {
      // dispatch 抛错（LLM args 不符合 schema / 工具内部 bug 等）→ systemPause 而不是冒泡，
      // 让状态从「进行中」转「已暂停」、错误可见、用户可恢复。
      const msg = e instanceof Error ? e.message : String(e)
      log.error('dispatch.failed', { reqId, tool: decision.name, args: decision.args, error: msg })
      return systemPause(services, reqId, 'system', `dispatch ${decision.name} failed: ${msg}`)
    }

    // ⑤ Persist + emit frame
    if (exit.kind === 'continue') {
      execState = exit.newState
      repos.runtimeState.upsert({
        requirementId: reqId,
        currentStep: execState.currentStep,
        historySummary: execState.historySummary,
        budgetUsed: budget.snapshot(),
      })
      bus.emit('runtime.heartbeat', { reqId, ts: Date.now() })
      bus.emit('requirement.frame', {
        reqId,
        currentStep: execState.currentStep,
        budgetUsed: budget.snapshot(),
      })
      continue
    }
    // 落盘最终 budget（pause / deliver / awaiting）
    repos.runtimeState.upsert({
      requirementId: reqId,
      currentStep: execState.currentStep,
      historySummary: execState.historySummary,
      budgetUsed: budget.snapshot(),
    })
    return { exit: exit.kind }
  }

  // 触达单次 execute 内最大循环（保险，正常应该被 budget 提前止住）
  return systemPause(services, reqId, 'system', `exceeded execute() loop limit ${maxLoops}`)
}

// ──────────────────────────────────────────────────────────────
// streaming buffer：同一段 thinking / text 累积到 1 条 message
//   provider 把 delta 切得很碎时（中文常见每 1–3 字一个 chunk），
//   不缓冲会落库成"每字一条"，UI 上呈竖排。
//   类型切换（thinking ↔ text）或 stream 结束（tool_use_stop /
//   message_stop / error / 循环退出）时 flush。
// ──────────────────────────────────────────────────────────────
interface StreamingBuffer {
  push(type: 'thinking' | 'text', text: string): void
  flush(): void
}

function createStreamingBuffer(ctx: {
  repos: RuntimeServices['repos']
  bus: RuntimeServices['bus']
  threadId: string
}): StreamingBuffer {
  let pending: { type: 'thinking' | 'text'; text: string } | null = null
  const flush = () => {
    if (!pending || pending.text.length === 0) {
      pending = null
      return
    }
    const { type, text } = pending
    pending = null
    const r = ctx.repos.messages.append({
      threadId: ctx.threadId,
      role: 'assistant',
      type,
      content: { type, text },
    })
    ctx.bus.emit('message.appended', {
      threadId: ctx.threadId,
      message: {
        id: r.id,
        threadId: ctx.threadId,
        seq: r.seq,
        role: 'assistant',
        type,
      },
    })
  }
  return {
    push(type, text) {
      if (pending && pending.type !== type) flush()
      if (!pending) pending = { type, text: '' }
      pending.text += text
    },
    flush,
  }
}

// ──────────────────────────────────────────────────────────────
// chunk 处理：thinking/text → buffer；tool_use_stop → 终止
// ──────────────────────────────────────────────────────────────
function handleChunk(
  c: RuntimeLLMChunk,
  ctx: {
    buffer: StreamingBuffer
    budget: BudgetTracker
  },
):
  | { kind: 'text'; text: string }
  | { kind: 'tool'; call: { callId: string; name: string; args: unknown } }
  | { kind: 'stop' }
  | { kind: 'error'; message: string }
  | { kind: 'noop' } {
  switch (c.type) {
    case 'thinking_delta':
    case 'text_delta': {
      ctx.buffer.push(c.type === 'thinking_delta' ? 'thinking' : 'text', c.text)
      return { kind: 'text', text: c.text }
    }
    case 'tool_use_stop': {
      ctx.buffer.flush()
      return { kind: 'tool', call: { callId: c.id, name: c.name, args: c.args } }
    }
    case 'usage': {
      ctx.budget.recordTokens(c.input, c.output, c.cached)
      return { kind: 'noop' }
    }
    case 'message_stop':
      ctx.buffer.flush()
      return { kind: 'stop' }
    case 'error':
      ctx.buffer.flush()
      return { kind: 'error', message: c.error.message }
    default:
      return { kind: 'noop' }
  }
}

// ──────────────────────────────────────────────────────────────
// Dispatch — 把 LLM tool call 翻译成状态机事件 / 工具执行
// ──────────────────────────────────────────────────────────────
async function dispatch(
  call: { callId: string; name: string; args: unknown },
  ctx: {
    services: RuntimeServices
    reqId: string
    thread: { id: string }
    employee: { id: string }
    currentStep: number
    historySummary: string
    plan: Plan | null
    grantedNames: string[]
  },
): Promise<
  | {
      kind: 'continue'
      newState: { currentStep: number; historySummary: string; budgetUsedJson: BudgetUsed }
    }
  | { kind: 'paused' | 'awaiting_user' | 'delivered' | 'forced_end' }
> {
  const { services, reqId, thread, employee } = ctx
  const { repos, bus } = services

  switch (call.name) {
    case 'advance_step': {
      const args = call.args as { step_idx?: number; summary?: string }
      const completedIdx =
        typeof args.step_idx === 'number' && args.step_idx >= 0 ? args.step_idx : ctx.currentStep
      // ① 更新 plan：把 idx <= completedIdx 的 step 标 done（容忍 LLM 跳号）
      const reqRow = repos.requirements.findById(reqId)
      if (reqRow?.planJson) {
        const nextPlan: Plan = {
          ...reqRow.planJson,
          steps: reqRow.planJson.steps.map((s) =>
            s.idx <= completedIdx && s.status !== 'done' ? { ...s, status: 'done' as const } : s,
          ),
        }
        repos.requirements.setPlan(reqId, nextPlan)
      }
      // ② summary → assistant text message（供 UI 思维链可见）
      const summary = typeof args.summary === 'string' ? args.summary.trim() : ''
      if (summary) {
        repos.messages.append({
          threadId: thread.id,
          role: 'assistant',
          type: 'text',
          content: { type: 'text', text: summary },
        })
      }
      // ③ historySummary 累积（不清空）— LLM 下轮能看到自己干过什么，避免空转
      const nextHistory = summary
        ? `${ctx.historySummary ? ctx.historySummary + '\n' : ''}[step ${completedIdx}] ${summary}`
        : ctx.historySummary
      // currentStep 单调递增 —— LLM 可能反复报旧的 step_idx；不允许倒退或停滞
      const nextStep = Math.max(ctx.currentStep + 1, completedIdx + 1)
      return {
        kind: 'continue',
        newState: {
          currentStep: nextStep,
          historySummary: nextHistory,
          budgetUsedJson: { iterations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0 },
        },
      }
    }
    case 'update_plan': {
      const args = call.args as { plan: Plan; reason: string }
      repos.requirements.setPlan(reqId, args.plan)
      repos.messages.append({
        threadId: thread.id,
        role: 'assistant',
        type: 'plan_update',
        content: { type: 'plan_update', plan: args.plan, reason: args.reason },
      })
      // 保留 historySummary —— update_plan 不代表"清空已做"，只是改后续 step 安排
      return {
        kind: 'continue',
        newState: {
          currentStep: ctx.currentStep,
          historySummary: ctx.historySummary,
          budgetUsedJson: { iterations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0 },
        },
      }
    }
    case 'ask_user': {
      // LLM args 形状不一定守约 — 容错地归一化
      const raw = (call.args ?? {}) as {
        questions?: unknown
        question?: unknown
        trigger_reason?: string
        trigger?: string
      }
      type Q = { question: string; answerMode?: 'user' | 'auto_proceed' }
      let questions: Q[] = []
      if (Array.isArray(raw.questions)) {
        questions = (raw.questions as unknown[])
          .map((q) => {
            if (typeof q === 'string') return { question: q }
            if (q && typeof q === 'object' && 'question' in q) {
              const obj = q as { question: unknown; answerMode?: unknown }
              return typeof obj.question === 'string'
                ? {
                    question: obj.question,
                    answerMode:
                      obj.answerMode === 'auto_proceed' || obj.answerMode === 'user'
                        ? obj.answerMode
                        : undefined,
                  }
                : null
            }
            return null
          })
          .filter((q): q is Q => q !== null)
      } else if (typeof raw.question === 'string') {
        questions = [{ question: raw.question }]
      }
      if (questions.length === 0) {
        throw new Error(
          `ask_user invalid args: expected non-empty 'questions' array, got ${JSON.stringify(call.args).slice(0, 200)}`,
        )
      }
      const trigger = (raw.trigger_reason ?? raw.trigger ?? 'execution') as string
      const round = repos.clarifications.create({
        requirementId: reqId,
        trigger: trigger as never,
        questions: questions.map((q) => ({
          question: q.question,
          answerMode: q.answerMode ?? 'user',
        })),
      })
      // 写一条 clarification_request message
      repos.messages.append({
        threadId: thread.id,
        role: 'assistant',
        type: 'clarification_request',
        content: { type: 'text', text: questions.map((q) => q.question).join('\n') },
      })
      // 状态转移：进行中 → 等待回答
      const t = transition('进行中', { kind: 'ask_user' })
      repos.requirements.setStatus(reqId, t.to)
      bus.emit('requirement.state_changed', {
        reqId,
        from: t.from,
        to: t.to,
        reason: t.reason,
      })
      bus.emit('requirement.clarification_ready', {
        reqId,
        clarificationId: round.id,
        round: round.round,
      })
      return { kind: 'awaiting_user' }
    }
    case 'emit_deliverable': {
      const args = call.args as { contentText?: string; contentRef?: string; summary: string }
      // attachments 由 server 层落盘；这里只记录 ref / text
      if (args.contentText) {
        repos.messages.append({
          threadId: thread.id,
          role: 'assistant',
          type: 'text',
          content: { type: 'text', text: args.contentText },
        })
      }
      if (args.contentRef) repos.requirements.setDeliverable(reqId, args.contentRef)
      else if (args.contentText) {
        // 把文本本身作为 inline deliverable
        repos.requirements.setDeliverable(reqId, `inline:${args.summary}`)
      }
      const t = transition('进行中', { kind: 'deliver' })
      repos.requirements.setStatus(reqId, t.to)
      bus.emit('requirement.state_changed', {
        reqId,
        from: t.from,
        to: t.to,
        reason: t.reason,
      })
      bus.emit('requirement.deliverable_ready', {
        reqId,
        deliverableRef: args.contentRef ?? `inline:${args.summary}`,
      })
      return { kind: 'delivered' }
    }
    default: {
      // 普通 tool —— 走 executor
      bus.emit('tool.invoked', { reqId, tool: call.name, input: call.args })
      const r = await services.toolExecutor.invoke(
        call,
        {
          requirementId: reqId,
          employeeId: employee.id,
          threadId: thread.id,
          signal: new AbortController().signal,
        },
        { grantedNames: ctx.grantedNames },
      )
      if (r.ok) {
        bus.emit('tool.result', { reqId, tool: call.name, result: r.value, ok: true })
        repos.messages.append({
          threadId: thread.id,
          role: 'tool',
          type: 'tool_result',
          content: { type: 'tool_result', callId: call.callId, ok: true, value: r.value },
        })
      } else {
        bus.emit('tool.failed', {
          reqId,
          tool: call.name,
          error: r.error?.message ?? 'unknown',
          retryCount: 0,
        })
        repos.messages.append({
          threadId: thread.id,
          role: 'tool',
          type: 'tool_result',
          content: {
            type: 'tool_result',
            callId: call.callId,
            ok: false,
            error: r.error?.message ?? 'unknown',
          },
        })
      }
      return {
        kind: 'continue',
        newState: {
          currentStep: ctx.currentStep,
          historySummary: ctx.historySummary,
          budgetUsedJson: { iterations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0 },
        },
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 系统级 pause — 状态转移 + 事件
// ──────────────────────────────────────────────────────────────
function systemPause(
  services: RuntimeServices,
  reqId: RequirementId,
  reason: PauseReason,
  detail = '',
): { exit: 'paused' } {
  const req = services.repos.requirements.findById(reqId)
  if (!req) return { exit: 'paused' }
  log.warn('system_pause', { reqId, from: req.status, reason, detail })
  const t = transition(req.status, { kind: 'system_pause', reason })
  services.repos.requirements.setStatus(reqId, t.to)
  // 把错误原因写进 messages 表，UI 思维链可见 — 否则用户看到的是「状态变回已暂停 + 思维链无消息」体验
  const thread = services.repos.threads.findByRequirement(reqId)
  if (thread) {
    services.repos.messages.append({
      threadId: thread.id,
      role: 'system',
      type: 'error',
      content: {
        type: 'error',
        message: `system_pause: ${reason}${detail ? ` — ${detail}` : ''}`,
        fatal: false,
      },
    })
  }
  services.bus.emit('requirement.state_changed', {
    reqId,
    from: t.from,
    to: t.to,
    reason: `${t.reason}${detail ? `: ${detail}` : ''}`,
  })
  services.bus.emit('requirement.paused', { reqId, reason })
  // 若 reason 是 budget_* —— 同时发 budget.exceeded
  if (reason === 'budget_iterations') {
    services.bus.emit('budget.exceeded', { reqId, gate: 'iterations' })
  } else if (reason === 'budget_tokens') {
    services.bus.emit('budget.exceeded', { reqId, gate: 'tokens' })
  } else if (reason === 'budget_walltime') {
    services.bus.emit('budget.exceeded', { reqId, gate: 'wallTime' })
  }
  return { exit: 'paused' }
}

// ──────────────────────────────────────────────────────────────
// LLM tool 形态构建（从 RuntimeToolDef + JSON Schema 映射）
// ──────────────────────────────────────────────────────────────
function buildLLMTool(
  t: RuntimeToolDef,
  services: RuntimeServices,
): { name: string; description: string; inputSchema: Record<string, unknown> } | null {
  const schema = services.toolJsonSchema(t.name)
  if (!schema) return null
  return { name: t.name, description: t.description, inputSchema: schema }
}
