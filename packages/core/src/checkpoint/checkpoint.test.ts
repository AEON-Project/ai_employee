/**
 * V2 O4 Checkpoint service 单测 — 临时目录 + 真实 git/tar 命令。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { detectBackend, snapshot, revert, type CheckpointRecord } from './index.js'

function runSync(cmd: string, args: string[], cwd?: string): Promise<number | null> {
  return new Promise((res) => {
    const p = spawn(cmd, args, { cwd, env: process.env })
    p.on('close', (code) => res(code))
    p.on('error', () => res(null))
  })
}

let root: string
let workdir: string
let ckptDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ai-emp-ckpt-'))
  workdir = join(root, 'project')
  mkdirSync(workdir)
  ckptDir = join(root, 'checkpoints')
  mkdirSync(ckptDir)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('detectBackend', () => {
  test('null / undefined / 不存在 → none', () => {
    expect(detectBackend(null)).toBe('none')
    expect(detectBackend(undefined)).toBe('none')
    expect(detectBackend('/no/such/path')).toBe('none')
  })
  test('普通目录 → tar', () => {
    expect(detectBackend(workdir)).toBe('tar')
  })
  test('含 .git/ 子目录 → git', async () => {
    mkdirSync(join(workdir, '.git'))
    expect(detectBackend(workdir)).toBe('git')
  })
})

describe('snapshot + revert (tar backend)', () => {
  test('打包后改文件，revert 恢复原内容', async () => {
    writeFileSync(join(workdir, 'a.txt'), 'original\n')
    writeFileSync(join(workdir, 'b.txt'), 'before\n')

    const snap = await snapshot({
      requirementId: 'req-1',
      checkpointId: 'ckpt-1',
      workdir,
      checkpointsDir: ckptDir,
    })
    expect(snap.backendKind).toBe('tar')
    expect(snap.ref).toBe(join('req-1', 'ckpt-1.tar.gz'))
    expect(existsSync(join(ckptDir, snap.ref!))).toBe(true)

    // 模拟 LLM 改坏文件 + 新增
    writeFileSync(join(workdir, 'a.txt'), 'CORRUPTED\n')
    writeFileSync(join(workdir, 'new.txt'), 'should be gone\n')
    rmSync(join(workdir, 'b.txt'))

    const ckpt: CheckpointRecord = {
      id: 'ckpt-1',
      requirementId: 'req-1',
      kind: 'baseline',
      label: 'auto',
      backendKind: 'tar',
      ref: snap.ref,
      workdir,
    }
    const r = await revert({ checkpoint: ckpt, checkpointsDir: ckptDir })
    expect(r.ok).toBe(true)
    expect(r.backupRef).not.toBeNull()
    // preRevert 备份已建
    expect(existsSync(join(ckptDir, r.backupRef!))).toBe(true)

    // workdir 应恢复
    expect(readFileSync(join(workdir, 'a.txt'), 'utf8')).toBe('original\n')
    expect(readFileSync(join(workdir, 'b.txt'), 'utf8')).toBe('before\n')
    expect(existsSync(join(workdir, 'new.txt'))).toBe(false)
  })
})

describe('snapshot + revert (git backend)', () => {
  test('git init + commit → snapshot 拿 SHA；改完 revert 复位', async () => {
    // 跳过测试如果系统没装 git
    const gitOk = (await runSync('git', ['--version'])) === 0
    if (!gitOk) return

    await runSync('git', ['init', '-q'], workdir)
    await runSync('git', ['config', 'user.email', 'test@test'], workdir)
    await runSync('git', ['config', 'user.name', 'test'], workdir)
    writeFileSync(join(workdir, 'a.txt'), 'baseline content\n')
    await runSync('git', ['add', '.'], workdir)
    await runSync('git', ['commit', '-q', '-m', 'init'], workdir)

    expect(detectBackend(workdir)).toBe('git')

    const snap = await snapshot({
      requirementId: 'req-g',
      checkpointId: 'ckpt-g',
      workdir,
      checkpointsDir: ckptDir,
    })
    expect(snap.backendKind).toBe('git')
    expect(snap.ref).toMatch(/^[0-9a-f]{6,}$/)

    // 改文件 + 新增未跟踪
    writeFileSync(join(workdir, 'a.txt'), 'CORRUPTED\n')
    writeFileSync(join(workdir, 'new.txt'), 'untracked\n')

    const ckpt: CheckpointRecord = {
      id: 'ckpt-g',
      requirementId: 'req-g',
      kind: 'baseline',
      label: 'auto',
      backendKind: 'git',
      ref: snap.ref,
      workdir,
    }
    const r = await revert({ checkpoint: ckpt, checkpointsDir: ckptDir })
    expect(r.ok).toBe(true)
    // a.txt 恢复 + new.txt 被 git clean -fd 删除
    expect(readFileSync(join(workdir, 'a.txt'), 'utf8')).toBe('baseline content\n')
    expect(existsSync(join(workdir, 'new.txt'))).toBe(false)
  })
})

describe('snapshot (none backend)', () => {
  test('workdir 不存在 → backendKind=none, ref=null', async () => {
    const snap = await snapshot({
      requirementId: 'req-n',
      checkpointId: 'ckpt-n',
      workdir: '/no/such/dir',
      checkpointsDir: ckptDir,
    })
    expect(snap.backendKind).toBe('none')
    expect(snap.ref).toBeNull()
  })

  test('workdir 为 null → backendKind=none', async () => {
    const snap = await snapshot({
      requirementId: 'req-n',
      checkpointId: 'ckpt-n',
      workdir: null,
      checkpointsDir: ckptDir,
    })
    expect(snap.backendKind).toBe('none')
    expect(snap.ref).toBeNull()
  })
})
