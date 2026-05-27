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
import { reindexSource } from '../memory/memory.js'
import { assignRequirement } from './commands.js'
import { snapshot as snapshotCheckpoint } from '../checkpoint/index.js'
import { DEFAULT_BUDGET_CAP } from '@ai-emp/domain'
import type { RuntimeServices, RuntimeLLMChunk, RuntimeToolDef } from './services.js'

/** 终止信号：执行循环退出的几种方式 */
type ExitKind = 'paused' | 'awaiting_user' | 'delivered' | 'forced_end'

export interface ExecuteOptions {
  /** 单次循环最大轮数（防止本进程内死循环；与 budget.maxIterations 不同） */
  maxLoops?: number
  /** LLM 临时错误（429 / 5xx / 网络）的最大重试次数；默认 5 */
  maxLlmRetries?: number
}

const DEFAULT_MAX_LOOPS = 50
const DEFAULT_MAX_LLM_RETRIES = 5

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * V1.4: LLM 调用错误分类 —— 决定是否可重试 + 退避时长。
 *   - 429 / rate limit：尽量从错误文本提取 retry-after，加 buffer
 *   - 5xx / 网络抖动：固定 3s
 *   - 其他（401/403/schema 错误等）：不重试
 */
function analyzeLlmError(msg: string): {
  retryable: boolean
  delayMs: number
  reason: 'rate_limit' | 'transient_network' | 'permanent'
} {
  const m429 = /try again in\s+([\d.]+)\s*(ms|s)\b/i.exec(msg)
  if (m429 || /\b429\b|rate[\s-]?limit/i.test(msg)) {
    let delayMs = 2000
    if (m429) {
      const v = parseFloat(m429[1]!)
      delayMs = m429[2]!.toLowerCase() === 'ms' ? v : v * 1000
    }
    // 加 buffer 避免精确同步再撞；至少 1.5s
    return { retryable: true, delayMs: Math.max(delayMs + 500, 1500), reason: 'rate_limit' }
  }
  if (/\b5\d\d\b|ETIMEDOUT|ECONNRESET|ENOTFOUND|EPIPE|fetch failed|socket hang up/i.test(msg)) {
    return { retryable: true, delayMs: 3000, reason: 'transient_network' }
  }
  return { retryable: false, delayMs: 0, reason: 'permanent' }
}

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

  // V2 O4: 接单后第一次跑时自动建 baseline 快照（idempotent — 已存在就跳过）
  // 需要：services.checkpointsDir + project.workdir 都存在；任一缺失 silently skip
  // 子工单（parentRequirementId 非空）不建 baseline —— 父工单已经覆盖
  if (services.checkpointsDir && !req.parentRequirementId) {
    const existing = repos.checkpoints.findBaseline(reqId)
    if (!existing) {
      const proj = req.projectId ? repos.projects.findById(req.projectId) : null
      const workdir = proj?.workdir ?? null
      const baselineId = repos.checkpoints.create({
        requirementId: reqId,
        kind: 'baseline',
        label: 'auto baseline (on first execute)',
        backendKind: 'none', // 先占位，snapshot 完后回填
        workdir,
      })
      try {
        const { backendKind, ref } = await snapshotCheckpoint({
          requirementId: reqId,
          checkpointId: baselineId,
          workdir,
          checkpointsDir: services.checkpointsDir,
        })
        // 用 raw SQL 更新（CheckpointsRepo 没暴露 update，简化用 storage 内部 db 不方便；
        // 用 drizzle 直接更新现成实例不可，这里走 messages append 标记 + 重建一条）
        // 最简：删旧 + 重建（kind=baseline 仅 1 条，删除安全）
        // 实际更简单：直接用 sqlite 原生 update。为避免 schema 复杂化，加个简易方法。
        // 但为不引入 update 方法 churn，这里走一个临时方案：删 + 重建（仅 baseline 创建路径用）
        // 注意：删 + 重建会改 createdAt + id，但接下来不依赖 id；这里保留 id（不删）。
        // 真正干净：CheckpointsRepo 加 setBackendRef
        repos.checkpoints._setBackendRef(baselineId, backendKind, ref)
        log.info('checkpoint.baseline.auto', {
          reqId,
          baselineId,
          backendKind,
          ref: ref?.slice(0, 16) ?? null,
        })
      } catch (err) {
        log.warn('checkpoint.baseline.fail', { reqId, baselineId, err: String(err) })
      }
    }
  }

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
  // V1.4: LLM 调用临时错误（429 / 5xx / 网络）的退避重试计数（成功一轮后归零）
  let llmRetries = 0
  const MAX_LLM_RETRIES = opts.maxLlmRetries ?? DEFAULT_MAX_LLM_RETRIES

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
    try {
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
    } catch (e) {
      // provider 直接抛错（非 yield error chunk 路径，如 fetch 网络中断）
      llmError = e instanceof Error ? e.message : String(e)
    }
    // 兜底 flush：provider 没发 message_stop / tool_use_stop / error，
    // 直接断流时仍要把累积的 text 落库。
    streamBuffer.flush()
    const llmMs = Math.round(performance.now() - llmT0)
    if (llmError) {
      log.error('llm.call.error', { reqId, error: llmError, ms: llmMs, chunks: chunkCount })
      // V1.4: 临时错误（429 / 5xx / 网络）→ 退避重试，不立即 system_pause
      const r = analyzeLlmError(llmError)
      if (r.retryable && llmRetries < MAX_LLM_RETRIES) {
        llmRetries++
        log.warn('llm.retry', {
          reqId,
          attempt: llmRetries,
          maxAttempts: MAX_LLM_RETRIES,
          delayMs: r.delayMs,
          reason: r.reason,
        })
        await sleep(r.delayMs)
        continue // 重进 for loop（重新 budget check + compose + stream）
      }
      return systemPause(services, reqId, 'llm_error', llmError)
    }
    // 成功一轮后重置 retry 计数（下次再撞限流还能用满 MAX_LLM_RETRIES）
    llmRetries = 0
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
      // V1.2 (2): 上一次 tool 调用失败时硬阻止 advance（防 LLM 假装完成）
      //   扫最近 10 条 message，找最近一条 tool_result；若 ok=false → 拒绝，
      //   写一条 system/error 让 LLM 下一轮看到，并不更新 plan / currentStep / historySummary。
      const recent = repos.messages.tailByThread(thread.id, 10)
      for (let i = recent.length - 1; i >= 0; i--) {
        const m = recent[i]!
        if (m.type !== 'tool_result') continue
        const tr = m.contentJson as { ok?: boolean; error?: string }
        if (tr.ok === false) {
          const errMsg = tr.error ?? 'unknown'
          log.warn('advance_step.blocked', {
            reqId,
            lastToolError: errMsg,
            attemptedStep: completedIdx,
          })
          repos.messages.append({
            threadId: thread.id,
            role: 'system',
            type: 'error',
            content: {
              type: 'error',
              message: `advance_step 已阻止：上一次工具调用失败 (${errMsg.slice(0, 200)})。必须先修复（用 Glob/Read 找到正确路径再 Edit），不能跳过失败标记 step done。`,
              fatal: false,
            },
          })
          // 不推进 plan / step / history；让 LLM 下一轮重试
          return {
            kind: 'continue',
            newState: {
              currentStep: ctx.currentStep,
              historySummary: ctx.historySummary,
              budgetUsedJson: { iterations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0 },
            },
          }
        }
        break // 最近一条 tool_result 是 ok=true → 放行
      }
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
      // 不在 runtime 层判断"是否真改了文件" —— 借鉴 OpenClaw 设计哲学：
      // 员工提交工作，老板验收（approve / reject）时判断真假，引擎不预判。
      // 失败 / 谎报由用户在「待验收」状态看 git diff 等线索后 reject 即可。
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
    case 'emit_lesson': {
      // V2 O2 memory 闭环强化（PRD §3「纠错沉淀」核心机制）。
      // LLM 主动沉淀教训：写 memory_items(kind='lesson', scope=employee|project)，走 RAG 索引。
      // 与 reject 路径协作 —— LLM 主动 + 用户被动两条沉淀路径都最终走到这里的 schema。
      const argsL = call.args as { content?: string; scope?: string; context?: string }
      const lessonContent = typeof argsL.content === 'string' ? argsL.content.trim() : ''
      const lessonScope = argsL.scope === 'project' || argsL.scope === 'employee' ? argsL.scope : ''
      const lessonContext = typeof argsL.context === 'string' ? argsL.context.trim() : ''
      if (!lessonContent || !lessonScope) {
        log.warn('emit_lesson.invalid', {
          reqId,
          hasContent: !!lessonContent,
          hasScope: !!lessonScope,
        })
        repos.messages.append({
          threadId: thread.id,
          role: 'system',
          type: 'error',
          content: {
            type: 'error',
            message: `emit_lesson 已忽略：缺少必要字段（content / scope 均非空）。`,
            fatal: false,
          },
        })
        return {
          kind: 'continue',
          newState: {
            currentStep: ctx.currentStep,
            historySummary: ctx.historySummary,
            budgetUsedJson: { iterations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0 },
          },
        }
      }
      // scope=project 需要 req.projectId
      const reqRowL = repos.requirements.findById(reqId)
      let lessonScopeId: string
      if (lessonScope === 'project') {
        if (!reqRowL?.projectId) {
          log.warn('emit_lesson.no_project', { reqId })
          repos.messages.append({
            threadId: thread.id,
            role: 'system',
            type: 'error',
            content: {
              type: 'error',
              message: `emit_lesson 已忽略：scope='project' 但当前需求未挂项目，请改用 scope='employee'。`,
              fatal: false,
            },
          })
          return {
            kind: 'continue',
            newState: {
              currentStep: ctx.currentStep,
              historySummary: ctx.historySummary,
              budgetUsedJson: { iterations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0 },
            },
          }
        }
        lessonScopeId = reqRowL.projectId
      } else {
        lessonScopeId = employee.id
      }
      // 拼装 content（context 作为前缀，方便 embedding 命中）
      const fullContent = lessonContext
        ? `${lessonContent}\n（场景：${lessonContext}）`
        : lessonContent
      const lessonId = repos.memoryItems.create({
        scope: lessonScope,
        scopeId: lessonScopeId,
        kind: 'lesson',
        content: fullContent,
        sourceRequirementId: reqId,
      })
      if (services.memory) {
        try {
          await reindexSource(
            { repos, sqlite: services.memory.sqlite, embed: services.memory.embed },
            'memory_item',
            lessonId,
            fullContent,
          )
        } catch (err) {
          log.warn('emit_lesson.reindex_failed', { reqId, lessonId, err: String(err) })
        }
      }
      repos.messages.append({
        threadId: thread.id,
        role: 'assistant',
        type: 'text',
        content: {
          type: 'text',
          text: `📝 已沉淀 lesson（scope=${lessonScope}）：${lessonContent.slice(0, 80)}${lessonContent.length > 80 ? '…' : ''}`,
        },
      })
      bus.emit('memory.persisted', {
        items: [
          {
            id: lessonId,
            scope: lessonScope,
            scopeId: lessonScopeId,
            kind: 'lesson',
            content: fullContent,
          },
        ],
      })
      return {
        kind: 'continue',
        newState: {
          currentStep: ctx.currentStep,
          historySummary: ctx.historySummary,
          budgetUsedJson: { iterations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0 },
        },
      }
    }
    case 'checkpoint': {
      // V2 O4: LLM 主动建 manual snapshot；不暂停主流程
      const argsC = call.args as { label?: string }
      const label = typeof argsC.label === 'string' ? argsC.label.trim() : ''
      if (!label) {
        repos.messages.append({
          threadId: thread.id,
          role: 'system',
          type: 'error',
          content: {
            type: 'error',
            message: 'checkpoint 已忽略：label 必填且非空',
            fatal: false,
          },
        })
        return {
          kind: 'continue',
          newState: {
            currentStep: ctx.currentStep,
            historySummary: ctx.historySummary,
            budgetUsedJson: { iterations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0 },
          },
        }
      }
      if (!services.checkpointsDir) {
        repos.messages.append({
          threadId: thread.id,
          role: 'system',
          type: 'error',
          content: {
            type: 'error',
            message: 'checkpoint 已忽略：引擎未配置 checkpointsDir（baseline 也不会建）',
            fatal: false,
          },
        })
        return {
          kind: 'continue',
          newState: {
            currentStep: ctx.currentStep,
            historySummary: ctx.historySummary,
            budgetUsedJson: { iterations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0 },
          },
        }
      }
      const reqRowC = repos.requirements.findById(reqId)
      const projC = reqRowC?.projectId ? repos.projects.findById(reqRowC.projectId) : null
      const workdirC = projC?.workdir ?? null
      const ckptId = repos.checkpoints.create({
        requirementId: reqId,
        kind: 'manual',
        label,
        backendKind: 'none',
        workdir: workdirC,
      })
      try {
        const { backendKind, ref } = await snapshotCheckpoint({
          requirementId: reqId,
          checkpointId: ckptId,
          workdir: workdirC,
          checkpointsDir: services.checkpointsDir,
        })
        repos.checkpoints._setBackendRef(ckptId, backendKind, ref)
        log.info('checkpoint.manual', {
          reqId,
          ckptId,
          label,
          backendKind,
          ref: ref?.slice(0, 16) ?? null,
        })
        repos.messages.append({
          threadId: thread.id,
          role: 'assistant',
          type: 'text',
          content: {
            type: 'text',
            text: `📸 已建快照「${label}」(${backendKind})。用户驳回时可回滚到此点。`,
          },
        })
      } catch (err) {
        log.warn('checkpoint.manual.fail', { reqId, ckptId, err: String(err) })
        repos.messages.append({
          threadId: thread.id,
          role: 'system',
          type: 'error',
          content: {
            type: 'error',
            message: `checkpoint「${label}」快照失败：${String(err).slice(0, 200)}`,
            fatal: false,
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
    case 'spawn_employee': {
      // V2 O3 sub-agent 协作：父员工同步派发子任务给另一员工，引擎嵌套
      // 执行子工单后把子员工 deliverable 作为 tool_result 回传给父员工。
      // 防递归：parentRequirementId 已存在的子工单不可再 spawn（深度 ≤ 1）。
      const argsS = call.args as {
        targetEmployeeId?: string
        taskTitle?: string
        taskDescription?: string
      }
      const targetEmpId =
        typeof argsS.targetEmployeeId === 'string' ? argsS.targetEmployeeId.trim() : ''
      const taskTitle = typeof argsS.taskTitle === 'string' ? argsS.taskTitle.trim() : ''
      const taskDesc = typeof argsS.taskDescription === 'string' ? argsS.taskDescription.trim() : ''

      const writeSpawnError = (errMsg: string) => {
        repos.messages.append({
          threadId: thread.id,
          role: 'system',
          type: 'error',
          content: { type: 'error', message: errMsg, fatal: false },
        })
      }

      if (!targetEmpId || !taskTitle || !taskDesc) {
        writeSpawnError(
          'spawn_employee 已忽略：缺少必要字段（targetEmployeeId / taskTitle / taskDescription 均非空）',
        )
        return {
          kind: 'continue',
          newState: {
            currentStep: ctx.currentStep,
            historySummary: ctx.historySummary,
            budgetUsedJson: { iterations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0 },
          },
        }
      }

      // 防递归：当前工单已经是子工单（有 parent），不允许再 spawn
      const reqRowS = repos.requirements.findById(reqId)
      if (reqRowS?.parentRequirementId) {
        writeSpawnError(
          'spawn_employee 已拒绝：当前工单本身是子工单（parentRequirementId 非空），不允许进一步派发。请把任务做完或 ask_user 让用户协调。',
        )
        return {
          kind: 'continue',
          newState: {
            currentStep: ctx.currentStep,
            historySummary: ctx.historySummary,
            budgetUsedJson: { iterations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0 },
          },
        }
      }

      // 防自环：targetEmployeeId 不能就是当前员工
      if (targetEmpId === employee.id) {
        writeSpawnError(
          `spawn_employee 已拒绝：targetEmployeeId=${targetEmpId} 就是当前员工自己，不要 spawn 给自己。`,
        )
        return {
          kind: 'continue',
          newState: {
            currentStep: ctx.currentStep,
            historySummary: ctx.historySummary,
            budgetUsedJson: { iterations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0 },
          },
        }
      }

      const targetEmp = repos.employees.findById(targetEmpId)
      if (!targetEmp) {
        writeSpawnError(
          `spawn_employee 已忽略：找不到 employee id=${targetEmpId}。请先通过 list_employees 等方式确认 id。`,
        )
        return {
          kind: 'continue',
          newState: {
            currentStep: ctx.currentStep,
            historySummary: ctx.historySummary,
            budgetUsedJson: { iterations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0 },
          },
        }
      }

      // 创建子工单
      const subReqId = repos.requirements.create({
        title: taskTitle,
        description: taskDesc,
        projectId: reqRowS?.projectId ?? null,
        parentRequirementId: reqId,
        budgetCap: reqRowS?.budgetCapJson ?? DEFAULT_BUDGET_CAP,
      })
      // 派活（skipClarification = true，子员工直接进入 '进行中'）
      assignRequirement(services, subReqId, targetEmpId, { skipClarification: true })

      log.info('spawn_employee.start', {
        parentReqId: reqId,
        subReqId,
        targetEmpId,
        taskTitle,
      })

      // 父 thread 留痕：tool_call message
      repos.messages.append({
        threadId: thread.id,
        role: 'assistant',
        type: 'tool_call',
        content: {
          type: 'tool_call',
          name: 'spawn_employee',
          callId: call.callId,
          args: { targetEmployeeId: targetEmpId, taskTitle, subRequirementId: subReqId },
        },
      })
      bus.emit('tool.invoked', {
        reqId,
        tool: 'spawn_employee',
        input: { targetEmployeeId: targetEmpId, taskTitle, subRequirementId: subReqId },
      })

      // 嵌套同步执行子工单（子有自己的 BudgetTracker；父的 budget 不算子的）
      let subExit: ExitKind = 'paused'
      try {
        const r = await executeRequirement(subReqId, services)
        subExit = r.exit
      } catch (err) {
        log.warn('spawn_employee.subexec_error', {
          parentReqId: reqId,
          subReqId,
          err: String(err),
        })
      }

      const subReqAfter = repos.requirements.findById(subReqId)
      const subStatus = subReqAfter?.status ?? '已暂停'
      const subDeliverable = subReqAfter?.deliverableRef ?? null

      // 把子 thread 最后一条 assistant text 抓出来作为人类可读摘要
      let subSummary = ''
      const subThread = repos.threads.findByRequirement(subReqId)
      if (subThread) {
        const subMsgs = repos.messages.listByThread(subThread.id)
        for (let i = subMsgs.length - 1; i >= 0; i--) {
          const m = subMsgs[i]!
          if (m.role === 'assistant' && m.type === 'text') {
            const t = (m.contentJson as { text?: string }).text ?? ''
            if (t.trim().length > 0) {
              subSummary = t.slice(0, 800)
              break
            }
          }
        }
      }

      // 写 tool_result 到父 thread（父员工下一轮 LLM 调用就能看到）
      const ok = subExit === 'delivered'
      repos.messages.append({
        threadId: thread.id,
        role: 'tool',
        type: 'tool_result',
        content: {
          type: 'tool_result',
          callId: call.callId,
          ok,
          value: {
            subRequirementId: subReqId,
            subEmployeeId: targetEmpId,
            subEmployeeName: targetEmp.name,
            subStatus,
            subExit,
            deliverableRef: subDeliverable,
            summary: subSummary,
          },
        },
      })
      bus.emit('tool.result', {
        reqId,
        tool: 'spawn_employee',
        result: {
          subRequirementId: subReqId,
          subStatus,
          subExit,
          deliverableRef: subDeliverable,
        },
        ok,
      })

      log.info('spawn_employee.end', {
        parentReqId: reqId,
        subReqId,
        subStatus,
        subExit,
        ok,
      })

      return {
        kind: 'continue',
        newState: {
          currentStep: ctx.currentStep,
          historySummary: ctx.historySummary,
          budgetUsedJson: { iterations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0 },
        },
      }
    }
    case 'emit_skill': {
      // V2 O1 Skills 自演化：把 LLM 总结的"可复用做法套路"沉淀进 memory_items(kind='skill', scope='employee')。
      // 走 RAG 索引；下次同员工接到相似需求时 composer 自动注入到 system prompt。
      // 不改变执行状态机，旁路沉淀；continue 让 LLM 紧接着 emit_deliverable 或继续干。
      const args = call.args as {
        name?: string
        whenToUse?: string
        steps?: unknown
        triggers?: unknown
      }
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      const whenToUse = typeof args.whenToUse === 'string' ? args.whenToUse.trim() : ''
      const stepsArr = Array.isArray(args.steps)
        ? args.steps.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        : []
      const triggersArr = Array.isArray(args.triggers)
        ? args.triggers.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        : []
      if (!name || !whenToUse || stepsArr.length === 0) {
        log.warn('emit_skill.invalid', {
          reqId,
          hasName: !!name,
          hasWhen: !!whenToUse,
          stepCount: stepsArr.length,
        })
        // 写一条 system/error 让 LLM 下一轮看到，但不暂停整体流程
        repos.messages.append({
          threadId: thread.id,
          role: 'system',
          type: 'error',
          content: {
            type: 'error',
            message: `emit_skill 已忽略：缺少必要字段（name / whenToUse / steps[] 均非空）。可重试或直接跳过此次沉淀。`,
            fatal: false,
          },
        })
        return {
          kind: 'continue',
          newState: {
            currentStep: ctx.currentStep,
            historySummary: ctx.historySummary,
            budgetUsedJson: { iterations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0 },
          },
        }
      }
      // 组装结构化 markdown 写入 memory_items.content
      // 整段 content 也用作 embedding 输入，关键词自然被向量捕获
      const triggerLine = triggersArr.length > 0 ? `\n关键词: ${triggersArr.join(', ')}` : ''
      const stepsBlock = stepsArr.map((s, i) => `${i + 1}. ${s}`).join('\n')
      const content = [
        `**Skill: ${name}**`,
        `何时复用: ${whenToUse}${triggerLine}`,
        '步骤:',
        stepsBlock,
      ].join('\n')

      const skillId = repos.memoryItems.create({
        scope: 'employee',
        scopeId: employee.id,
        kind: 'skill',
        content,
        sourceRequirementId: reqId,
      })

      // 走 RAG 索引（有 memory 服务时才索引；否则 LLM 仍可通过 list/SQL 拿到，但 RAG 命中率为 0）
      if (services.memory) {
        try {
          await reindexSource(
            {
              repos,
              sqlite: services.memory.sqlite,
              embed: services.memory.embed,
            },
            'memory_item',
            skillId,
            content,
          )
        } catch (err) {
          log.warn('emit_skill.reindex_failed', { reqId, skillId, err: String(err) })
        }
      }

      // 写一条思维链可见的 assistant text，方便用户在 UI 看到员工沉淀了什么
      repos.messages.append({
        threadId: thread.id,
        role: 'assistant',
        type: 'text',
        content: {
          type: 'text',
          text: `📚 已沉淀 skill「${name}」到长期记忆（员工：${employee.id.slice(0, 8)}）。未来同类需求会自动注入。`,
        },
      })
      bus.emit('memory.persisted', {
        items: [
          {
            id: skillId,
            scope: 'employee',
            scopeId: employee.id,
            kind: 'skill',
            content,
          },
        ],
      })

      return {
        kind: 'continue',
        newState: {
          currentStep: ctx.currentStep,
          historySummary: ctx.historySummary,
          budgetUsedJson: { iterations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0 },
        },
      }
    }
    default: {
      // 普通 tool —— 走 executor
      // 先 append 一条 tool_call message（V1.3 对账要 Bash command 文本）
      repos.messages.append({
        threadId: thread.id,
        role: 'assistant',
        type: 'tool_call',
        content: {
          type: 'tool_call',
          name: call.name,
          callId: call.callId,
          args: call.args,
        },
      })
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
