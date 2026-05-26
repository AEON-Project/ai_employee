import { describe, expect, test } from 'bun:test'
import { matchReqIdPrefix, parseUpdate } from './router.js'

describe('parseUpdate', () => {
  test('/help', () => {
    expect(parseUpdate('/help').kind).toBe('help')
  })

  test('/new <emp> <description>', () => {
    const r = parseUpdate('/new 小李 写一个落地页\n要求 800 字')
    expect(r.kind).toBe('new')
    if (r.kind === 'new') {
      expect(r.employeeName).toBe('小李')
      expect(r.description).toContain('落地页')
    }
  })

  test('/list', () => {
    expect(parseUpdate('/list').kind).toBe('list')
  })

  test('/req prefix', () => {
    const r = parseUpdate('/req abc12345')
    expect(r).toEqual({ kind: 'req', reqIdPrefix: 'abc12345' })
  })

  test('回复 bot 消息（非命令文本 + replyTo）→ answer', () => {
    const r = parseUpdate('开发者', 42)
    expect(r).toEqual({ kind: 'answer', replyToMsgId: 42, answer: '开发者' })
  })

  test('命令开头 + replyTo → 仍解析为命令', () => {
    expect(parseUpdate('/list', 42).kind).toBe('list')
  })

  test('未知文本（无 reply）→ unknown', () => {
    expect(parseUpdate('hi').kind).toBe('unknown')
  })

  test('/approve /reject /pause /resume /cancel /who', () => {
    expect(parseUpdate('/approve abc1').kind).toBe('approve')
    expect(parseUpdate('/reject abc1').kind).toBe('reject')
    expect(parseUpdate('/pause abc1').kind).toBe('pause')
    expect(parseUpdate('/resume abc1').kind).toBe('resume')
    expect(parseUpdate('/cancel abc1').kind).toBe('cancel')
    expect(parseUpdate('/who').kind).toBe('who')
  })
})

describe('matchReqIdPrefix', () => {
  const all = ['abc12345-1111-aaaa', 'abc99999-2222-bbbb', 'def00000-3333-cccc']

  test('唯一前缀命中', () => {
    expect(matchReqIdPrefix('def00', all)).toEqual({ reqId: 'def00000-3333-cccc' })
  })

  test('歧义前缀报错', () => {
    const r = matchReqIdPrefix('abc', all)
    expect('error' in r).toBe(true)
  })

  test('过短前缀报错', () => {
    const r = matchReqIdPrefix('ab', all)
    expect('error' in r).toBe(true)
  })

  test('未匹配报错', () => {
    const r = matchReqIdPrefix('zzzz', all)
    expect('error' in r).toBe(true)
  })
})
