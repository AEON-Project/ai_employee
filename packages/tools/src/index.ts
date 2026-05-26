/**
 * @ai-emp/tools — Tool 注册表 + Executor + 内置系统工具。
 */

export * from './types.js'
export * from './registry.js'
export * from './executor.js'
export * from './builtin.js'

import { registry } from './registry.js'
import { SYSTEM_TOOLS } from './builtin.js'

/**
 * 一次性把全部内置系统级工具注册到全局 registry。
 * 进程启动时调用一次；重复调用不会重复注册（registry.has 检测）。
 */
export function registerSystemTools(): void {
  for (const t of SYSTEM_TOOLS) {
    if (!registry.has(t.name)) registry.register(t)
  }
}
