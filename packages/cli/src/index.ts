#!/usr/bin/env bun
/**
 * ai-emp CLI 入口 — 路由子命令到 ./commands.ts。
 */

import {
  cmdBackup,
  cmdInit,
  cmdKeychain,
  cmdLogs,
  cmdMetrics,
  cmdModelsPull,
  cmdRecover,
  cmdSeed,
  cmdServe,
  cmdStatus,
} from './commands.js'

async function main(argv: string[]): Promise<number> {
  const cmd = argv[2] ?? 'help'
  const rest = argv.slice(3)
  switch (cmd) {
    case 'init':
      return cmdInit()
    case 'serve': {
      const portArg = takeOption(rest, '--port')
      return cmdServe({ port: portArg ? Number(portArg) : undefined })
    }
    case 'status':
      return cmdStatus()
    case 'logs': {
      const reqId = rest[0]
      if (!reqId) {
        console.error('用法: ai-emp logs <req-id> [-f]')
        return 1
      }
      const follow = rest.includes('-f') || rest.includes('--follow')
      return cmdLogs(reqId, { follow })
    }
    case 'keychain': {
      const [op, name, value] = rest
      if (!op || !name) {
        console.error('用法: ai-emp keychain <set|get|delete> <name> [value]')
        return 1
      }
      return cmdKeychain(op, name, value)
    }
    case 'recover':
      return cmdRecover()
    case 'metrics':
      return cmdMetrics()
    case 'seed':
      return cmdSeed({ reset: rest.includes('--reset') })
    case 'backup':
      return cmdBackup(rest[0])
    case 'models': {
      const sub = rest[0]
      if (sub === 'pull') return cmdModelsPull()
      console.error('用法: ai-emp models pull')
      return 1
    }
    case 'version':
    case '--version':
    case '-v':
      console.log('ai-emp 0.0.0')
      return 0
    case 'help':
    case '--help':
    case '-h':
      printHelp()
      return 0
    default:
      console.error(`未知命令: ${cmd}`)
      printHelp()
      return 1
  }
}

function takeOption(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag)
  if (i < 0) return undefined
  return rest[i + 1]
}

function printHelp() {
  console.log(`ai-emp — AI 数字员工 CLI

用法:
  ai-emp init                       首次引导（生成 ~/.ai-emp/、token）
  ai-emp serve [--port 7878]        启动 HTTP + WS 服务
  ai-emp status                     列出活跃需求
  ai-emp logs <req-id> [-f]         查看思维链
  ai-emp keychain set <name> [v]    写入凭证（也可走 AIEMP_SECRET）
  ai-emp keychain get <name>        读取
  ai-emp keychain delete <name>     删除
  ai-emp recover                    列出 in-flight 需求
  ai-emp metrics                    PRD §12 量化指标采样
  ai-emp seed [--reset]             导入样板（3 项目 + 5 员工 + 11 技能）；--reset 清空重导
  ai-emp backup [path]              DB 整盘备份
  ai-emp models pull                下载嵌入模型
  ai-emp version
`)
}

const code = await main(process.argv)
process.exit(code)
