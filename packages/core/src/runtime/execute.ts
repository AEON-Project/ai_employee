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
// V1.3 helpers — 检查 LLM 是否谎报"改了文件"
// ──────────────────────────────────────────────────────────────

/** 从 LLM 文本里提取"看起来像文件路径"的 token（带常见源代码后缀） */
function extractClaimedFilePaths(text: string): string[] {
  // 路径里允许字母/数字/. _ - / 组合；后缀白名单（避免抓 "1.0" / "v1.5" 之类）
  const re =
    /[A-Za-z0-9_\-./]+\.(java|kt|scala|ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|php|cs|swift|cpp|c|h|hpp|md|sql|json|yaml|yml|html|css|scss|less|xml|properties|toml|gradle|sh)\b/g
  const matches = text.match(re) ?? []
  // 去重 + 过滤明显非文件的 token（纯版本号等）
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of matches) {
    const norm = m.trim()
    // 至少包含一个 / 或 . 前面有字符（避免单纯 ".java" 被匹）
    if (norm.length < 5) continue
    if (seen.has(norm)) continue
    seen.add(norm)
    out.push(norm)
  }
  return out
}

/**
 * V1.3 (Bash 透传版)：扫 thread 历史的 Bash tool_call 命令文本，提取所有"在成功 Bash
 * 命令里出现过的文件路径 token"。emit_deliverable 用这个集合跟 claimed path 对账。
 *
 * 实现：
 *   1. 建立 callId → bash command 映射（从 tool_call message）
 *   2. 对每条 tool_result ok=true 且 exitCode=0：抓对应 command 文本里的 file path token
 *   3. 返回所有这些 path（去重）
 *
 * 限制（宽松版）：连 `cat file.java` 也视作"已涉及"。这是有意的 — 任何严格识别"写命令"
 * （sed -i / echo > / python -c）都会脆弱。宽松版的语义是"LLM 不能凭空声明从没在 shell
 * 出现过的文件名"，已经能挡住典型的"凭空谎报"路径。
 */
function collectModifiedPathsFromBashHistory(
  repos: RuntimeServices['repos'],
  threadId: string,
): string[] {
  const all = repos.messages.listByThread(threadId)
  const bashCallCommand = new Map<string, string>()
  for (const m of all) {
    if (m.type !== 'tool_call') continue
    const c = m.contentJson as { name?: string; callId?: string; args?: { command?: string } }
    if (c.name === 'Bash' && c.callId && typeof c.args?.command === 'string') {
      bashCallCommand.set(c.callId, c.args.command)
    }
  }
  const paths = new Set<string>()
  for (const m of all) {
    if (m.type !== 'tool_result') continue
    const tr = m.contentJson as
      | { callId?: string; ok?: boolean; value?: { exitCode?: number } }
      | undefined
    if (!tr?.ok || !tr.callId) continue
    if (tr.value?.exitCode != null && tr.value.exitCode !== 0) continue
    const cmd = bashCallCommand.get(tr.callId)
    if (!cmd) continue
    for (const p of extractClaimedFilePaths(cmd)) paths.add(p)
  }
  return [...paths]
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

      // V1.3: 防"谎报完成" —— summary/contentText 里声称改了文件，必须有对应的
      // Write/Edit ok=true 工具调用记录；否则拒绝交付。
      const claimedText = `${args.summary}\n${args.contentText ?? ''}`
      const claimedPaths = extractClaimedFilePaths(claimedText)
      if (claimedPaths.length > 0) {
        const editedPaths = collectModifiedPathsFromBashHistory(repos, thread.id)
        const unverified = claimedPaths.filter(
          (cp) => !editedPaths.some((ep) => ep.endsWith('/' + cp) || ep === cp || ep.endsWith(cp)),
        )
        if (unverified.length > 0) {
          log.warn('emit_deliverable.blocked', {
            reqId,
            claimedPaths,
            editedCount: editedPaths.length,
            unverified,
          })
          repos.messages.append({
            threadId: thread.id,
            role: 'system',
            type: 'error',
            content: {
              type: 'error',
              message: `emit_deliverable 已阻止：你在交付物里声称改动了以下文件 [${unverified.join(', ')}]，但 thread 历史里没有任何成功的 Bash 命令涉及过这些路径。必须**先用 Bash 命令真改文件**（如 \`sed -i "" "s/x/y/" path\` 或 \`echo "..." > path\`），确认 exitCode=0，才能 emit_deliverable。不要谎报完成。`,
              fatal: false,
            },
          })
          // 不进入"已交付"状态，让 LLM 下轮去真改
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
