/**
 * CLI 子命令实现。
 */

import { existsSync } from 'node:fs'
import { copyFile, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createKeychainStore } from '@ai-emp/storage'
import { createServer } from '@ai-emp/server'
import { createBridge, type BridgeHandle } from '@ai-emp/bridge-tg'
import { scanInflight, RequirementScheduler } from '@ai-emp/core/runtime'
import { formatReport, sample } from '@ai-emp/core/metrics'
import { attachmentsDir, dataDir, dbPath, ensureDirs, loadConfig, saveConfig } from './config.js'
import { bootServices } from './services.js'

/** 查找 packages/web/dist；找到才挂静态资源；没找到（开发态没 build）就走占位首页 */
function findWebDist(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(here, '..', '..', 'web', 'dist'),
    resolve(process.cwd(), 'packages', 'web', 'dist'),
    resolve(dirname(process.argv[0] ?? ''), 'web', 'dist'),
  ]
  for (const p of candidates) {
    if (existsSync(join(p, 'index.html'))) return p
  }
  return undefined
}

// ──────────────────────────────────────────────────────────────
// init — 引导首次配置
// ──────────────────────────────────────────────────────────────
export async function cmdInit(): Promise<number> {
  await ensureDirs()
  let cfg = await loadConfig()
  await saveConfig(cfg)

  // 生成 localhost token（如不存在）
  const k = createKeychainStore()
  const existing = await k.get(cfg.server.localhostTokenRef)
  if (!existing) {
    const tok = crypto.randomUUID().replace(/-/g, '')
    await k.set(cfg.server.localhostTokenRef, tok)
    console.log(`✓ localhost token 已生成并写入 keychain`)
  } else {
    console.log(`✓ localhost token 已存在，跳过`)
  }

  console.log(`✓ 数据目录: ${dataDir()}`)
  console.log(`✓ 配置文件: ${join(dataDir(), 'config.toml')}`)
  console.log('')
  console.log('下一步:')
  console.log(`  ai-emp keychain set <name>   # 写入 LLM/TG 凭证`)
  console.log(`  ai-emp serve                  # 启动服务`)
  void cfg
  return 0
}

// ──────────────────────────────────────────────────────────────
// serve — 启动 HTTP + WS server
// ──────────────────────────────────────────────────────────────
export async function cmdServe(args: { port?: number }): Promise<number> {
  await ensureDirs()
  const cfg = await loadConfig()
  const port = args.port ?? cfg.server.port

  const k = createKeychainStore()
  const token = await k.get(cfg.server.localhostTokenRef)
  if (!token) {
    console.error('错误：localhost token 缺失。请先运行 `ai-emp init`')
    return 1
  }

  const boot = await bootServices()
  const webDistDir = findWebDist()
  const handle = createServer({
    port,
    dataDir: dataDir(),
    token,
    services: boot.services,
    ...(webDistDir ? { webDistDir } : {}),
  })
  const { port: actualPort } = await handle.start()

  // 启动 scheduler（α 串行）
  const scheduler = RequirementScheduler.bindServices(boot.services, { maxConcurrent: 1 })
  // 把 in-flight 需求 enqueue 续跑
  const recover = scanInflight(boot.services)
  for (const r of recover.inflight) {
    if (r.status === '进行中') scheduler.enqueue(r.reqId)
  }
  if (recover.inflight.length > 0) {
    console.log(`恢复 ${recover.inflight.length} 个 in-flight 需求`)
  }

  // ── 可选启动 TG bridge（需 keychain 中有 tg-bot-token） ──────
  let bridge: BridgeHandle | null = null
  const tgToken = await k.get('tg-bot-token').catch(() => null)
  const tgChatRaw = process.env.AIEMP_TG_CHAT_IDS
  if (tgToken && tgChatRaw) {
    const ids = tgChatRaw
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n))
    if (ids.length > 0) {
      bridge = createBridge(
        { services: boot.services, bus: boot.bus, repos: boot.services.repos },
        {
          token: tgToken,
          allowedChatIds: ids,
          webUrlBase: `http://localhost:${actualPort}`,
        },
      )
      await bridge.start()
      console.log(`✓ TG bridge 已启动，白名单 chat: ${ids.join(', ')}`)
    }
  } else {
    console.log(`  TG bridge 未启动（缺 tg-bot-token 或 AIEMP_TG_CHAT_IDS）`)
  }

  console.log(`✓ ai-emp serve 启动：http://localhost:${actualPort}`)
  console.log(`  浏览器登录链接: http://localhost:${actualPort}/auth?token=${token}`)
  if (webDistDir) console.log(`  Web UI 已挂载: ${webDistDir}`)
  else console.log(`  Web UI 未构建（在 packages/web 跑 \`bun run build\` 即可挂载）`)
  console.log(`  Ctrl+C 退出`)

  // 等 SIGINT/SIGTERM
  return await new Promise<number>((resolve) => {
    const stop = async () => {
      console.log('\n关闭中...')
      scheduler.drain()
      if (bridge) await bridge.stop()
      await handle.stop()
      boot.close()
      resolve(0)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}

// ──────────────────────────────────────────────────────────────
// status — 列出 active / queued requirements
// ──────────────────────────────────────────────────────────────
export async function cmdStatus(): Promise<number> {
  const boot = await bootServices()
  try {
    const rows = boot.services.repos.requirements.listActive()
    if (rows.length === 0) {
      console.log('无活跃需求')
      return 0
    }
    for (const r of rows) {
      console.log(
        `[${r.status}] ${r.id.slice(0, 8)} · ${r.title} · assignee=${r.assigneeId ?? '-'} · created=${r.createdAt.toISOString()}`,
      )
    }
    return 0
  } finally {
    boot.close()
  }
}

// ──────────────────────────────────────────────────────────────
// logs <req-id> — 输出 thread messages
// ──────────────────────────────────────────────────────────────
export async function cmdLogs(reqId: string, opts: { follow?: boolean } = {}): Promise<number> {
  const boot = await bootServices()
  try {
    const thread = boot.services.repos.threads.findByRequirement(reqId)
    if (!thread) {
      console.error(`未找到需求 ${reqId} 的 thread`)
      return 1
    }
    let seq = -1
    const print = () => {
      const rows = boot.services.repos.messages.listByThread(thread.id, {
        sinceSeq: seq >= 0 ? seq : undefined,
      })
      for (const m of rows) {
        const c = m.contentJson as { type?: string; text?: string }
        const text = c.text ?? JSON.stringify(c)
        console.log(`[#${m.seq} ${m.role}/${m.type}] ${text}`)
        seq = m.seq
      }
    }
    print()
    if (!opts.follow) return 0
    // tail -f：每 500ms 轮询新消息
    return await new Promise<number>((resolve) => {
      const t = setInterval(print, 500)
      const stop = () => {
        clearInterval(t)
        resolve(0)
      }
      process.on('SIGINT', stop)
    })
  } finally {
    boot.close()
  }
}

// ──────────────────────────────────────────────────────────────
// keychain set/get/delete <name>
// ──────────────────────────────────────────────────────────────
export async function cmdKeychain(op: string, name: string, value?: string): Promise<number> {
  const k = createKeychainStore()
  if (op === 'set') {
    if (!value) {
      // 交互式读取（非 TTY 时不安全；α 用环境变量 AIEMP_SECRET 兜底）
      const env = process.env.AIEMP_SECRET
      if (!env) {
        console.error('请提供 value 或设置 AIEMP_SECRET 环境变量')
        return 1
      }
      await k.set(name, env)
      console.log(`✓ 写入 ${name}`)
      return 0
    }
    await k.set(name, value)
    console.log(`✓ 写入 ${name}`)
    return 0
  }
  if (op === 'get') {
    const v = await k.get(name)
    if (v == null) {
      console.error(`未找到 ${name}`)
      return 1
    }
    process.stdout.write(v)
    return 0
  }
  if (op === 'delete') {
    const ok = await k.remove(name)
    console.log(ok ? `✓ 已删除 ${name}` : `${name} 不存在`)
    return ok ? 0 : 1
  }
  console.error(`未知 keychain 子命令: ${op}`)
  return 1
}

// ──────────────────────────────────────────────────────────────
// recover — 列出 in-flight 需求
// ──────────────────────────────────────────────────────────────
export async function cmdRecover(): Promise<number> {
  const boot = await bootServices()
  try {
    const r = scanInflight(boot.services)
    if (r.inflight.length === 0) {
      console.log('无 in-flight 需求')
      return 0
    }
    for (const x of r.inflight) {
      const hb = x.lastHeartbeatAt ? x.lastHeartbeatAt.toISOString() : 'never'
      console.log(
        `[${x.status}] ${x.reqId.slice(0, 8)} · lastHeartbeat=${hb} · recent=${x.recentHeartbeat}`,
      )
    }
    return 0
  } finally {
    boot.close()
  }
}

// ──────────────────────────────────────────────────────────────
// backup [path] — DB 整盘 copy
// ──────────────────────────────────────────────────────────────
export async function cmdBackup(path?: string): Promise<number> {
  await ensureDirs()
  const src = dbPath()
  if (!existsSync(src)) {
    console.error(`DB 不存在: ${src}`)
    return 1
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const dst = path ?? join(dataDir(), 'backups', `db-${ts}.sqlite`)
  // 确保父目录存在
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dirname(dst), { recursive: true })
  await copyFile(src, dst)
  console.log(`✓ 备份到 ${dst}`)
  return 0
}

// ──────────────────────────────────────────────────────────────
// models pull — 触发嵌入模型下载（在 server 启动时也会按需懒加载）
// ──────────────────────────────────────────────────────────────
export async function cmdModelsPull(): Promise<number> {
  await ensureDirs()
  console.log('开始拉取嵌入模型...（首次约 23MB）')
  const { createEmbeddingService } = await import('@ai-emp/embedding')
  const svc = createEmbeddingService({ cacheDir: join(dataDir(), 'models') })
  await svc.ready()
  console.log(`✓ 模型就绪，维度 = ${svc.dim}`)
  return 0
}

// ──────────────────────────────────────────────────────────────
// metrics — 跑 PRD §12 量化指标采样
// ──────────────────────────────────────────────────────────────
export async function cmdMetrics(): Promise<number> {
  const boot = await bootServices()
  try {
    const s = await sample(boot.services.repos)
    console.log(formatReport(s))
    return 0
  } finally {
    boot.close()
  }
}

// ──────────────────────────────────────────────────────────────
// seed — 导入样板项目 / 员工 / 技能
// ──────────────────────────────────────────────────────────────
export async function cmdSeed(): Promise<number> {
  const { seedAll } = await import('./seed.js')
  const boot = await bootServices()
  try {
    const r = seedAll(boot.services.repos)
    console.log(
      `✓ 已导入：${r.projects} 项目 / ${r.employees} 员工 / ${r.skills} 技能 / ${r.conventions} 规范`,
    )
    if (r.employees > 0) {
      console.log(
        `⚠️  员工的 modelKeyRef 都是 "REPLACE_ME"。\n   请先 \`ai-emp keychain set <name> <secret>\`，再在 UI 中修改员工配置。`,
      )
    }
    return 0
  } finally {
    boot.close()
  }
}

// 占位（避免 lint 报 unreferenced）
export { readFile, attachmentsDir }
