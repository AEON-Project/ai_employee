import { describe, expect, test } from 'bun:test'
import { TypedEventBus, type EventMap } from '@ai-emp/events'
import {
  CredentialsRepo,
  InMemoryKeychainStore,
  createRepos,
  migrate,
  openDatabase,
} from '@ai-emp/storage'
import { DEFAULT_BUDGET_CAP } from '@ai-emp/domain'
import { isReplayOf, replayRequirement, REPLAY_TAG_PREFIX } from './replay.js'
import type { LLMFactory, RuntimeLLMChunk, RuntimeServices, RuntimeToolDef } from './services.js'

const passThroughSchema = {
  safeParse(v: unknown) {
    return { success: true, data: v }
  },
}
const mockTools: RuntimeToolDef[] = [
  { name: 'ask_user', kind: 'system', description: '', inputSchema: passThroughSchema },
  { name: 'advance_step', kind: 'system', description: '', inputSchema: passThroughSchema },
  { name: 'update_plan', kind: 'system', description: '', inputSchema: passThroughSchema },
  { name: 'emit_deliverable', kind: 'system', description: '', inputSchema: passThroughSchema },
]

function scriptedLLM(scripts: RuntimeLLMChunk[][]): LLMFactory {
  let turn = 0
  return {
    create: () => ({
      async *stream() {
        const c = scripts[turn++] ?? scripts[scripts.length - 1] ?? []
        for (const x of c) yield x
      },
      async complete() {
        return { text: '', toolCalls: [], stopReason: 'end_turn' }
      },
    }),
  }
}

describe('isReplayOf', () => {
  test('识别 replay tag', () => {
    expect(isReplayOf(`${REPLAY_TAG_PREFIX} of:abc123\n\n...`)).toBe('abc123')
  })
  test('普通需求返回 null', () => {
    expect(isReplayOf('普通的描述')).toBeNull()
  })
})

describe('replayRequirement', () => {
  test('创建副本 + 执行 + 不污染原需求', async () => {
    const { db, sqlite } = openDatabase({ path: ':memory:' })
    migrate(sqlite)
    const repos = createRepos(db)
    const keychain = new InMemoryKeychainStore()
    const credentials = new CredentialsRepo(db, keychain)
    const bus = new TypedEventBus<EventMap>()
    const services: RuntimeServices = {
      repos,
      credentials,
      bus,
      llm: scriptedLLM([
        [
          {
            type: 'tool_use_stop',
            id: 't1',
            name: 'emit_deliverable',
            args: { summary: 'ok', contentText: '新结果' },
          },
          { type: 'message_stop', reason: 'tool_use' },
        ],
      ]),
      toolRegistry: {
        get: (n) => mockTools.find((t) => t.name === n),
        listFor: () => mockTools,
      },
      toolExecutor: {
        async invoke() {
          return { ok: false, error: { kind: 'unknown_tool', message: '' } }
        },
      },
      toolJsonSchema: () => ({}),
    }

    const cred = await credentials.create({ kind: 'llm_key', secret: 'k' })
    const eid = repos.employees.create({
      name: 'e',
      role: 'r',
      modelProvider: 'anthropic',
      modelName: 'm',
      modelKeyRef: cred.keychainKey,
    })
    const origId = repos.requirements.create({
      title: '原需求',
      description: '原描述',
      assigneeId: eid,
      budgetCap: DEFAULT_BUDGET_CAP,
    })
    repos.requirements.setStatus(origId, '已完成', { completedAt: new Date() })

    const r = await replayRequirement(services, origId)
    expect(r.exit).toBe('delivered')
    expect(r.replayReqId).not.toBe(origId)

    const replay = repos.requirements.findById(r.replayReqId)!
    expect(replay.title).toStartWith(REPLAY_TAG_PREFIX)
    expect(isReplayOf(replay.description)).toBe(origId)

    // 原需求未变
    const orig = repos.requirements.findById(origId)!
    expect(orig.status).toBe('已完成')
    expect(orig.title).toBe('原需求')
  })

  test('未完成需求不可 replay', async () => {
    const { db, sqlite } = openDatabase({ path: ':memory:' })
    migrate(sqlite)
    const repos = createRepos(db)
    const services = {
      repos,
      credentials: new CredentialsRepo(db, new InMemoryKeychainStore()),
      bus: new TypedEventBus<EventMap>(),
      llm: scriptedLLM([]),
      toolRegistry: {
        get: () => undefined,
        listFor: () => [],
      },
      toolExecutor: {
        async invoke() {
          return { ok: false }
        },
      },
      toolJsonSchema: () => undefined,
    } as RuntimeServices
    const id = repos.requirements.create({
      title: 'T',
      description: 'D',
      budgetCap: DEFAULT_BUDGET_CAP,
    })
    await expect(replayRequirement(services, id)).rejects.toThrow()
  })
})
