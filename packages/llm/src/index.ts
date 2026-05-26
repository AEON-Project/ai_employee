/**
 * @ai-emp/llm — Provider 适配层。
 * 抽象见 ./types.ts；实现见 ./providers/{anthropic,openai-compat}.ts。
 */

import type { CreateClientOptions, LLMClient } from './types.js'
import { createAnthropicClient } from './providers/anthropic.js'
import { createOpenAICompatClient } from './providers/openai-compat.js'

export * from './types.js'
export { createAnthropicClient } from './providers/anthropic.js'
export { createOpenAICompatClient } from './providers/openai-compat.js'

/** 按 provider 字段调度到具体 adapter */
export function createLLMClient(opts: CreateClientOptions): LLMClient {
  switch (opts.provider) {
    case 'anthropic':
      return createAnthropicClient(opts)
    case 'openai-compat':
      return createOpenAICompatClient(opts)
    default: {
      const _: never = opts.provider
      throw new Error(`Unsupported provider: ${String(_)}`)
    }
  }
}
