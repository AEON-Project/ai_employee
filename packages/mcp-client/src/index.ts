/**
 * V2 O6 MCP client — Model Context Protocol stdio client（极简实现）。
 *
 * 协议参考：https://modelcontextprotocol.io
 * 我们只实现"启动 MCP server 子进程 → tools/list 拿工具 → tools/call 调用"路径，
 * 不实现 resources / prompts / sampling / notifications 等可选能力。
 *
 * 工具名约定：注册到 ToolRegistry 时用 `mcp_<serverName>_<toolName>` 防冲突。
 *
 * 限制：
 *   - stdio transport 一种（不支持 SSE/HTTP）
 *   - 同进程单 client 一对一；多 server 由 McpManager 管理多 client
 *   - 失败重启策略：暂无（die 就 die，启动时不接 = 这次工单没这些工具，不阻断）
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { getLogger } from '@ai-emp/domain'

const log = getLogger('mcp-client')

export interface McpServerConfig {
  /** 在 ToolRegistry 里作为前缀（mcp_<name>_<toolName>） */
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  /** 启动超时（毫秒），默认 15s */
  startupTimeoutMs?: number
}

export interface McpToolDef {
  /** MCP server 给的原始 tool name */
  toolName: string
  /** 我们注入到 ToolRegistry 时的全名 mcp_<server>_<toolName> */
  fqn: string
  description: string
  /** JSON Schema（mcp 规范要求 inputSchema 是对象） */
  inputSchema: Record<string, unknown>
}

export interface McpToolCallResult {
  isError: boolean
  /** mcp 规范 content 是 array of { type: 'text' | 'image' | ..., text?: string, ... } */
  content: Array<{ type: string; text?: string; [k: string]: unknown }>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

const DEFAULT_STARTUP_TIMEOUT = 15_000
const DEFAULT_REQUEST_TIMEOUT = 30_000

export class McpClient {
  private proc: ChildProcess | null = null
  private buf = ''
  private nextId = 1
  private pending = new Map<
    number,
    {
      resolve: (v: unknown) => void
      reject: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  /** 缓存的 tools/list 结果；首次调用 listTools 后填 */
  private toolsCache: McpToolDef[] | null = null

  constructor(public readonly config: McpServerConfig) {}

  async connect(): Promise<void> {
    if (this.proc) return
    log.info('connect.start', { name: this.config.name, command: this.config.command })
    const proc = spawn(this.config.command, this.config.args, {
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.proc = proc
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => this.onStdout(chunk))
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk) => {
      log.debug('stderr', { name: this.config.name, line: chunk.toString().trim().slice(0, 500) })
    })
    proc.on('exit', (code, signal) => {
      log.info('exit', { name: this.config.name, code, signal })
      // 失败所有 pending
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(`mcp server '${this.config.name}' exited (code=${code})`))
      }
      this.pending.clear()
      this.proc = null
    })
    proc.on('error', (err) => {
      log.warn('proc.error', { name: this.config.name, err: String(err) })
    })

    // MCP 规范：initialize 握手
    const timeoutMs = this.config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT
    try {
      await this.request(
        'initialize',
        {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          clientInfo: { name: 'ai-emp', version: '0.0.0' },
        },
        timeoutMs,
      )
      // 客户端 initialized notification（MCP 规范）
      this.notify('notifications/initialized', {})
      log.info('initialized', { name: this.config.name })
    } catch (err) {
      log.warn('initialize.fail', { name: this.config.name, err: String(err) })
      await this.close()
      throw err
    }
  }

  async listTools(): Promise<McpToolDef[]> {
    if (this.toolsCache) return this.toolsCache
    if (!this.proc) throw new Error('mcp client not connected')
    const r = (await this.request('tools/list', {})) as
      | { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> }
      | undefined
    const tools: McpToolDef[] = (r?.tools ?? []).map((t) => ({
      toolName: t.name,
      fqn: `mcp_${this.config.name}_${t.name}`,
      description: t.description ?? `MCP tool ${t.name}`,
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? {
        type: 'object',
        additionalProperties: true,
      },
    }))
    this.toolsCache = tools
    log.info('tools.listed', { name: this.config.name, count: tools.length })
    return tools
  }

  async callTool(toolName: string, args: unknown): Promise<McpToolCallResult> {
    if (!this.proc) throw new Error('mcp client not connected')
    const r = (await this.request('tools/call', { name: toolName, arguments: args })) as
      | {
          content?: Array<{ type: string; text?: string; [k: string]: unknown }>
          isError?: boolean
        }
      | undefined
    return {
      isError: r?.isError === true,
      content: r?.content ?? [],
    }
  }

  async close(): Promise<void> {
    if (!this.proc) return
    try {
      this.proc.kill('SIGTERM')
    } catch {
      // ignore
    }
    // 等待 exit
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1000)
      this.proc?.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
    })
    this.proc = null
  }

  // ── private ──────────────────────────────────────────────

  private onStdout(chunk: string): void {
    this.buf += chunk
    // Content-Length transport? MCP 用纯 NDJSON（每行一个 JSON）— 不是 LSP 风格的 framed
    let idx: number
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line) as JsonRpcResponse | { method?: string }
        this.handleMessage(msg)
      } catch (err) {
        log.warn('stdout.parse_fail', {
          name: this.config.name,
          line: line.slice(0, 200),
          err: String(err),
        })
      }
    }
  }

  private handleMessage(msg: JsonRpcResponse | { method?: string }): void {
    if ('method' in msg && msg.method) {
      // server-initiated notification / request — 我们不处理，丢弃
      return
    }
    const resp = msg as JsonRpcResponse
    if (typeof resp.id !== 'number') return
    const p = this.pending.get(resp.id)
    if (!p) return
    this.pending.delete(resp.id)
    clearTimeout(p.timer)
    if (resp.error) {
      p.reject(new Error(`mcp error ${resp.error.code}: ${resp.error.message}`))
    } else {
      p.resolve(resp.result)
    }
  }

  private writeMessage(msg: Record<string, unknown>): void {
    if (!this.proc?.stdin) throw new Error('mcp stdin not available')
    this.proc.stdin.write(JSON.stringify(msg) + '\n')
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT,
  ): Promise<unknown> {
    const id = this.nextId++
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`mcp request timeout (${method}, ${timeoutMs}ms)`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.writeMessage(req as unknown as Record<string, unknown>)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err as Error)
      }
    })
  }

  private notify(method: string, params: unknown): void {
    try {
      this.writeMessage({ jsonrpc: '2.0', method, params })
    } catch (err) {
      log.warn('notify.fail', { name: this.config.name, method, err: String(err) })
    }
  }
}

// ──────────────────────────────────────────────────────────────
// McpManager — 多 server 管理
// ──────────────────────────────────────────────────────────────

export class McpManager {
  private clients = new Map<string, McpClient>()
  /** fqn → { client, toolName } */
  private toolIndex = new Map<string, { client: McpClient; toolName: string; def: McpToolDef }>()

  /**
   * 并发连接所有 server；任一失败不阻断其他成功的（warn 不抛）。
   * 返回成功连接的 server 名列表。
   */
  async connectAll(configs: McpServerConfig[]): Promise<string[]> {
    const succeeded: string[] = []
    const tasks = configs.map(async (cfg) => {
      const client = new McpClient(cfg)
      try {
        await client.connect()
        const tools = await client.listTools()
        for (const t of tools) {
          this.toolIndex.set(t.fqn, { client, toolName: t.toolName, def: t })
        }
        this.clients.set(cfg.name, client)
        succeeded.push(cfg.name)
        log.info('manager.connected', { name: cfg.name, tools: tools.length })
      } catch (err) {
        log.warn('manager.connect_fail', { name: cfg.name, err: String(err) })
      }
    })
    await Promise.all(tasks)
    return succeeded
  }

  /** 列出所有已连接 server 的工具 */
  listAllTools(): McpToolDef[] {
    return Array.from(this.toolIndex.values()).map((v) => v.def)
  }

  /** 通过 fqn (mcp_<server>_<tool>) 调用 */
  async callByFqn(fqn: string, args: unknown): Promise<McpToolCallResult> {
    const entry = this.toolIndex.get(fqn)
    if (!entry) throw new Error(`mcp tool not found: ${fqn}`)
    return entry.client.callTool(entry.toolName, args)
  }

  async closeAll(): Promise<void> {
    await Promise.all(Array.from(this.clients.values()).map((c) => c.close()))
    this.clients.clear()
    this.toolIndex.clear()
  }
}
