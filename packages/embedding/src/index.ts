/**
 * @ai-emp/embedding — transformers.js + bge-small-zh-v1.5。
 *
 * 关键决策（来自 Spike 2）：
 *   - 模型 `Xenova/bge-small-zh-v1.5`，512 维输出
 *   - 首次加载会下载 ~23MB 权重到 cacheDir
 *   - 加载后 4 条文本 embed ~15ms
 *
 * sharp 平台二进制需 scripts/postinstall.ts 修复（已在 README 与 spike 记录）。
 */

import { pipeline, env, type FeatureExtractionPipeline } from '@xenova/transformers'

export interface EmbeddingService {
  /** 等待模型加载完成；首次会触发下载 */
  ready(): Promise<void>
  /** 批量编码；返回与输入同序的 Float32Array[] */
  embed(texts: string[]): Promise<Float32Array[]>
  /** 输出维度（bge-small-zh-v1.5 = 512） */
  readonly dim: number
  /** 内部用：模型加载状态 */
  readonly isReady: boolean
}

export interface CreateEmbeddingOptions {
  /** 权重缓存目录，绝对路径；默认 `~/.ai-emp/models/` */
  cacheDir?: string
  /** 模型名（默认 bge-small-zh-v1.5） */
  model?: string
  /** 禁用远程下载（仅在 cache 命中时可用） */
  allowRemoteModels?: boolean
}

const DEFAULT_MODEL = 'Xenova/bge-small-zh-v1.5'
const BGE_SMALL_DIM = 512

/**
 * 创建嵌入服务实例。
 * 调用方负责 `await svc.ready()` 后再 embed；否则首条 embed 调用会自动等待。
 */
export function createEmbeddingService(opts: CreateEmbeddingOptions = {}): EmbeddingService {
  return new TransformersEmbedding(opts)
}

class TransformersEmbedding implements EmbeddingService {
  readonly dim = BGE_SMALL_DIM
  isReady = false

  private readonly model: string
  private extractor: FeatureExtractionPipeline | null = null
  private loadingPromise: Promise<void> | null = null

  constructor(opts: CreateEmbeddingOptions) {
    this.model = opts.model ?? DEFAULT_MODEL

    if (opts.cacheDir) {
      env.cacheDir = opts.cacheDir
    } else {
      env.cacheDir = defaultCacheDir()
    }
    if (typeof opts.allowRemoteModels === 'boolean') {
      env.allowRemoteModels = opts.allowRemoteModels
    }
  }

  ready(): Promise<void> {
    if (this.isReady) return Promise.resolve()
    if (this.loadingPromise) return this.loadingPromise
    this.loadingPromise = this.load()
    return this.loadingPromise
  }

  private async load(): Promise<void> {
    this.extractor = (await pipeline('feature-extraction', this.model)) as FeatureExtractionPipeline
    this.isReady = true
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    await this.ready()
    if (!this.extractor) throw new Error('Embedding pipeline not loaded')

    const out = await this.extractor(texts, { pooling: 'mean', normalize: true })
    const dims = out.dims as number[]
    const dim = dims[dims.length - 1] ?? this.dim
    if (dim !== this.dim) {
      throw new Error(`Embedding dim mismatch: expected ${this.dim}, got ${dim}`)
    }

    // out.data 是底层 Float32Array，长度 = N*dim
    const data = out.data as Float32Array
    const result: Float32Array[] = []
    for (let i = 0; i < texts.length; i++) {
      // slice 复制一份独立 buffer；调用方对单条修改不影响其他
      result.push(data.slice(i * dim, (i + 1) * dim))
    }
    return result
  }
}

function defaultCacheDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.'
  return `${home}/.ai-emp/models`
}

/** 同义度的简便函数（余弦相似度） */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error('vector length mismatch')
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!
    const bi = b[i]!
    dot += ai * bi
    na += ai * ai
    nb += bi * bi
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
