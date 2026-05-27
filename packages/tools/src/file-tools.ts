/**
 * V1.1 标准工具集 —— 纯 Bash 透传，给 LLM 完整本地权限。
 *
 * **设计哲学**（单用户本地引擎 + 用户决策）：
 *   - 只暴露 `Bash` + `Process` 工具（Process 用于查后台进度），LLM 用 cat / sed / find /
 *     grep -r / curl / brew / npm / pip / git / mvn / chmod 等本地命令自由完成任务。
 *   - 引擎做"透传"：把命令丢给 zsh -lc，stdout/stderr 截断后回传 LLM。
 *   - 不做路径白名单 / 沙箱，等同于运行 server 的用户的终端权限。
 *
 * **V1.5 增强**（借鉴 OpenClaw）：
 *   - `env`：临时环境变量（如 JAVA_HOME=/path mvn compile）
 *   - `yield_ms`：长命令在 yield_ms 后转后台运行，返回 partial output + sessionId，
 *     LLM 之后调 Process tool 查进度。这样 mvn compile / npm install 不会被 120s
 *     硬超时杀掉。
 *   - `background=true`：立即后台（等价 yield_ms=0）。
 *   - `Process` tool：read / status / kill 后台进程。
 *
 * 工程稳定性：
 *   - 输出截断 50000 字符（防 LLM context 爆炸）
 *   - 默认 120s 超时；最大 600s；AbortController + SIGKILL 杀进程
 *   - 所有 Bash 调用写 NDJSON 审计日志（scope=tools.file）
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { getLogger } from '@ai-emp/domain'
import type { ToolDef } from './types.js'

const log = getLogger('tools.file')

const MAX_OUTPUT_CHARS = 50_000
const DEFAULT_BASH_TIMEOUT_MS = 120_000
const DEFAULT_YIELD_MS = 30_000 // 默认 30s 不结束就转后台

// ── 后台进程注册表（in-memory）──────────────────────────────────
interface ProcessSession {
  id: string
  command: string
  cwd: string
  startedAt: number
  child: ChildProcessWithoutNullStreams
  stdout: string
  stderr: string
  stdoutTrunc: boolean
  stderrTrunc: boolean
  status: 'running' | 'completed' | 'killed' | 'failed'
  exitCode: number | null
  finishedAt: number | null
}

const sessions = new Map<string, ProcessSession>()

/** 测试辅助：清空所有 session，杀掉残留进程 */
export function _resetSessionsForTest(): void {
  for (const s of sessions.values()) {
    try {
      if (s.status === 'running') s.child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
  sessions.clear()
}

// ── Bash ───────────────────────────────────────────────────────
const BashArgsZ = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  timeout_ms: z.number().int().positive().max(600_000).optional(),
  yield_ms: z.number().int().nonnegative().max(600_000).optional(),
  background: z.boolean().optional(),
})
type BashArgs = z.infer<typeof BashArgsZ>

interface BashResult {
  status: 'completed' | 'running' | 'failed'
  sessionId?: string
  stdout: string
  stderr: string
  exitCode: number | null
  truncated: boolean
  durationMs: number
}

export const bashTool: ToolDef<BashArgs, BashResult> = {
  name: 'Bash',
  kind: 'standard',
  description: [
    '在用户本地机器上执行任意 shell 命令（zsh -lc）。等同于用户在终端的完整权限。',
    '可以做任何事：',
    '  - 查文件：`find . -name "*.java"`、`ls -la`、`tree -L 2`',
    '  - 看内容：`cat file`、`sed -n "10,30p" file`、`head -50 file`',
    '  - 搜内容：`grep -rn "pattern" path/`、`rg "pattern"`',
    '  - 改文件：`sed -i "" "s/old/new/g" file.java`（macOS）、`echo "..." > file`、`cat > file <<EOF ... EOF`',
    '  - 装软件：`brew install xxx`、`npm install yyy`、`pip install zzz`',
    '  - 编译：`mvn compile`、`go build`、`cargo check`',
    '  - 网络：`curl ...`、`wget ...`、`gh pr view ...`',
    '  - 权限：`chmod +x ...`、`sudo ...`（如有 sudo 配置）',
    '默认 cwd = server 启动目录；绝对路径优先。',
    '默认 timeout_ms=120000（120s）；最大 600000。',
    '长命令（mvn compile / npm install）：传 yield_ms（默认 30000，30s）—— 超时**不会被杀**，',
    '而是转后台运行，立即返回 partial output + sessionId；后续用 `Process` 工具 read sessionId 看进度。',
    '`background=true` 立即后台（等价 yield_ms=0）。',
    '⚠️ 不要执行交互式命令（vim / ssh tty / git rebase -i）—— 无法处理输入。',
    '⚠️ 输出 stdout/stderr 各上限 50000 字符，超过自动截断。',
  ].join('\n'),
  inputSchema: BashArgsZ,
  timeoutMs: 600_000, // executor 层兜底上限
  inputJsonSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令（zsh -lc 解析）' },
      cwd: {
        type: 'string',
        description: '工作目录（绝对路径或相对 server cwd），默认 server cwd',
      },
      env: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: '附加的环境变量（合并到 process.env 之上），如 {"JAVA_HOME": "/path"}',
      },
      timeout_ms: {
        type: 'integer',
        minimum: 1,
        maximum: 600000,
        description: '硬超时（前台同步等待），默认 120000；超时会 SIGKILL。',
      },
      yield_ms: {
        type: 'integer',
        minimum: 0,
        maximum: 600000,
        description:
          '前台等多久后转后台：默认 30000；命令在此时间内未结束则返回 status=running + sessionId（不 kill），LLM 用 Process tool 续读。',
      },
      background: {
        type: 'boolean',
        description: 'true=立即后台（等价 yield_ms=0）',
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
  invoke: async (args, ctx) => {
    const cwd = args.cwd
      ? isAbsolute(args.cwd)
        ? args.cwd
        : resolve(process.cwd(), args.cwd)
      : process.cwd()
    const timeoutMs = args.timeout_ms ?? DEFAULT_BASH_TIMEOUT_MS
    const yieldMs = args.background ? 0 : (args.yield_ms ?? DEFAULT_YIELD_MS)
    const envOverride = args.env ?? {}
    const childEnv = { ...process.env, ...envOverride }
    const t0 = Date.now()
    const sessionId = randomUUID()

    const child = spawn('zsh', ['-lc', args.command], { cwd, env: childEnv })
    const session: ProcessSession = {
      id: sessionId,
      command: args.command,
      cwd,
      startedAt: t0,
      child,
      stdout: '',
      stderr: '',
      stdoutTrunc: false,
      stderrTrunc: false,
      status: 'running',
      exitCode: null,
      finishedAt: null,
    }
    sessions.set(sessionId, session)

    child.stdout.on('data', (b: Buffer) => {
      if (session.stdout.length < MAX_OUTPUT_CHARS) {
        session.stdout += b.toString('utf8')
        if (session.stdout.length > MAX_OUTPUT_CHARS) {
          session.stdout = session.stdout.slice(0, MAX_OUTPUT_CHARS)
          session.stdoutTrunc = true
        }
      }
    })
    child.stderr.on('data', (b: Buffer) => {
      if (session.stderr.length < MAX_OUTPUT_CHARS) {
        session.stderr += b.toString('utf8')
        if (session.stderr.length > MAX_OUTPUT_CHARS) {
          session.stderr = session.stderr.slice(0, MAX_OUTPUT_CHARS)
          session.stderrTrunc = true
        }
      }
    })

    // 命令完成 / 失败 / 被杀 Promise
    let timeoutKilled = false
    const completion = new Promise<void>((resolveDone) => {
      const onAbort = () => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* */
        }
      }
      ctx.signal.addEventListener('abort', onAbort)
      const timer = setTimeout(() => {
        timeoutKilled = true
        try {
          child.kill('SIGKILL')
        } catch {
          /* */
        }
      }, timeoutMs)
      child.on('error', (err) => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        session.status = 'failed'
        session.stderr += `\n[spawn error] ${String(err)}`
        session.exitCode = -1
        session.finishedAt = Date.now()
        resolveDone()
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        session.exitCode = code ?? -1
        session.finishedAt = Date.now()
        session.status = timeoutKilled ? 'killed' : code === 0 ? 'completed' : 'failed'
        resolveDone()
      })
    })

    // yield: 在 yieldMs 内等命令结束；超时则转后台返回 partial
    const yielded = await Promise.race([
      completion.then(() => false), // 完成
      new Promise<boolean>((r) => setTimeout(() => r(true), yieldMs)), // yieldMs 超时 → true
    ])

    if (yielded && session.status === 'running') {
      // 转后台运行：保留 session，返回 partial
      log.info('Bash.yield', {
        cwd,
        cmd: args.command.slice(0, 200),
        yieldMs,
        sessionId,
      })
      return {
        status: 'running',
        sessionId,
        stdout: session.stdout,
        stderr: session.stderr,
        exitCode: null,
        truncated: session.stdoutTrunc || session.stderrTrunc,
        durationMs: Date.now() - t0,
      }
    }

    // 同步结束（包括完成 / 失败 / timeout 杀掉）
    log.info('Bash', {
      cwd,
      cmd: args.command.slice(0, 200),
      exitCode: session.exitCode,
      durationMs: (session.finishedAt ?? Date.now()) - t0,
      status: session.status,
    })
    // 前台同步结束后从 registry 移除（保留有限时间也行；最简：立即清）
    sessions.delete(sessionId)

    return {
      status: session.status === 'completed' ? 'completed' : 'failed',
      stdout: session.stdout,
      stderr: session.stderr,
      exitCode: session.exitCode,
      truncated: session.stdoutTrunc || session.stderrTrunc,
      durationMs: (session.finishedAt ?? Date.now()) - t0,
    }
  },
}

// ── Process（管理后台 Bash session）─────────────────────────────
const ProcessArgsZ = z.object({
  sessionId: z.string().min(1),
  action: z.enum(['read', 'status', 'kill']).optional(),
})
type ProcessArgs = z.infer<typeof ProcessArgsZ>

interface ProcessResult {
  sessionId: string
  status: 'running' | 'completed' | 'killed' | 'failed' | 'unknown'
  exitCode: number | null
  stdout?: string
  stderr?: string
  truncated?: boolean
  durationMs?: number
  command?: string
}

export const processTool: ToolDef<ProcessArgs, ProcessResult> = {
  name: 'Process',
  kind: 'standard',
  description: [
    '查/控后台 Bash session（由 Bash yield_ms / background=true 创建）。',
    'action:',
    '  - `read`（默认）: 返回当前累计 stdout/stderr + 状态。',
    '  - `status`: 仅返回状态（不读输出，省 context）。',
    '  - `kill`: SIGKILL 后台进程并标记 killed。',
    '完成 / 失败 / 被杀 的 session 在被 read 一次后从内存清掉。',
  ].join('\n'),
  inputSchema: ProcessArgsZ,
  timeoutMs: 5_000,
  inputJsonSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Bash yield 返回的 sessionId' },
      action: { type: 'string', enum: ['read', 'status', 'kill'], description: '默认 read' },
    },
    required: ['sessionId'],
    additionalProperties: false,
  },
  invoke: async (args, _ctx) => {
    const session = sessions.get(args.sessionId)
    if (!session) {
      return {
        sessionId: args.sessionId,
        status: 'unknown',
        exitCode: null,
      }
    }
    const action = args.action ?? 'read'

    if (action === 'kill') {
      if (session.status === 'running') {
        try {
          session.child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        session.status = 'killed'
        session.finishedAt = Date.now()
      }
      const result: ProcessResult = {
        sessionId: args.sessionId,
        status: session.status,
        exitCode: session.exitCode,
        durationMs: (session.finishedAt ?? Date.now()) - session.startedAt,
        command: session.command,
      }
      sessions.delete(args.sessionId)
      log.info('Process.kill', { sessionId: args.sessionId })
      return result
    }

    if (action === 'status') {
      return {
        sessionId: args.sessionId,
        status: session.status,
        exitCode: session.exitCode,
        durationMs: (session.finishedAt ?? Date.now()) - session.startedAt,
        command: session.command,
      }
    }

    // read：返回累计输出 + 状态；如果已结束，read 一次后从 registry 移除
    const result: ProcessResult = {
      sessionId: args.sessionId,
      status: session.status,
      exitCode: session.exitCode,
      stdout: session.stdout,
      stderr: session.stderr,
      truncated: session.stdoutTrunc || session.stderrTrunc,
      durationMs: (session.finishedAt ?? Date.now()) - session.startedAt,
      command: session.command,
    }
    if (session.status !== 'running') {
      sessions.delete(args.sessionId)
    }
    log.info('Process.read', { sessionId: args.sessionId, status: session.status })
    return result
  },
}

export const FILE_TOOLS: ToolDef[] = [bashTool as ToolDef, processTool as ToolDef]
export const FILE_TOOL_NAMES = FILE_TOOLS.map((t) => t.name)
