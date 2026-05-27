/**
 * V1.1 标准工具集 —— 纯 Bash 透传，给 LLM 完整本地权限。
 *
 * **设计哲学**（单用户本地引擎 + 用户决策）：
 *   - 只暴露 1 个 `Bash` 工具 —— LLM 用 cat / sed / find / grep -r / curl / brew /
 *     npm / pip / git / mvn / chmod 等本地命令自由完成任务。
 *   - 引擎做"透传"：把命令丢给 zsh -lc，stdout/stderr 截断后回传 LLM。
 *   - **不**包装 Read/Write/Edit/Glob/Grep —— 这些都被 LLM 用 unix 命令更灵活地表达。
 *   - 不做路径白名单 / 沙箱，等同于运行 server 的用户的终端权限。
 *
 * 工程稳定性（保留）：
 *   - 输出截断 50000 字符（防 LLM context 爆炸）
 *   - 默认 120s 超时；最大 600s；AbortController + SIGKILL 杀进程
 *   - 所有 Bash 调用写 NDJSON 审计日志（scope=tools.file）
 */

import { spawn } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { getLogger } from '@ai-emp/domain'
import type { ToolDef } from './types.js'

const log = getLogger('tools.file')

const MAX_OUTPUT_CHARS = 50_000
const DEFAULT_BASH_TIMEOUT_MS = 120_000

const BashArgsZ = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeout_ms: z.number().int().positive().max(600_000).optional(),
})
type BashArgs = z.infer<typeof BashArgsZ>

interface BashResult {
  stdout: string
  stderr: string
  exitCode: number
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
    '  - 改文件：`sed -i "" "s/old/new/g" file.java`（macOS）、`echo "..." > file`、`cat >> file <<EOF ... EOF`',
    '  - 装软件：`brew install xxx`、`npm install yyy`、`pip install zzz`',
    '  - 编译：`mvn compile`、`go build`、`cargo check`',
    '  - 网络：`curl ...`、`wget ...`、`gh pr view ...`',
    '  - 权限：`chmod +x ...`、`sudo ...`（如有 sudo 配置）',
    '默认 cwd = server 启动目录；绝对路径优先。默认 120s 超时（max 600s）。',
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
      timeout_ms: { type: 'integer', minimum: 1, maximum: 600000, description: '默认 120000' },
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
    const t0 = Date.now()
    return await new Promise<BashResult>((resolveFn, rejectFn) => {
      const child = spawn('zsh', ['-lc', args.command], { cwd })
      let stdout = ''
      let stderr = ''
      let stdoutTrunc = false
      let stderrTrunc = false
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT_CHARS) {
          stdout += chunk.toString('utf8')
          if (stdout.length > MAX_OUTPUT_CHARS) {
            stdout = stdout.slice(0, MAX_OUTPUT_CHARS)
            stdoutTrunc = true
          }
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_OUTPUT_CHARS) {
          stderr += chunk.toString('utf8')
          if (stderr.length > MAX_OUTPUT_CHARS) {
            stderr = stderr.slice(0, MAX_OUTPUT_CHARS)
            stderrTrunc = true
          }
        }
      })
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already exited */
        }
      }, timeoutMs)
      const onAbort = () => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* */
        }
      }
      ctx.signal.addEventListener('abort', onAbort)
      child.on('error', (err) => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        rejectFn(err)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        const result: BashResult = {
          stdout,
          stderr,
          exitCode: code ?? -1,
          truncated: stdoutTrunc || stderrTrunc,
          durationMs: Date.now() - t0,
        }
        log.info('Bash', {
          cwd,
          cmd: args.command.slice(0, 200),
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        })
        resolveFn(result)
      })
    })
  },
}

export const FILE_TOOLS: ToolDef[] = [bashTool as ToolDef]
export const FILE_TOOL_NAMES = FILE_TOOLS.map((t) => t.name)
