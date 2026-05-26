#!/usr/bin/env bun
/**
 * Post-install 修复脚本：
 *
 * - 检测 sharp 的 native binary 是否到位
 * - 缺失则用 Bun runtime 跑 sharp 的 install/libvips + prebuild-install
 *   （Bun 是 arm64 native，能正确探测平台；npm/Rosetta node 会装错 arch 的二进制）
 *
 * 在 `bun install --ignore-scripts` 之后手动跑一次：
 *   bun run scripts/postinstall.ts
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { $ } from 'bun'

const ROOT = process.cwd()
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64'
const PLATFORM = process.platform // 'darwin' | 'linux' | 'win32'

if (PLATFORM === 'win32') {
  console.log('windows 平台不需要这步修复（sharp 默认 prebuilt 走通）')
  process.exit(0)
}

// Bun isolated install 把 sharp 放在 node_modules/.bun/sharp@*/node_modules/sharp
function findSharpDir(): string | null {
  // glob 找 sharp 实际位置
  const cands = [
    join(ROOT, 'node_modules', 'sharp'),
    ...readBunStore(),
  ]
  for (const p of cands) {
    if (existsSync(join(p, 'package.json'))) return p
  }
  return null
}

function readBunStore(): string[] {
  const store = join(ROOT, 'node_modules', '.bun')
  if (!existsSync(store)) return []
  const out: string[] = []
  for (const entry of new Bun.Glob('sharp@*').scanSync({ cwd: store, onlyFiles: false })) {
    out.push(join(store, entry, 'node_modules', 'sharp'))
  }
  return out
}

function archSuffix(): string {
  if (PLATFORM === 'darwin' && ARCH === 'arm64') return 'darwin-arm64v8'
  if (PLATFORM === 'darwin' && ARCH === 'x64') return 'darwin-x64'
  if (PLATFORM === 'linux' && ARCH === 'arm64') return 'linux-arm64v8'
  if (PLATFORM === 'linux' && ARCH === 'x64') return 'linux-x64'
  throw new Error(`unsupported: ${PLATFORM} ${ARCH}`)
}

const sharpDir = findSharpDir()
if (!sharpDir) {
  console.log('未发现 sharp 依赖；跳过')
  process.exit(0)
}

const nativeFile = join(sharpDir, 'build', 'Release', `sharp-${archSuffix()}.node`)
const vendorDir = join(sharpDir, 'vendor', '8.14.5', archSuffix())

if (existsSync(nativeFile) && existsSync(vendorDir)) {
  console.log(`✓ sharp ${archSuffix()} 已就位`)
  process.exit(0)
}

console.log(`修复 sharp 平台二进制：${archSuffix()}`)
console.log(`  目录：${sharpDir}`)

// 1) 用 Bun（arm64 native）跑 install/libvips 拉对应平台 libvips
await $`cd ${sharpDir} && bun install/libvips`.quiet()
console.log('  ✓ libvips 已拉取')

// 2) 跑 prebuild-install 拉 native .node
const env = { ...process.env, npm_config_arch: ARCH, npm_config_platform: PLATFORM }
await $`cd ${sharpDir} && npx --yes prebuild-install --arch=${ARCH} --platform=${PLATFORM}`.env(env).quiet()
console.log('  ✓ native binary 已拉取')

if (!existsSync(nativeFile)) {
  console.error(`FAIL: ${nativeFile} 仍未生成`)
  process.exit(1)
}

console.log('✓ sharp 修复完成')
