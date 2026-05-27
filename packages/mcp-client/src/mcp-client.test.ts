/**
 * V2 O6 MCP client 单测 — 启动一个 inline mock MCP server（subprocess）
 * 验证 initialize 握手 / tools/list / tools/call 全路径。
 *
 * Mock server 用 bun -e 跑一段内联 JS，从 stdin 读 NDJSON，按 method 回复。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { McpClient, McpManager } from './index.js'

let tmpRoot: string
let mockServerPath: string

function makeMockServer(behavior: 'echo' | 'error_on_init' | 'no_response'): string {
  if (!tmpRoot) tmpRoot = mkdtempSync(join(tmpdir(), 'ai-emp-mcp-'))
  mockServerPath = join(tmpRoot, `mock_${behavior}.mjs`)
  const code =
    behavior === 'no_response'
      ? `
// 不回任何消息（用来测 timeout）
process.stdin.resume()
`
      : behavior === 'error_on_init'
        ? `
process.stdin.setEncoding('utf8')
let buf = ''
process.stdin.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    const m = JSON.parse(line)
    if (m.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: m.id,
        error: { code: -32000, message: 'simulated init failure' }
      }) + '\\n')
    }
  }
})
`
        : `
process.stdin.setEncoding('utf8')
let buf = ''
process.stdin.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    const m = JSON.parse(line)
    if (m.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: m.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock', version: '0.0.1' }
        }
      }) + '\\n')
    } else if (m.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: m.id,
        result: {
          tools: [
            { name: 'echo', description: 'Echo back the input text',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
            { name: 'add', description: 'Add two numbers',
              inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } }
          ]
        }
      }) + '\\n')
    } else if (m.method === 'tools/call') {
      const args = m.params?.arguments ?? {}
      if (m.params?.name === 'echo') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: m.id,
          result: { isError: false, content: [{ type: 'text', text: 'echo:' + (args.text ?? '') }] }
        }) + '\\n')
      } else if (m.params?.name === 'add') {
        const sum = (args.a ?? 0) + (args.b ?? 0)
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: m.id,
          result: { isError: false, content: [{ type: 'text', text: 'sum=' + sum }] }
        }) + '\\n')
      } else {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: m.id,
          error: { code: -32601, message: 'tool not found' }
        }) + '\\n')
      }
    }
  }
})
`
  writeFileSync(mockServerPath, code)
  return mockServerPath
}

afterEach(async () => {
  if (tmpRoot) {
    try {
      rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      // ignore
    }
    tmpRoot = ''
  }
})

describe('McpClient', () => {
  test('echo server: connect + initialize + listTools + callTool', async () => {
    const serverPath = makeMockServer('echo')
    const client = new McpClient({
      name: 'mock',
      command: 'bun',
      args: [serverPath],
    })
    try {
      await client.connect()
      const tools = await client.listTools()
      expect(tools.length).toBe(2)
      expect(tools[0]!.toolName).toBe('echo')
      expect(tools[0]!.fqn).toBe('mcp_mock_echo')
      expect(tools[1]!.fqn).toBe('mcp_mock_add')

      const r1 = await client.callTool('echo', { text: 'hello' })
      expect(r1.isError).toBe(false)
      expect(r1.content[0]!.text).toBe('echo:hello')

      const r2 = await client.callTool('add', { a: 3, b: 4 })
      expect(r2.isError).toBe(false)
      expect(r2.content[0]!.text).toBe('sum=7')
    } finally {
      await client.close()
    }
  })

  test('server initialize 报错 → connect 抛错', async () => {
    const serverPath = makeMockServer('error_on_init')
    const client = new McpClient({
      name: 'bad',
      command: 'bun',
      args: [serverPath],
    })
    let err: Error | null = null
    try {
      await client.connect()
    } catch (e) {
      err = e as Error
    } finally {
      await client.close()
    }
    expect(err).not.toBeNull()
    expect(err!.message).toContain('simulated init failure')
  })

  test('server 不回响应 → request 超时', async () => {
    const serverPath = makeMockServer('no_response')
    const client = new McpClient({
      name: 'silent',
      command: 'bun',
      args: [serverPath],
      startupTimeoutMs: 800,
    })
    let err: Error | null = null
    try {
      await client.connect()
    } catch (e) {
      err = e as Error
    } finally {
      await client.close()
    }
    expect(err).not.toBeNull()
    expect(err!.message).toContain('timeout')
  })

  test('找不到命令 → 不抛但 stderr/error 事件', async () => {
    const client = new McpClient({
      name: 'noexec',
      command: '/no/such/executable',
      args: [],
      startupTimeoutMs: 800,
    })
    let err: Error | null = null
    try {
      await client.connect()
    } catch (e) {
      err = e as Error
    } finally {
      await client.close()
    }
    // spawn 找不到命令通常会触发 'error' 事件，request 超时或子进程立即 exit
    expect(err).not.toBeNull()
  })
})

describe('McpManager', () => {
  test('connectAll 串起多 server → listAllTools + callByFqn', async () => {
    const serverPath = makeMockServer('echo')
    const mgr = new McpManager()
    const succeeded = await mgr.connectAll([
      { name: 'a', command: 'bun', args: [serverPath] },
      { name: 'b', command: 'bun', args: [serverPath] },
    ])
    try {
      expect(succeeded.sort()).toEqual(['a', 'b'])
      const all = mgr.listAllTools()
      expect(all.length).toBe(4) // 2 server × 2 tools 各
      const fqns = all.map((t) => t.fqn).sort()
      expect(fqns).toContain('mcp_a_echo')
      expect(fqns).toContain('mcp_b_echo')

      const r = await mgr.callByFqn('mcp_a_echo', { text: 'world' })
      expect(r.content[0]!.text).toBe('echo:world')
    } finally {
      await mgr.closeAll()
    }
  })

  test('connectAll 部分失败不阻断其他', async () => {
    const serverPath = makeMockServer('echo')
    const mgr = new McpManager()
    const succeeded = await mgr.connectAll([
      { name: 'good', command: 'bun', args: [serverPath] },
      { name: 'bad', command: '/no/such/cmd', args: [], startupTimeoutMs: 500 },
    ])
    try {
      expect(succeeded).toEqual(['good'])
      const all = mgr.listAllTools()
      expect(all.every((t) => t.fqn.startsWith('mcp_good_'))).toBe(true)
    } finally {
      await mgr.closeAll()
    }
  })

  test('callByFqn 未知 fqn → 抛 not found', async () => {
    const mgr = new McpManager()
    let err: Error | null = null
    try {
      await mgr.callByFqn('mcp_unknown_foo', {})
    } catch (e) {
      err = e as Error
    }
    expect(err).not.toBeNull()
    expect(err!.message).toContain('mcp tool not found')
  })
})
