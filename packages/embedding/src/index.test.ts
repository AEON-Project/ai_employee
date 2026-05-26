/**
 * 真实加载 bge-small-zh-v1.5 + embed 中文样本。
 *
 * 用专属 cacheDir：./.test-models —— 不污染 ~/.ai-emp/models。
 * 跨进程权重共享走 HF cache（首次会下载，后续从本地解压）。
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cosineSimilarity, createEmbeddingService } from './index.js'

describe('EmbeddingService', () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'ai-emp-embed-'))

  test(
    'ready() 加载后 embed 中文，相似句 > 无关句',
    async () => {
      const svc = createEmbeddingService({ cacheDir })
      expect(svc.isReady).toBe(false)
      await svc.ready()
      expect(svc.isReady).toBe(true)
      expect(svc.dim).toBe(512)

      const [v0, v1, v2, v3] = await svc.embed([
        '我想要一份关于 React 的前端开发文档',
        '帮我写一篇 React 组件开发教程',
        '今天天气怎么样',
        '今天会下雨吗',
      ])

      expect(v0).toBeInstanceOf(Float32Array)
      expect(v0!.length).toBe(512)

      const simSameA = cosineSimilarity(v0!, v1!)
      const simSameB = cosineSimilarity(v2!, v3!)
      const simCross = cosineSimilarity(v0!, v2!)
      expect(simSameA).toBeGreaterThan(simCross + 0.2)
      expect(simSameB).toBeGreaterThan(simCross + 0.2)
    },
    { timeout: 120_000 },
  )

  test('空数组返回空', async () => {
    const svc = createEmbeddingService({ cacheDir })
    await svc.ready()
    const out = await svc.embed([])
    expect(out).toEqual([])
  })

  test('cosineSimilarity 边界', () => {
    const a = new Float32Array([1, 0, 0])
    const b = new Float32Array([0, 1, 0])
    const c = new Float32Array([1, 0, 0])
    expect(cosineSimilarity(a, c)).toBeCloseTo(1, 5)
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5)
  })
})
