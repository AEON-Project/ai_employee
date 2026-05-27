/**
 * file/shell tool 单测 —— 临时目录隔离，不污染仓库。
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
import { readTool, writeTool, editTool, globTool, grepTool, bashTool } from './file-tools.js'
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

describe('Read', () => {
  test('读取相对路径', async () => {
    writeFileSync(join(workDir, 'a.txt'), 'line1\nline2\nline3\n')
    const r = await readTool.invoke({ path: 'a.txt' }, makeCtx())
    expect(r.content).toContain('line1')
    expect(r.lines).toBeGreaterThanOrEqual(3)
    expect(r.truncated).toBe(false)
  })

  test('读取绝对路径 + offset/limit', async () => {
    writeFileSync(join(workDir, 'b.txt'), 'a\nb\nc\nd\ne\n')
    const r = await readTool.invoke(
      { path: join(workDir, 'b.txt'), offset: 1, limit: 2 },
      makeCtx(),
    )
    expect(r.content).toBe('b\nc')
  })

  test('截断超长输出', async () => {
    const big = 'x'.repeat(60_000)
    writeFileSync(join(workDir, 'big.txt'), big)
    const r = await readTool.invoke({ path: 'big.txt' }, makeCtx())
    expect(r.truncated).toBe(true)
    expect(r.content.length).toBeLessThan(60_000)
  })
})

describe('Write', () => {
  test('写入文件 + 自动建父目录', async () => {
    await writeTool.invoke({ path: 'sub/dir/c.txt', content: 'hello world' }, makeCtx())
    expect(readFileSync(join(workDir, 'sub/dir/c.txt'), 'utf8')).toBe('hello world')
  })

  test('覆盖现有文件', async () => {
    writeFileSync(join(workDir, 'd.txt'), 'old')
    await writeTool.invoke({ path: 'd.txt', content: 'new' }, makeCtx())
    expect(readFileSync(join(workDir, 'd.txt'), 'utf8')).toBe('new')
  })
})

describe('Edit', () => {
  test('唯一替换成功', async () => {
    writeFileSync(join(workDir, 'e.txt'), 'foo bar baz')
    const r = await editTool.invoke(
      { path: 'e.txt', old_string: 'bar', new_string: 'BAR' },
      makeCtx(),
    )
    expect(r.replaced).toBe(1)
    expect(readFileSync(join(workDir, 'e.txt'), 'utf8')).toBe('foo BAR baz')
  })

  test('多次出现且未 replace_all → 报错', async () => {
    writeFileSync(join(workDir, 'f.txt'), 'x x x')
    await expect(
      editTool.invoke({ path: 'f.txt', old_string: 'x', new_string: 'y' }, makeCtx()),
    ).rejects.toThrow(/occurs 3 times/)
  })

  test('replace_all 替换所有', async () => {
    writeFileSync(join(workDir, 'g.txt'), 'a b a b a')
    const r = await editTool.invoke(
      { path: 'g.txt', old_string: 'a', new_string: 'A', replace_all: true },
      makeCtx(),
    )
    expect(r.replaced).toBe(3)
    expect(readFileSync(join(workDir, 'g.txt'), 'utf8')).toBe('A b A b A')
  })

  test('old_string 不存在 → 报错', async () => {
    writeFileSync(join(workDir, 'h.txt'), 'hello')
    await expect(
      editTool.invoke({ path: 'h.txt', old_string: 'world', new_string: '!' }, makeCtx()),
    ).rejects.toThrow(/not found/)
  })
})

describe('Glob', () => {
  test('模式匹配多个文件', async () => {
    mkdirSync(join(workDir, 'src'))
    writeFileSync(join(workDir, 'src', 'a.ts'), '')
    writeFileSync(join(workDir, 'src', 'b.ts'), '')
    writeFileSync(join(workDir, 'src', 'c.md'), '')
    const r = await globTool.invoke({ pattern: '**/*.ts' }, makeCtx())
    expect(r.matches.sort()).toEqual(['src/a.ts', 'src/b.ts'])
  })

  test('cwd 限定根目录', async () => {
    mkdirSync(join(workDir, 'a'))
    mkdirSync(join(workDir, 'b'))
    writeFileSync(join(workDir, 'a', 'x.txt'), '')
    writeFileSync(join(workDir, 'b', 'y.txt'), '')
    const r = await globTool.invoke({ pattern: '*.txt', cwd: 'a' }, makeCtx())
    expect(r.matches).toEqual(['x.txt'])
  })
})

describe('Grep', () => {
  test('正则命中', async () => {
    writeFileSync(join(workDir, 'g1.txt'), 'hello world\nfoo bar\nhello again\n')
    const r = await grepTool.invoke({ pattern: 'hello' }, makeCtx())
    expect(r.count).toBe(2)
    expect(r.hits[0]!.text).toContain('hello')
  })

  test('case_insensitive', async () => {
    writeFileSync(join(workDir, 'g2.txt'), 'HELLO\nhello\n')
    const r = await grepTool.invoke({ pattern: 'hello', case_insensitive: true }, makeCtx())
    expect(r.count).toBe(2)
  })
})

describe('Bash', () => {
  test('echo 成功', async () => {
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
    // macOS /var/folders 是 /private/var/folders 的 symlink，pwd 输出真实路径
    expect(r.stdout.trim()).toBe(realpathSync(join(workDir, 'sub')))
  })

  test('超时 SIGKILL', async () => {
    const r = await bashTool.invoke({ command: 'sleep 5', timeout_ms: 200 }, makeCtx())
    // SIGKILL → 退出码非 0；duration 接近 timeout
    expect(r.exitCode).not.toBe(0)
    expect(r.durationMs).toBeLessThan(2_000)
  })

  test('能写文件（验证完整本地权限）', async () => {
    const target = join(workDir, 'bash-wrote.txt')
    await bashTool.invoke({ command: `echo 'written by bash' > '${target}'` }, makeCtx())
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf8').trim()).toBe('written by bash')
  })
})
