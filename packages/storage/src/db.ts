/**
 * SQLite 连接 + sqlite-vec 扩展加载 + PRAGMA 初始化。
 *
 * 关键决策（来自 Spike 1）：
 *   Bun 内置 SQLite 编译时关掉了 enable_load_extension，
 *   必须 setCustomSQLite() 切换到 brew/系统 sqlite（含 loadExtension 能力）。
 */

import { Database } from 'bun:sqlite'
import * as sqliteVec from 'sqlite-vec'
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { getLogger } from '@ai-emp/domain'
import * as schema from './schema.js'

export type DB = BunSQLiteDatabase<typeof schema>

const sqlLog = getLogger('storage.sql')

export interface OpenOptions {
  /** 数据库文件绝对路径；':memory:' 表示纯内存（仅测试） */
  path: string
  /** 自定义 sqlite 动态库路径；不传走平台默认探测 */
  customSqlitePath?: string
}

/** 探测 brew / 系统 sqlite 动态库；找不到返回 null（运行期会报错） */
export function detectSystemSqlite(): string | null {
  if (process.platform === 'darwin') {
    return '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'
  }
  if (process.platform === 'linux') {
    return '/usr/lib/x86_64-linux-gnu/libsqlite3.so.0'
  }
  return null
}

/** 一次性应用启动 PRAGMA（每个新连接都要跑） */
function applyStartupPragmas(sqlite: Database): void {
  sqlite.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
  `)
}

/** Bun 的 setCustomSQLite 进程内只能调一次；用模块级 flag 守卫 */
let customSqliteApplied = false

/**
 * 打开数据库连接、加载 sqlite-vec、应用 PRAGMA、绑定 drizzle schema。
 * 同一进程内调用多次会得到独立连接（测试用）；正式服务通常只打开一次。
 */
export function openDatabase(opts: OpenOptions): { db: DB; sqlite: Database } {
  if (!customSqliteApplied) {
    const customPath = opts.customSqlitePath ?? detectSystemSqlite()
    if (customPath) {
      Database.setCustomSQLite(customPath)
    }
    customSqliteApplied = true
  }

  const sqlite = new Database(opts.path)
  // 加载向量扩展；失败抛错，调用方负责处理
  sqliteVec.load(sqlite)
  applyStartupPragmas(sqlite)

  // SQL 日志：drizzle 内置 logger 接口；仅在 AIEMP_LOG_LEVEL=debug 时实际落盘
  // （logger 内部按级别过滤，这里始终启用 hook 性能开销可忽略）
  const db = drizzle(sqlite, {
    schema,
    logger: {
      logQuery: (query, params) => {
        sqlLog.debug('query', { sql: query, params })
      },
    },
  })
  return { db, sqlite }
}

/** 关闭连接 — drizzle 没有直接的 close，走底层 sqlite */
export function closeDatabase(sqlite: Database): void {
  sqlite.close()
}

export { schema }
