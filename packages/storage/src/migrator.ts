/**
 * 简易 migration runner。
 *
 * 规则：
 *   - migrations/ 下按文件名字典序列出 `NNNN_*.sql` 文件
 *   - 每个文件视为一个迁移，按文件名唯一 ID 记录到 schema_migrations 表
 *   - 失败抛错；已应用的不会重跑
 *
 * 不使用 drizzle-orm/bun-sqlite/migrator —— 后者要求 drizzle-kit 生成的 meta，
 * 我们手写 SQL（含 vec0 虚拟表）更可控。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Database } from 'bun:sqlite'

/** schema_migrations 元表，首次跑时建 */
const SCHEMA_MIGRATIONS = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id          TEXT PRIMARY KEY NOT NULL,
    applied_at  INTEGER NOT NULL
  );
`

export interface MigrateOptions {
  /** 绝对路径；不传则用 packages/storage/migrations */
  migrationsFolder?: string
  /** 干跑：列出待应用的迁移但不执行，返回结果 */
  dryRun?: boolean
}

export interface MigrateResult {
  applied: string[]
  skipped: string[]
}

export function migrate(sqlite: Database, opts: MigrateOptions = {}): MigrateResult {
  const folder = opts.migrationsFolder ?? defaultMigrationsFolder()
  sqlite.exec(SCHEMA_MIGRATIONS)

  const files = readdirSync(folder)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  const appliedStmt = sqlite.query('SELECT id FROM schema_migrations WHERE id = ?')
  const insertStmt = sqlite.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')

  const applied: string[] = []
  const skipped: string[] = []

  for (const file of files) {
    const existing = appliedStmt.get(file)
    if (existing) {
      skipped.push(file)
      continue
    }
    if (opts.dryRun) {
      applied.push(file)
      continue
    }
    const sql = readFileSync(join(folder, file), 'utf8')
    // bun:sqlite 的 exec 支持多语句
    sqlite.transaction(() => {
      sqlite.exec(sql)
      insertStmt.run(file, Date.now())
    })()
    applied.push(file)
  }

  return { applied, skipped }
}

function defaultMigrationsFolder(): string {
  // src/migrator.ts → ../migrations
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', 'migrations')
}
