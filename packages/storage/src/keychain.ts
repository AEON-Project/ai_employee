/**
 * Keychain 凭证抽象 — 跨平台 OS keychain 封装。
 *
 * 不依赖 native binding（避免类似 sharp 的 Bun/Rosetta 兼容坑）：
 *   - macOS: 调 /usr/bin/security CLI
 *   - Linux: 调 secret-tool（libsecret）
 *   - Windows: TODO（β 阶段补，先抛 not implemented）
 *
 * 服务名固定为 'ai-emp'；keychainKey 作为 account。
 * DB 的 credential_refs 表只存 keychainKey 引用，secret 永不落库。
 */

import { $ } from 'bun'

const SERVICE = 'ai-emp'

export interface KeychainStore {
  /** 写入；存在则覆盖 */
  set(key: string, value: string): Promise<void>
  /** 读取；不存在返回 null */
  get(key: string): Promise<string | null>
  /** 删除；不存在返回 false */
  remove(key: string): Promise<boolean>
}

// ──────────────────────────────────────────────────────────────
// macOS：security
// ──────────────────────────────────────────────────────────────
class MacOSKeychainStore implements KeychainStore {
  async set(key: string, value: string): Promise<void> {
    // -U 表示存在则更新；-w stdin 不显式
    await $`security add-generic-password -U -a ${key} -s ${SERVICE} -w ${value}`.quiet()
  }

  async get(key: string): Promise<string | null> {
    const r = await $`security find-generic-password -a ${key} -s ${SERVICE} -w`.quiet().nothrow()
    if (r.exitCode !== 0) return null
    return r.stdout.toString('utf8').trimEnd()
  }

  async remove(key: string): Promise<boolean> {
    const r = await $`security delete-generic-password -a ${key} -s ${SERVICE}`.quiet().nothrow()
    return r.exitCode === 0
  }
}

// ──────────────────────────────────────────────────────────────
// Linux：secret-tool
// ──────────────────────────────────────────────────────────────
class LinuxKeychainStore implements KeychainStore {
  async set(key: string, value: string): Promise<void> {
    // secret-tool 从 stdin 读 secret
    await $`echo -n ${value} | secret-tool store --label='ai-emp' service ${SERVICE} account ${key}`.quiet()
  }

  async get(key: string): Promise<string | null> {
    const r = await $`secret-tool lookup service ${SERVICE} account ${key}`.quiet().nothrow()
    if (r.exitCode !== 0) return null
    return r.stdout.toString('utf8').trimEnd()
  }

  async remove(key: string): Promise<boolean> {
    const r = await $`secret-tool clear service ${SERVICE} account ${key}`.quiet().nothrow()
    return r.exitCode === 0
  }
}

// ──────────────────────────────────────────────────────────────
// In-memory：测试用
// ──────────────────────────────────────────────────────────────
export class InMemoryKeychainStore implements KeychainStore {
  private data = new Map<string, string>()

  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value)
  }

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null
  }

  async remove(key: string): Promise<boolean> {
    return this.data.delete(key)
  }
}

// ──────────────────────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────────────────────
export function createKeychainStore(opts?: {
  /** 强制使用某个实现；不传按平台自动选择 */
  impl?: 'macos' | 'linux' | 'memory'
}): KeychainStore {
  const impl = opts?.impl ?? detectImpl()
  switch (impl) {
    case 'macos':
      return new MacOSKeychainStore()
    case 'linux':
      return new LinuxKeychainStore()
    case 'memory':
      return new InMemoryKeychainStore()
    default:
      throw new Error(`Unsupported keychain impl: ${impl}`)
  }
}

function detectImpl(): 'macos' | 'linux' | 'memory' {
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'linux') return 'linux'
  // Windows 暂不支持，fallback 走内存（仅开发，会有显著安全警告）
  // eslint-disable-next-line no-console
  console.warn('[keychain] Windows 暂未实现，使用 InMemoryKeychainStore（重启即丢失）')
  return 'memory'
}
