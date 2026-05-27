/**
 * Bash tool 单测 —— 临时目录隔离，不污染仓库。
 *
 * V1.1 简化版：只暴露 Bash 一个 tool；LLM 用 cat / sed / find / grep -r / curl 等
 * 本地命令完成所有工作（Read/Write/Edit/Glob/Grep 都是 Bash 命令的特例）。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  bashTool,
  processTool,
  FILE_TOOL_NAMES,
  FILE_TOOLS,
  _resetSessionsForTest,
} from './file-tools.js'
import type { ToolContext } from './types.js'

function makeCtx(): ToolContext {
  return {
    requirementId: 'test-req',
    employeeId: 'test-emp',
    threadId: 'test-thread',
    signal: new AbortController().signal,
  }
}

let workDir: string
const originalCwd = process.cwd()

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'ai-emp-tools-'))
  process.chdir(workDir)
})
afterEach(() => {
  process.chdir(originalCwd)
  rmSync(workDir, { recursive: true, force: true })
})

describe('FILE_TOOLS 导出', () => {
  test('暴露 2 个工具：Bash + Process', () => {
    expect(FILE_TOOLS).toHaveLength(2)
    expect(FILE_TOOL_NAMES).toEqual(['Bash', 'Process'])
  })
})

describe('Bash', () => {
  test('echo 成功 + exitCode 0', async () => {
    const r = await bashTool.invoke({ command: 'echo hello' }, makeCtx())
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('hello')
  })

  test('非零退出码', async () => {
    const r = await bashTool.invoke({ command: 'exit 7' }, makeCtx())
    expect(r.exitCode).toBe(7)
  })

  test('cwd 生效', async () => {
    mkdirSync(join(workDir, 'sub'))
    const r = await bashTool.invoke({ command: 'pwd', cwd: 'sub' }, makeCtx())
    expect(r.stdout.trim()).toBe(realpathSync(join(workDir, 'sub')))
  })

  test('超时 SIGKILL', async () => {
    const r = await bashTool.invoke({ command: 'sleep 5', timeout_ms: 200 }, makeCtx())
    expect(r.exitCode).not.toBe(0)
    expect(r.durationMs).toBeLessThan(2_000)
  })

  test('stdout 截断 50000 字符', async () => {
    const r = await bashTool.invoke({ command: `printf 'x%.0s' {1..60000}` }, makeCtx())
    expect(r.truncated).toBe(true)
    expect(r.stdout.length).toBeLessThanOrEqual(50_000)
  })

  // 验证 LLM 通过 Bash 能完成 Read/Write/Edit/Glob/Grep 全部场景
  test('Read 场景：cat 读文件', async () => {
    writeFileSync(join(workDir, 'a.txt'), 'line1\nline2\nline3\n')
    const r = await bashTool.invoke({ command: 'cat a.txt' }, makeCtx())
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('line1')
  })

  test('Write 场景：echo 重定向写文件', async () => {
    await bashTool.invoke(
      { command: `mkdir -p sub/dir && echo 'hello world' > sub/dir/c.txt` },
      makeCtx(),
    )
    expect(readFileSync(join(workDir, 'sub/dir/c.txt'), 'utf8').trim()).toBe('hello world')
  })

  test('Edit 场景：sed -i 替换', async () => {
    writeFileSync(join(workDir, 'e.txt'), 'foo bar baz')
    const r = await bashTool.invoke(
      // macOS sed 需要 '' 作为 -i 的 backup ext
      { command: `sed -i '' 's/bar/BAR/g' e.txt` },
      makeCtx(),
    )
    expect(r.exitCode).toBe(0)
    expect(readFileSync(join(workDir, 'e.txt'), 'utf8')).toBe('foo BAR baz')
  })

  test('Glob 场景：find 列文件', async () => {
    mkdirSync(join(workDir, 'src'))
    writeFileSync(join(workDir, 'src/a.ts'), '')
    writeFileSync(join(workDir, 'src/b.ts'), '')
    writeFileSync(join(workDir, 'src/c.md'), '')
    const r = await bashTool.invoke({ command: `find src -name '*.ts'` }, makeCtx())
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('src/a.ts')
    expect(r.stdout).toContain('src/b.ts')
    expect(r.stdout).not.toContain('c.md')
  })

  test('Grep 场景：grep -rn 搜内容', async () => {
    writeFileSync(join(workDir, 'g.txt'), 'hello world\nfoo bar\nhello again\n')
    const r = await bashTool.invoke({ command: `grep -n 'hello' g.txt` }, makeCtx())
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('1:hello')
    expect(r.stdout).toContain('3:hello')
  })

  test('完整本地权限：mkdir + chmod + 删除', async () => {
    await bashTool.invoke({ command: 'mkdir -p restricted && chmod 700 restricted' }, makeCtx())
    expect(existsSync(join(workDir, 'restricted'))).toBe(true)
    await bashTool.invoke({ command: 'rm -rf restricted' }, makeCtx())
    expect(existsSync(join(workDir, 'restricted'))).toBe(false)
  })

  test('env 字段：临时环境变量生效', async () => {
    const r = await bashTool.invoke(
      { command: 'echo $AIEMP_TEST_VAR', env: { AIEMP_TEST_VAR: 'hello-env' } },
      makeCtx(),
    )
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('hello-env')
  })

  test('completed 状态字段', async () => {
    const r = await bashTool.invoke({ command: 'echo ok' }, makeCtx())
    expect(r.status).toBe('completed')
    expect(r.sessionId).toBeUndefined()
  })

  test('failed 状态字段（非 0 退出码）', async () => {
    const r = await bashTool.invoke({ command: 'exit 3' }, makeCtx())
    expect(r.status).toBe('failed')
    expect(r.exitCode).toBe(3)
  })

  // ── V2 O7: PTY ──────────────────────────────────────────────
  test('V2 O7 pty=true：命令在伪 tty 内运行（isatty 返回 true）', async () => {
    const r = await bashTool.invoke(
      // 用 sh 测试 tty 检测；macOS / Linux 都支持
      { command: '[ -t 1 ] && echo TTY_YES || echo TTY_NO', pty: true },
      makeCtx(),
    )
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('TTY_YES')
  })

  test('V2 O7 pty=false（默认）：命令在普通 pipe 下运行（isatty=false）', async () => {
    const r = await bashTool.invoke(
      { command: '[ -t 1 ] && echo TTY_YES || echo TTY_NO' },
      makeCtx(),
    )
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('TTY_NO')
  })

  test('V2 O7 pty=true 命令正确执行 + 立即结束（不卡 stdin）', async () => {
    const r = await bashTool.invoke({ command: 'echo via-pty', pty: true }, makeCtx())
    expect(r.exitCode).toBe(0)
    // macOS script 会前缀 ^D；只断言 echo 内容存在
    expect(r.stdout).toContain('via-pty')
  })
})

describe('Bash background + Process', () => {
  afterEach(() => _resetSessionsForTest())

  test('background=true 立即返回 running + sessionId', async () => {
    const r = await bashTool.invoke({ command: 'sleep 2', background: true }, makeCtx())
    expect(r.status).toBe('running')
    expect(typeof r.sessionId).toBe('string')
    expect(r.exitCode).toBeNull()
  })

  test('yield_ms 短超时 → 返回 running + sessionId', async () => {
    const r = await bashTool.invoke({ command: 'sleep 1', yield_ms: 100 }, makeCtx())
    expect(r.status).toBe('running')
    expect(typeof r.sessionId).toBe('string')
  })

  test('Process read 后台进程：等其结束后能拿到累计 stdout + exitCode=0', async () => {
    const startR = await bashTool.invoke(
      { command: 'echo line1; sleep 0.2; echo line2', background: true },
      makeCtx(),
    )
    expect(startR.status).toBe('running')
    const sid = startR.sessionId!
    // 等够时间让 sleep 完成
    await new Promise((r) => setTimeout(r, 500))
    const readR = await processTool.invoke({ sessionId: sid, action: 'read' }, makeCtx())
    expect(readR.status).toBe('completed')
    expect(readR.exitCode).toBe(0)
    expect(readR.stdout).toContain('line1')
    expect(readR.stdout).toContain('line2')
  })

  test('Process status：不读输出', async () => {
    const startR = await bashTool.invoke(
      { command: 'echo hi; sleep 0.3', background: true },
      makeCtx(),
    )
    const sid = startR.sessionId!
    const statusR = await processTool.invoke({ sessionId: sid, action: 'status' }, makeCtx())
    expect(statusR.status).toBe('running')
    expect(statusR.stdout).toBeUndefined()
    expect(statusR.stderr).toBeUndefined()
    // 清理
    await processTool.invoke({ sessionId: sid, action: 'kill' }, makeCtx())
  })

  test('Process kill：SIGKILL 后台进程', async () => {
    const startR = await bashTool.invoke({ command: 'sleep 30', background: true }, makeCtx())
    const sid = startR.sessionId!
    const killR = await processTool.invoke({ sessionId: sid, action: 'kill' }, makeCtx())
    expect(killR.status).toBe('killed')
  })

  test('Process 未知 sessionId → status=unknown', async () => {
    const r = await processTool.invoke({ sessionId: 'no-such-session' }, makeCtx())
    expect(r.status).toBe('unknown')
  })

  test('read 已完成的 session 一次后从 registry 清除', async () => {
    const startR = await bashTool.invoke({ command: 'echo done', background: true }, makeCtx())
    const sid = startR.sessionId!
    await new Promise((r) => setTimeout(r, 200))
    const r1 = await processTool.invoke({ sessionId: sid, action: 'read' }, makeCtx())
    expect(r1.status).toBe('completed')
    const r2 = await processTool.invoke({ sessionId: sid, action: 'read' }, makeCtx())
    expect(r2.status).toBe('unknown')
  })
})
