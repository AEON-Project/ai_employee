/**
 * V1.1 file/shell tool 集 —— 类似 Claude Code 的本地权限工具。
 *
 * 6 个 tool：Read / Write / Edit / Glob / Grep / Bash
 *
 * **权限模型**（单用户本地引擎决策）：
 *   - 不做路径白名单，不做沙箱。LLM 拿到的就是运行 server 的用户的完整本地权限。
 *   - 等同于用户自己在终端跑命令。这是"AI 数字员工"的语义。
 *   - 相对路径基于 process.cwd()（server 启动目录）；绝对路径直接生效。
 *
 * 工程稳定性（保留）：
 *   - 输出截断 50000 字符（防 LLM context 爆炸）
 *   - bash 默认 120s 超时；最大 10 分钟；AbortController 杀进程
 *   - 所有 tool 行为写 NDJSON 审计日志（DEBUGGING §3）
 */

import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { Glob } from 'bun'
import { z } from 'zod'
import { getLogger } from '@ai-emp/domain'
import type { ToolDef } from './types.js'

const log = getLogger('tools.file')

const MAX_OUTPUT_CHARS = 50_000
const DEFAULT_BASH_TIMEOUT_MS = 120_000

/** 相对路径基于 process.cwd()；绝对路径原样 */
function resolvePath(input: string): string {
  return isAbsolute(input) ? input : resolve(process.cwd(), input)
}

function truncate(s: string, max = MAX_OUTPUT_CHARS): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false }
  return { text: s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`, truncated: true }
}

// ── Read ───────────────────────────────────────────────────────
const ReadArgsZ = z.object({
  path: z.string().min(1),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
})
type ReadArgs = z.infer<typeof ReadArgsZ>

export const readTool: ToolDef<ReadArgs, { content: string; lines: number; truncated: boolean }> = {
  name: 'Read',
  kind: 'standard',
  description:
    '读取本地文件（任意绝对或相对路径；相对路径基于 server cwd）。' +
    '支持 offset/limit 按行切片。输出上限 50000 字符，超过自动截断。',
  inputSchema: ReadArgsZ,
  inputJsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '绝对路径或相对 server cwd 的路径' },
      offset: { type: 'integer', minimum: 0, description: '起始行号（0-based）' },
      limit: { type: 'integer', minimum: 1, description: '最多读取行数' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  invoke: async (args, _ctx) => {
    const p = resolvePath(args.path)
    const raw = readFileSync(p, 'utf8')
    const lines = raw.split('\n')
    const start = args.offset ?? 0
    const end = args.limit !== undefined ? start + args.limit : lines.length
    const slice = lines.slice(start, end).join('\n')
    const { text, truncated } = truncate(slice)
    log.debug('Read', { path: p, lines: lines.length, slice: end - start, truncated })
    return { content: text, lines: lines.length, truncated }
  },
}

// ── Write ──────────────────────────────────────────────────────
const WriteArgsZ = z.object({
  path: z.string().min(1),
  content: z.string(),
})
type WriteArgs = z.infer<typeof WriteArgsZ>

export const writeTool: ToolDef<WriteArgs, { path: string; bytes: number }> = {
  name: 'Write',
  kind: 'standard',
  description:
    '写文件到任意路径。父目录不存在自动创建。覆盖现有内容（如要修改部分内容，用 Edit）。',
  inputSchema: WriteArgsZ,
  inputJsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '绝对路径或相对 server cwd 的路径' },
      content: { type: 'string', description: '完整文件内容' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  invoke: async (args, _ctx) => {
    const p = resolvePath(args.path)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, args.content, 'utf8')
    log.info('Write', { path: p, bytes: args.content.length })
    return { path: p, bytes: args.content.length }
  },
}

// ── Edit ───────────────────────────────────────────────────────
const EditArgsZ = z.object({
  path: z.string().min(1),
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
})
type EditArgs = z.infer<typeof EditArgsZ>

export const editTool: ToolDef<EditArgs, { path: string; replaced: number }> = {
  name: 'Edit',
  kind: 'standard',
  description:
    '精确字符串替换：在 path 文件里把 old_string 替换为 new_string。' +
    '默认要求 old_string 在文件中唯一（出现多次报错；除非 replace_all=true）。' +
    '编辑前建议先用 Read 读到准确上下文，避免不唯一/误匹配。',
  inputSchema: EditArgsZ,
  inputJsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string', minLength: 1, description: '要被替换的原文（必须存在）' },
      new_string: { type: 'string', description: '替换后的文本' },
      replace_all: { type: 'boolean', description: '替换所有出现；默认 false（要求唯一）' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  invoke: async (args, _ctx) => {
    const p = resolvePath(args.path)
    const raw = readFileSync(p, 'utf8')
    const occurrences = raw.split(args.old_string).length - 1
    if (occurrences === 0) {
      throw new Error(`old_string not found in ${args.path}`)
    }
    if (occurrences > 1 && !args.replace_all) {
      throw new Error(
        `old_string occurs ${occurrences} times in ${args.path} — provide more context or set replace_all=true`,
      )
    }
    const next = args.replace_all
      ? raw.split(args.old_string).join(args.new_string)
      : raw.replace(args.old_string, args.new_string)
    writeFileSync(p, next, 'utf8')
    log.info('Edit', { path: p, replaced: args.replace_all ? occurrences : 1 })
    return { path: p, replaced: args.replace_all ? occurrences : 1 }
  },
}

// ── Glob ───────────────────────────────────────────────────────
const GlobArgsZ = z.object({
  pattern: z.string().min(1),
  cwd: z.string().optional(),
})
type GlobArgs = z.infer<typeof GlobArgsZ>

export const globTool: ToolDef<GlobArgs, { matches: string[]; count: number; truncated: boolean }> =
  {
    name: 'Glob',
    kind: 'standard',
    description:
      '按 glob 模式列文件路径（如 "**/*.ts"）。cwd 默认 server cwd。返回相对路径，最多 1000 条。',
    inputSchema: GlobArgsZ,
    inputJsonSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '例如 "**/*.java"、"src/**/*.ts"' },
        cwd: { type: 'string', description: '搜索根目录（绝对或相对路径），默认 server cwd' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    invoke: async (args, _ctx) => {
      const base = args.cwd ? resolvePath(args.cwd) : process.cwd()
      const glob = new Glob(args.pattern)
      const out: string[] = []
      const MAX = 1000
      for await (const file of glob.scan({ cwd: base, onlyFiles: true })) {
        out.push(file)
        if (out.length >= MAX) break
      }
      const truncated = out.length === MAX
      log.debug('Glob', { pattern: args.pattern, base, count: out.length, truncated })
      return { matches: out, count: out.length, truncated }
    },
  }

// ── Grep ───────────────────────────────────────────────────────
const GrepArgsZ = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  case_insensitive: z.boolean().optional(),
  max_results: z.number().int().positive().optional(),
})
type GrepArgs = z.infer<typeof GrepArgsZ>

interface GrepHit {
  path: string
  line: number
  text: string
}

export const grepTool: ToolDef<GrepArgs, { hits: GrepHit[]; count: number; truncated: boolean }> = {
  name: 'Grep',
  kind: 'standard',
  description: '按正则在文件内容里搜（JS 正则语法）。可选 path 限定根目录，glob 过滤文件。',
  inputSchema: GrepArgsZ,
  inputJsonSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JS 正则字符串' },
      path: { type: 'string', description: '搜索根，默认 server cwd' },
      glob: { type: 'string', description: '文件过滤 glob，默认 "**/*"' },
      case_insensitive: { type: 'boolean' },
      max_results: { type: 'integer', minimum: 1, description: '默认 200' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  invoke: async (args, _ctx) => {
    const base = args.path ? resolvePath(args.path) : process.cwd()
    const flags = args.case_insensitive ? 'i' : ''
    const re = new RegExp(args.pattern, flags)
    const max = args.max_results ?? 200
    const glob = new Glob(args.glob ?? '**/*')
    const hits: GrepHit[] = []
    for await (const file of glob.scan({ cwd: base, onlyFiles: true })) {
      const abs = resolve(base, file)
      try {
        const st = statSync(abs)
        if (!st.isFile() || st.size > 1_000_000) continue // 跳过 >1MB
        const content = readFileSync(abs, 'utf8')
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            hits.push({ path: file, line: i + 1, text: lines[i]!.slice(0, 500) })
            if (hits.length >= max) break
          }
        }
      } catch {
        /* 二进制文件 / 权限错误 等忽略 */
      }
      if (hits.length >= max) break
    }
    log.debug('Grep', { pattern: args.pattern, base, hits: hits.length })
    return { hits, count: hits.length, truncated: hits.length >= max }
  },
}

// ── Bash ───────────────────────────────────────────────────────
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
  description:
    'shell 命令（zsh -lc）。等同于在用户终端运行：可读写任意文件、安装软件（brew/npm/pip）、git、curl 等。' +
    '默认 120s 超时，最大 600s；stdout/stderr 各上限 50000 字符。' +
    '⚠️ 不要执行交互式命令（git rebase -i / vim / ssh tty 等）。',
  inputSchema: BashArgsZ,
  // bash 给一个较长的总超时（命令本身有 timeout_ms）
  timeoutMs: 600_000,
  inputJsonSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令（zsh -lc 解析）' },
      cwd: { type: 'string', description: '工作目录（绝对或相对路径），默认 server cwd' },
      timeout_ms: { type: 'integer', minimum: 1, maximum: 600000, description: '默认 120000' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  invoke: async (args, ctx) => {
    const cwd = args.cwd ? resolvePath(args.cwd) : process.cwd()
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

export const FILE_TOOLS: ToolDef[] = [
  readTool as ToolDef,
  writeTool as ToolDef,
  editTool as ToolDef,
  globTool as ToolDef,
  grepTool as ToolDef,
  bashTool as ToolDef,
]

export const FILE_TOOL_NAMES = FILE_TOOLS.map((t) => t.name)
