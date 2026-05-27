/**
 * CLI 启动期构造 RuntimeServices（连 DB / keychain / 工具注册）。
 */

import type { Database } from 'bun:sqlite'
import { TypedEventBus, type EventMap } from '@ai-emp/events'
import {
  CredentialsRepo,
  closeDatabase,
  createKeychainStore,
  createRepos,
  migrate,
  openDatabase,
} from '@ai-emp/storage'
import { createLLMClient } from '@ai-emp/llm'
import {
  ToolExecutor,
  registerSystemTools,
  registerFileTools,
  registry as toolsRegistry,
  SYSTEM_TOOL_NAMES,
  FILE_TOOL_NAMES,
} from '@ai-emp/tools'
import type { RuntimeServices, LLMFactory } from '@ai-emp/core/runtime'
import { McpManager } from '@ai-emp/mcp-client'
import { dataDir, dbPath, loadMcpConfig } from './config.js'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

export interface BootResult {
  services: RuntimeServices
  bus: TypedEventBus<EventMap>
  /** 底层 sqlite handle，供 seed/maintenance 等命令做 raw SQL 操作 */
  sqlite: Database
  /** V2 O6: MCP 进程管理器；进程退出时调 closeAll */
  mcp: McpManager
  close: () => void
}

export async function bootServices(): Promise<BootResult> {
  const { db, sqlite } = openDatabase({ path: dbPath() })
  migrate(sqlite)
  const repos = createRepos(db)
  const keychain = createKeychainStore()
  const credentials = new CredentialsRepo(db, keychain)
  const bus = new TypedEventBus<EventMap>()

  registerSystemTools()
  registerFileTools()

  // V2 O6: MCP servers — 读 dataDir/mcp.json 启动 → 注册 tool（fqn: mcp_<server>_<tool>）
  // 失败不阻断主流程（warn 后续工单照样跑，只是没这些工具）
  const mcp = new McpManager()
  let mcpToolNames: string[] = []
  const mcpCfg = loadMcpConfig()
  if (mcpCfg.servers.length > 0) {
    try {
      const ok = await mcp.connectAll(
        mcpCfg.servers.map((s) => ({
          name: s.name,
          command: s.command,
          args: s.args ?? [],
          env: s.env,
          startupTimeoutMs: s.startupTimeoutMs,
        })),
      )
      console.log(`  MCP servers 就绪 (${ok.length}/${mcpCfg.servers.length}): ${ok.join(', ')}`)
      const { z } = await import('zod')
      for (const mcpTool of mcp.listAllTools()) {
        // MCP tool 的 schema 校验由 MCP server 自己做；这里用 z.unknown() pass-through
        toolsRegistry.register({
          name: mcpTool.fqn,
          kind: 'standard',
          description: `[MCP] ${mcpTool.description}`,
          inputSchema: z.unknown(),
          inputJsonSchema: mcpTool.inputSchema,
          async invoke(args: unknown) {
            const r = await mcp.callByFqn(mcpTool.fqn, args)
            if (r.isError) {
              const errText =
                r.content.find((c) => c.type === 'text')?.text ?? 'mcp tool error (no text content)'
              throw new Error(errText)
            }
            return r.content
          },
        })
        mcpToolNames.push(mcpTool.fqn)
      }
    } catch (err) {
      console.warn(`  MCP boot 失败: ${String(err)}`)
    }
  }

  const executor = new ToolExecutor(toolsRegistry)

  const llmFactory: LLMFactory = {
    create(opts) {
      return createLLMClient({ ...opts, keyRef: opts.apiKey })
    },
  }

  const services: RuntimeServices = {
    repos,
    credentials,
    bus,
    llm: llmFactory,
    toolRegistry: {
      get: (n) =>
        toolsRegistry.get(n) as unknown as RuntimeServices['toolRegistry'] extends infer R
          ? R extends { get(n: string): infer X }
            ? X
            : never
          : never,
      listFor: (granted) =>
        toolsRegistry.listFor(granted) as unknown as ReturnType<
          RuntimeServices['toolRegistry']['listFor']
        >,
    },
    toolExecutor: {
      async invoke(call, ctx, opts) {
        const r = await executor.invoke(call, ctx, opts)
        return r as ReturnType<RuntimeServices['toolExecutor']['invoke']> extends Promise<infer X>
          ? X
          : never
      },
    },
    // V1.1: 所有 file/shell tool 默认对全部员工授权
    // V2 O6: MCP tool 也默认对所有员工授权（单用户场景）
    standardToolNames: [...FILE_TOOL_NAMES, ...mcpToolNames],
    // V2 O4: checkpoint 存放根目录（首次 boot 时创建）
    checkpointsDir: (() => {
      const dir = join(dataDir(), 'checkpoints')
      try {
        mkdirSync(dir, { recursive: true })
      } catch {
        // ignore — 由 checkpoint service 自己处理失败
      }
      return dir
    })(),
    toolJsonSchema: (name) => {
      const def = toolsRegistry.get(name)
      if (!def) return undefined
      // 优先取 ToolDef.inputJsonSchema（系统级 tool 必填）；普通 tool 缺省时退化为通用 object
      if (def.inputJsonSchema) {
        return { ...def.inputJsonSchema, description: def.description }
      }
      return {
        type: 'object',
        properties: {},
        additionalProperties: true,
        description: def.description,
      }
    },
  }

  return {
    services,
    bus,
    sqlite,
    mcp,
    close: () => closeDatabase(sqlite),
  }
}

export { SYSTEM_TOOL_NAMES }
