/**
 * ToolRegistry — 进程内 tool 注册表。
 *
 * - 系统级 tool（kind='system'）默认对所有 employee 可见
 * - 普通 tool 需要 employee.toolGrants 显式授权
 * - listFor(employeeGrantedNames) 输出"可见 + 已授权"的 tool 列表
 */

import type { ToolDef } from './types.js'

export class ToolRegistry {
  private tools = new Map<string, ToolDef>()

  register(def: ToolDef): void {
    if (this.tools.has(def.name)) {
      throw new Error(`Tool already registered: ${def.name}`)
    }
    this.tools.set(def.name, def)
  }

  /** 用于测试时替换实现 */
  override(def: ToolDef): void {
    this.tools.set(def.name, def)
  }

  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  /**
   * 给某员工列出可用 tool。
   * - 系统级永远列出
   * - 普通级仅当 name 在 grantedNames 内才列出
   */
  listFor(grantedNames: Iterable<string>): ToolDef[] {
    const granted = new Set(grantedNames)
    const out: ToolDef[] = []
    for (const t of this.tools.values()) {
      if (t.kind === 'system' || granted.has(t.name)) out.push(t)
    }
    return out
  }

  listAll(): ToolDef[] {
    return [...this.tools.values()]
  }

  clear(): void {
    this.tools.clear()
  }
}

/** 进程级全局 registry；测试中可 `registry.clear()` 后重新注册 */
export const registry = new ToolRegistry()
