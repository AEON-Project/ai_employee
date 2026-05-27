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
  registry as toolsRegistry,
  SYSTEM_TOOL_NAMES,
} from '@ai-emp/tools'
import type { RuntimeServices, LLMFactory } from '@ai-emp/core/runtime'
import { dbPath } from './config.js'

export interface BootResult {
  services: RuntimeServices
  bus: TypedEventBus<EventMap>
  /** 底层 sqlite handle，供 seed/maintenance 等命令做 raw SQL 操作 */
  sqlite: Database
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
    toolJsonSchema: (name) => {
      const def = toolsRegistry.get(name)
      if (!def) return undefined
      // Zod → JSON Schema 的桥简化为：暴露 description + 接受任意 object
      // 完整实现见后续 T1.3+；当前最小可工作版本
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
    close: () => closeDatabase(sqlite),
  }
}

export { SYSTEM_TOOL_NAMES }
