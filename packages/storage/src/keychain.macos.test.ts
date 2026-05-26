/**
 * 真实 macOS keychain 烟测。
 * 通过环境变量 `AIEMP_TEST_MACOS_KEYCHAIN=1` 开启；CI/非 macOS 默认 skip。
 */
import { describe, test, expect } from 'bun:test'
import { createKeychainStore } from './keychain.js'

const enabled = process.platform === 'darwin' && process.env.AIEMP_TEST_MACOS_KEYCHAIN === '1'

describe.if(enabled)('macOS Keychain 真实读写', () => {
  test('set / get / remove round-trip', async () => {
    const k = createKeychainStore({ impl: 'macos' })
    const key = `_aiemp_test_${crypto.randomUUID()}`
    try {
      expect(await k.get(key)).toBeNull()
      await k.set(key, 'secret-v1')
      expect(await k.get(key)).toBe('secret-v1')
      await k.set(key, 'secret-v2')
      expect(await k.get(key)).toBe('secret-v2')
    } finally {
      await k.remove(key)
    }
    expect(await k.get(key)).toBeNull()
  })
})

describe.if(!enabled)('macOS Keychain 真实读写（已跳过）', () => {
  test('skipped — set AIEMP_TEST_MACOS_KEYCHAIN=1 on macOS to enable', () => {
    expect(true).toBe(true)
  })
})
