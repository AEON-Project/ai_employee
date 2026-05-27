/**
 * @ai-emp/tools — Tool 注册表 + Executor + 内置系统工具。
 */

export * from './types.js'
export * from './registry.js'
export * from './executor.js'
export * from './builtin.js'
export * from './file-tools.js'

import { registry } from './registry.js'
import { SYSTEM_TOOLS } from './builtin.js'
import { FILE_TOOLS } from './file-tools.js'

/**
 * 一次性把全部内置系统级工具注册到全局 registry。
 * 进程启动时调用一次；重复调用不会重复注册（registry.has 检测）。
 */
export function registerSystemTools(): void {
  for (const t of SYSTEM_TOOLS) {
    if (!registry.has(t.name)) registry.register(t)
  }
}

/**
 * V1.1: 注册 file/shell tool 集（Read / Write / Edit / Glob / Grep / Bash）。
 * 默认对所有员工"可发现"——是否真能调用由 employee.workdir 是否配置决定（无 workdir 则 tool invoke 抛错）。
 */
export function registerFileTools(): void {
  for (const t of FILE_TOOLS) {
    if (!registry.has(t.name)) registry.register(t)
  }
}
