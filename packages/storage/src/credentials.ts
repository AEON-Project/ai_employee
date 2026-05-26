/**
 * Credentials repo — credential_refs 表 + Keychain 联动。
 *
 * 设计：
 *   - 业务层只看到 credentialRef.id（uuid）
 *   - 表里只存 keychainKey（"<kind>-<random>"）+ 元数据（kind/label/createdAt）
 *   - 真正的 secret 通过 KeychainStore 读写，绝不落表
 */

import { eq } from 'drizzle-orm'
import type { CredentialKind } from '@ai-emp/domain'
import { credentialRefs } from './schema.js'
import type { DB } from './db.js'
import type { KeychainStore } from './keychain.js'

export interface CredentialRecord {
  id: string
  kind: CredentialKind
  keychainKey: string
  label: string | null
  createdAt: Date
}

export class CredentialsRepo {
  constructor(
    private readonly db: DB,
    private readonly keychain: KeychainStore,
  ) {}

  /** 写入新凭证；返回 ref id */
  async create(input: {
    kind: CredentialKind
    secret: string
    label?: string
  }): Promise<{ id: string; keychainKey: string }> {
    const id = crypto.randomUUID()
    const keychainKey = `${input.kind}-${id}`
    await this.keychain.set(keychainKey, input.secret)
    this.db
      .insert(credentialRefs)
      .values({
        id,
        kind: input.kind,
        keychainKey,
        label: input.label ?? null,
        createdAt: new Date(),
      })
      .run()
    return { id, keychainKey }
  }

  /** 读 secret；ref 不存在或 keychain 缺失返回 null */
  async readSecret(id: string): Promise<string | null> {
    const row = this.findById(id)
    if (!row) return null
    return this.keychain.get(row.keychainKey)
  }

  /** 按 keychainKey 读 secret（runtime/cli 已知 key 时跳过 DB） */
  readSecretByKey(keychainKey: string): Promise<string | null> {
    return this.keychain.get(keychainKey)
  }

  findById(id: string): CredentialRecord | null {
    const rows = this.db.select().from(credentialRefs).where(eq(credentialRefs.id, id)).all()
    return rows[0] ?? null
  }

  findByKind(kind: CredentialKind): CredentialRecord[] {
    return this.db.select().from(credentialRefs).where(eq(credentialRefs.kind, kind)).all()
  }

  list(): CredentialRecord[] {
    return this.db.select().from(credentialRefs).all()
  }

  /** 更新 secret（不改 id/kind/keychainKey） */
  async updateSecret(id: string, secret: string): Promise<boolean> {
    const row = this.findById(id)
    if (!row) return false
    await this.keychain.set(row.keychainKey, secret)
    return true
  }

  /** 删除：先删 keychain 再删 ref */
  async delete(id: string): Promise<boolean> {
    const row = this.findById(id)
    if (!row) return false
    await this.keychain.remove(row.keychainKey)
    this.db.delete(credentialRefs).where(eq(credentialRefs.id, id)).run()
    return true
  }
}
