import { describe, expect, test } from 'bun:test'
import { MessageStreamer } from './throttle.js'

interface IO {
  log: { kind: 'send' | 'edit'; mid?: number; text: string }[]
}

function mkIO(): IO & {
  send: (t: string) => Promise<number>
  edit: (mid: number, t: string) => Promise<void>
} {
  const log: IO['log'] = []
  let nextId = 100
  return {
    log,
    async send(t) {
      const id = nextId++
      log.push({ kind: 'send', mid: id, text: t })
      return id
    },
    async edit(mid, t) {
      log.push({ kind: 'edit', mid, text: t })
    },
  }
}

describe('MessageStreamer', () => {
  test('append + flush → 一次 send', async () => {
    const io = mkIO()
    const s = new MessageStreamer(io, { editIntervalMs: 100, prefix: '💭 ' })
    s.append('hello ')
    s.append('world')
    await s.flush()
    expect(io.log).toHaveLength(1)
    expect(io.log[0]).toMatchObject({ kind: 'send', text: '💭 \nhello world' })
  })

  test('再次 append + flush → edit 已有 message', async () => {
    const io = mkIO()
    const s = new MessageStreamer(io, { editIntervalMs: 50, prefix: '💭 ' })
    s.append('A')
    await s.flush()
    s.append('B')
    await s.flush()
    expect(io.log[0]?.kind).toBe('send')
    expect(io.log[1]?.kind).toBe('edit')
    expect(io.log[1]?.text).toContain('AB')
  })

  test('超 maxChars 滚新消息', async () => {
    const io = mkIO()
    const s = new MessageStreamer(io, { editIntervalMs: 10, maxChars: 5, prefix: '' })
    s.append('hi')
    await s.flush()
    s.append('long_text_exceeds')
    await s.flush()
    const sends = io.log.filter((l) => l.kind === 'send')
    expect(sends.length).toBe(2)
  })

  test('reset 后下一条 append 开新 message', async () => {
    const io = mkIO()
    const s = new MessageStreamer(io, { editIntervalMs: 10, prefix: '' })
    s.append('first')
    await s.flush()
    await s.reset()
    s.append('second')
    await s.flush()
    const sends = io.log.filter((l) => l.kind === 'send')
    expect(sends.length).toBe(2)
  })
})
