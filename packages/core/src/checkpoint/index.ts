/**
 * V2 O4 Checkpoint service —— 工单快照与回滚。
 *
 * 设计目标：
 *   - 不假设项目是 git 仓库 —— 非 git 项目用 tar.gz 归档作为兜底
 *   - revert 是破坏性操作，要先保留 pre-revert 备份避免误操作丢工作
 *   - 失败不阻断主流程（baseline 失败 = 没有快照可 revert，但不影响工单跑）
 *
 * 文件布局：
 *   <checkpointsDir>/<reqId>/<checkpointId>.tar.gz       （tar 后端 snapshot）
 *   <checkpointsDir>/<reqId>/preRevert-<ts>.tar.gz       （revert 前自动备份）
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync, readdirSync, promises as fsp } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { getLogger } from '@ai-emp/domain'

const log = getLogger('checkpoint')

export type CheckpointBackendKind = 'git' | 'tar' | 'none'

export interface CheckpointRecord {
  id: string
  requirementId: string
  kind: 'baseline' | 'manual'
  label: string
  backendKind: CheckpointBackendKind
  ref: string | null
  workdir: string | null
}

/** 探测 workdir 用什么 backend 做 snapshot */
export function detectBackend(workdir: string | null | undefined): CheckpointBackendKind {
  if (!workdir) return 'none'
  try {
    if (!existsSync(workdir)) return 'none'
    if (!statSync(workdir).isDirectory()) return 'none'
    if (existsSync(join(workdir, '.git'))) return 'git'
    return 'tar'
  } catch {
    return 'none'
  }
}

interface RunResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number | null
}

function run(cmd: string, args: string[], cwd?: string, timeoutMs = 30_000): Promise<RunResult> {
  return new Promise((resolveP) => {
    const p = spawn(cmd, args, { cwd, env: process.env })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveP({ ok: code === 0, stdout, stderr, exitCode: code })
    }
    const timer = setTimeout(() => {
      try {
        p.kill('SIGKILL')
      } catch {
        // ignore
      }
      finish(null)
    }, timeoutMs)
    p.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    p.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    p.on('error', () => finish(null))
    p.on('close', (code) => finish(code))
  })
}

/** 建快照；返回实际 backendKind + ref（写 DB 用） */
export async function snapshot(params: {
  requirementId: string
  checkpointId: string
  workdir: string | null | undefined
  checkpointsDir: string
}): Promise<{ backendKind: CheckpointBackendKind; ref: string | null }> {
  const { requirementId, checkpointId, workdir, checkpointsDir } = params
  const backend = detectBackend(workdir)
  if (backend === 'none' || !workdir) {
    return { backendKind: 'none', ref: null }
  }
  if (backend === 'git') {
    const r = await run('git', ['rev-parse', 'HEAD'], workdir)
    if (!r.ok) {
      log.warn('snapshot.git.rev_parse_fail', {
        requirementId,
        checkpointId,
        stderr: r.stderr.slice(0, 200),
      })
      return { backendKind: 'none', ref: null }
    }
    const sha = r.stdout.trim()
    if (!/^[0-9a-f]{6,}$/i.test(sha)) {
      log.warn('snapshot.git.bad_sha', { requirementId, checkpointId, sha })
      return { backendKind: 'none', ref: null }
    }
    return { backendKind: 'git', ref: sha }
  }
  // tar：把整个 workdir 打包到 checkpointsDir/<reqId>/<ckptId>.tar.gz
  const targetDir = join(checkpointsDir, requirementId)
  mkdirSync(targetDir, { recursive: true })
  const relPath = join(requirementId, `${checkpointId}.tar.gz`)
  const absPath = join(checkpointsDir, relPath)
  const parent = dirname(resolve(workdir))
  const base = basename(resolve(workdir))
  // 排除常见的大体积/不必要目录，避免备份吞内存。可继续按需扩展。
  const excludes = ['--exclude=node_modules', '--exclude=.git', '--exclude=dist']
  const r = await run('tar', ['czf', absPath, '-C', parent, ...excludes, base], undefined, 120_000)
  if (!r.ok) {
    log.warn('snapshot.tar.fail', {
      requirementId,
      checkpointId,
      stderr: r.stderr.slice(0, 200),
    })
    try {
      rmSync(absPath, { force: true })
    } catch {
      // ignore
    }
    return { backendKind: 'none', ref: null }
  }
  log.info('snapshot.tar.ok', { requirementId, checkpointId, path: relPath })
  return { backendKind: 'tar', ref: relPath }
}

/** 回滚到某个快照；先备份当前 workdir 内容到 preRevert-<ts>.tar.gz 再回滚 */
export async function revert(params: {
  checkpoint: CheckpointRecord
  checkpointsDir: string
}): Promise<{ ok: boolean; backupRef: string | null; error?: string }> {
  const { checkpoint, checkpointsDir } = params
  if (!checkpoint.workdir) {
    return { ok: false, backupRef: null, error: 'checkpoint has no workdir' }
  }
  const workdir = checkpoint.workdir
  if (!existsSync(workdir)) {
    return { ok: false, backupRef: null, error: `workdir not found: ${workdir}` }
  }

  // 安全网：先备份当前 workdir
  const backupId = `preRevert-${Date.now()}`
  const backupDir = join(checkpointsDir, checkpoint.requirementId)
  mkdirSync(backupDir, { recursive: true })
  const backupRel = join(checkpoint.requirementId, `${backupId}.tar.gz`)
  const backupAbs = join(checkpointsDir, backupRel)
  const parent = dirname(resolve(workdir))
  const base = basename(resolve(workdir))
  const backupRun = await run(
    'tar',
    ['czf', backupAbs, '-C', parent, '--exclude=node_modules', '--exclude=.git', base],
    undefined,
    120_000,
  )
  const backupRef = backupRun.ok ? backupRel : null
  if (!backupRun.ok) {
    log.warn('revert.preRevertBackup.fail', {
      checkpointId: checkpoint.id,
      stderr: backupRun.stderr.slice(0, 200),
    })
  }

  if (checkpoint.backendKind === 'git') {
    if (!checkpoint.ref) {
      return { ok: false, backupRef, error: 'git checkpoint has no ref' }
    }
    const reset = await run('git', ['reset', '--hard', checkpoint.ref], workdir, 60_000)
    if (!reset.ok) {
      return { ok: false, backupRef, error: `git reset failed: ${reset.stderr.slice(0, 200)}` }
    }
    const clean = await run('git', ['clean', '-fd'], workdir, 60_000)
    if (!clean.ok) {
      log.warn('revert.git.clean.fail', {
        checkpointId: checkpoint.id,
        stderr: clean.stderr.slice(0, 200),
      })
    }
    log.info('revert.git.ok', { checkpointId: checkpoint.id, ref: checkpoint.ref })
    return { ok: true, backupRef }
  }

  if (checkpoint.backendKind === 'tar') {
    if (!checkpoint.ref) {
      return { ok: false, backupRef, error: 'tar checkpoint has no ref' }
    }
    const archiveAbs = join(checkpointsDir, checkpoint.ref)
    if (!existsSync(archiveAbs)) {
      return { ok: false, backupRef, error: `archive missing: ${archiveAbs}` }
    }
    // 安全清空 workdir 现有内容（保留目录本身），再解压
    try {
      for (const entry of readdirSync(workdir)) {
        // 不删 .git（如果有）— tar 模式默认 workdir 不是 git，但保留以防双备份
        if (entry === '.git') continue
        await fsp.rm(join(workdir, entry), { recursive: true, force: true })
      }
    } catch (err) {
      return { ok: false, backupRef, error: `clean workdir failed: ${String(err)}` }
    }
    const extract = await run(
      'tar',
      ['xzf', archiveAbs, '-C', parent, '--strip-components=0'],
      undefined,
      120_000,
    )
    if (!extract.ok) {
      return {
        ok: false,
        backupRef,
        error: `tar extract failed: ${extract.stderr.slice(0, 200)}`,
      }
    }
    log.info('revert.tar.ok', { checkpointId: checkpoint.id, archive: checkpoint.ref })
    return { ok: true, backupRef }
  }

  // backendKind === 'none' — no-op
  return { ok: true, backupRef }
}
