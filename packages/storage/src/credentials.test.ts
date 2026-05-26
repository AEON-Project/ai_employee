import { describe, test, expect, beforeEach } from 'bun:test'
import {
  CredentialsRepo,
  InMemoryKeychainStore,
  closeDatabase,
  migrate,
  openDatabase,
} from './index.js'

function setup() {
  const { db, sqlite } = openDatabase({ path: ':memory:' })
  migrate(sqlite)
  const keychain = new InMemoryKeychainStore()
  const repo = new CredentialsRepo(db, keychain)
  return { db, sqlite, keychain, repo }
}

describe('CredentialsRepo', () => {
  let env: ReturnType<typeof setup>
  beforeEach(() => {
    env = setup()
  })

  test('create + readSecret round-trip', async () => {
    const { repo } = env
    const { id, keychainKey } = await repo.create({
      kind: 'llm_key',
      secret: 'sk-ant-XXX',
      label: 'Claude',
    })
    expect(keychainKey).toStartWith('llm_key-')
    const secret = await repo.readSecret(id)
    expect(secret).toBe('sk-ant-XXX')
  })

  test('DB 表只存 keychainKey 不存 secret', async () => {
    const { repo, sqlite } = env
    await repo.create({ kind: 'tg_bot', secret: 'TOKEN_TG' })

    const rows = sqlite.query('SELECT * FROM credential_refs').all() as Array<
      Record<string, unknown>
    >
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    const serialized = JSON.stringify(row)
    expect(serialized).not.toContain('TOKEN_TG')
    expect(row.keychain_key).toStartWith('tg_bot-')
  })

  test('updateSecret 不改 id/keychainKey', async () => {
    const { repo } = env
    const { id, keychainKey } = await repo.create({ kind: 'embedding_key', secret: 'v1' })
    await repo.updateSecret(id, 'v2')
    const stored = await repo.readSecretByKey(keychainKey)
    expect(stored).toBe('v2')
    const row = repo.findById(id)
    expect(row?.keychainKey).toBe(keychainKey)
  })

  test('delete 同时清 keychain 和 DB', async () => {
    const { repo, keychain } = env
    const { id, keychainKey } = await repo.create({ kind: 'localhost_token', secret: 'TOK' })
    await repo.delete(id)
    expect(repo.findById(id)).toBeNull()
    expect(await keychain.get(keychainKey)).toBeNull()
  })

  test('findByKind 过滤', async () => {
    const { repo } = env
    await repo.create({ kind: 'llm_key', secret: 'a', label: 'Anth' })
    await repo.create({ kind: 'llm_key', secret: 'b', label: 'OAI' })
    await repo.create({ kind: 'tg_bot', secret: 'c' })
    const llm = repo.findByKind('llm_key')
    expect(llm).toHaveLength(2)
    expect(llm.map((r) => r.label).sort()).toEqual(['Anth', 'OAI'])
  })

  test('不存在的 id 返回 null / false', async () => {
    const { repo } = env
    expect(await repo.readSecret('missing')).toBeNull()
    expect(await repo.delete('missing')).toBe(false)
    expect(await repo.updateSecret('missing', 'x')).toBe(false)
  })
})

describe('InMemoryKeychainStore', () => {
  test('set / get / remove 基本流程', async () => {
    const k = new InMemoryKeychainStore()
    expect(await k.get('a')).toBeNull()
    await k.set('a', 'v1')
    expect(await k.get('a')).toBe('v1')
    await k.set('a', 'v2')
    expect(await k.get('a')).toBe('v2')
    expect(await k.remove('a')).toBe(true)
    expect(await k.get('a')).toBeNull()
    expect(await k.remove('a')).toBe(false)
  })
})
