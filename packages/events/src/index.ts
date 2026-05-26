/**
 * @ai-emp/events — 进程内类型化 EventBus。
 *
 * - `bus.emit(name, payload)` / `bus.on(name, fn)` 编译期受 EventMap 约束
 * - 跨进程边界（WS/HTTP/TG）用 `parsePayload`/`safeParsePayload` 做运行期校验
 * - 完整事件目录见 ARCHITECTURE §10
 */

import type { EventMap, EventName } from './event-map.js'

export type Listener<K extends EventName> = (payload: EventMap[K]) => void
export type Unsubscribe = () => void

// 用 PropertyKey 而非 string，避免 TS interface（无 index signature）触发 Record 约束错
export class TypedEventBus<Events extends { [K in keyof Events]: unknown }> {
  private listeners = new Map<keyof Events, Set<(p: unknown) => void>>()

  /** 同步广播给当前已注册的所有监听器；监听器抛错不影响其他监听器 */
  emit<K extends keyof Events>(name: K, payload: Events[K]): void {
    const set = this.listeners.get(name)
    if (!set || set.size === 0) return
    for (const fn of set) {
      try {
        fn(payload)
      } catch (err) {
        // 进程内事件总线不应该因为一个订阅者异常而中断；记 console 即可
        // eslint-disable-next-line no-console
        console.error(`[EventBus] listener error on "${String(name)}":`, err)
      }
    }
  }

  on<K extends keyof Events>(name: K, fn: (payload: Events[K]) => void): Unsubscribe {
    let set = this.listeners.get(name)
    if (!set) {
      set = new Set()
      this.listeners.set(name, set)
    }
    const wrapped = fn as (p: unknown) => void
    set.add(wrapped)
    return () => set!.delete(wrapped)
  }

  off<K extends keyof Events>(name: K, fn: (payload: Events[K]) => void): void {
    this.listeners.get(name)?.delete(fn as (p: unknown) => void)
  }

  /** 仅测试/调试用：清空所有监听器 */
  clear(): void {
    this.listeners.clear()
  }

  /** 仅测试/调试用：查询某事件的监听器数量 */
  listenerCount<K extends keyof Events>(name: K): number {
    return this.listeners.get(name)?.size ?? 0
  }
}

/** 全局单例 bus；测试中可 `bus.clear()` 后复用 */
export const bus: TypedEventBus<EventMap> = new TypedEventBus<EventMap>()

// 重新导出类型 & schema，方便订阅方一行 import
export type { EventMap, EventName } from './event-map.js'
export * from './types.js'
export { eventSchemas, parsePayload, safeParsePayload } from './schemas.js'
