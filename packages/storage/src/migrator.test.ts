import { describe, test, expect } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDatabase, closeDatabase, migrate, schema } from './index.js'

const EXPECTED_TABLES = [
  'projects',
  'employees',
  'skills',
  'employee_skills',
  'requirements',
  'threads',
  'messages',
  'clarifications',
  'reports',
  'conventions',
  'memory_items',
  'runtime_state',
  'tools',
  'tool_grants',
  'credential_refs',
  'tg_message_links',
  'chunks',
  'vec_chunks', // 虚拟表
  'schema_migrations',
]

describe('migrate()', () => {
  test('初次跑创建全部表 + 元表，二次跑全部跳过', () => {
    const { db, sqlite } = openDatabase({ path: ':memory:' })
    try {
      const r1 = migrate(sqlite)
      expect(r1.applied).toEqual([
        '0000_init.sql',
        '0001_vec.sql',
        '0002_project_workdir.sql',
        '0003_requirement_parent.sql',
      ])
      expect(r1.skipped).toEqual([])

      const tables = sqlite
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name`,
        )
        .all()
        .map((r) => r.name)
      for (const t of EXPECTED_TABLES) {
        expect(tables).toContain(t)
      }

      const r2 = migrate(sqlite)
      expect(r2.applied).toEqual([])
      expect(r2.skipped).toEqual([
        '0000_init.sql',
        '0001_vec.sql',
        '0002_project_workdir.sql',
        '0003_requirement_parent.sql',
      ])

      // 验证 drizzle 实例已绑定 schema：能 insert/select projects
      const now = Date.now()
      db.insert(schema.projects)
        .values({
          id: 'p1',
          name: '测试项目',
          description: '',
          createdAt: new Date(now),
        })
        .run()
      const rows = db.select().from(schema.projects).where(eq(schema.projects.id, 'p1')).all()
      expect(rows[0]?.name).toBe('测试项目')
    } finally {
      closeDatabase(sqlite)
    }
  })

  test('vec_chunks 可插入 + KNN 查询', () => {
    const { sqlite } = openDatabase({ path: ':memory:' })
    try {
      migrate(sqlite)

      sqlite.exec(`CREATE TABLE IF NOT EXISTS __t (id text); INSERT INTO __t VALUES ('test')`)

      const insert = sqlite.prepare(
        `INSERT INTO vec_chunks(rowid, embedding, chunk_id) VALUES (?, ?, ?)`,
      )
      function randVec(seed: number): Float32Array {
        const a = new Float32Array(512)
        let s = seed
        for (let i = 0; i < 512; i++) {
          s = (s * 9301 + 49297) % 233280
          a[i] = (s / 233280) * 2 - 1
        }
        return a
      }
      for (let i = 1; i <= 100; i++) {
        insert.run(i, randVec(i), `c${i}`)
      }

      const rows = sqlite
        .prepare<
          { chunk_id: string; distance: number },
          [Float32Array]
        >(`SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? AND k = 5 ORDER BY distance`)
        .all(randVec(42))
      expect(rows).toHaveLength(5)
      // 最近邻必是种子相同的 c42（距离 0）
      expect(rows[0]?.chunk_id).toBe('c42')
      expect(rows[0]?.distance).toBeCloseTo(0, 4)
    } finally {
      closeDatabase(sqlite)
    }
  })

  test('PRAGMA 已应用（WAL / foreign_keys）', () => {
    const { sqlite } = openDatabase({ path: ':memory:' })
    try {
      // :memory: DB 不会真正进入 WAL，但 foreign_keys 必须开
      const fk = sqlite.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()
      expect(fk?.foreign_keys).toBe(1)
    } finally {
      closeDatabase(sqlite)
    }
  })

  test('级联删除：删项目 → 关联 requirement / thread / message 全清', () => {
    const { db, sqlite } = openDatabase({ path: ':memory:' })
    try {
      migrate(sqlite)
      const now = new Date()

      db.insert(schema.projects)
        .values({ id: 'p1', name: 'P1', description: '', createdAt: now })
        .run()
      db.insert(schema.requirements)
        .values({
          id: 'r1',
          title: 'T1',
          description: '',
          projectId: 'p1',
          status: '待分派',
          budgetCapJson: { maxIterations: 30, maxTokens: 200000, maxWallTimeMs: 1800000 },
          createdAt: now,
        })
        .run()
      db.insert(schema.threads).values({ id: 't1', requirementId: 'r1', createdAt: now }).run()
      db.insert(schema.messages)
        .values({
          id: 'm1',
          threadId: 't1',
          seq: 0,
          role: 'user',
          type: 'text',
          contentJson: { type: 'text', text: 'hi' },
          createdAt: now,
        })
        .run()

      db.delete(schema.projects).where(eq(schema.projects.id, 'p1')).run()

      const reqCount = db.select().from(schema.requirements).all().length
      const threadCount = db.select().from(schema.threads).all().length
      const msgCount = db.select().from(schema.messages).all().length
      expect(reqCount).toBe(0)
      expect(threadCount).toBe(0)
      expect(msgCount).toBe(0)
    } finally {
      closeDatabase(sqlite)
    }
  })
})
