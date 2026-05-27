/**
 * env:// 引用协议 — 让 DB 字段可以指向环境变量而不是写死值。
 *
 * 使用场景：
 *   - 员工 `modelKeyRef`     = "env://AIEMP_ANTHROPIC_API_KEY"
 *   - 员工 `modelName`       = "env://AIEMP_ANTHROPIC_MODEL"
 *   - 员工 `modelBaseUrl`    = "env://AIEMP_OPENAI_BASE_URL"
 *
 * 开发期：把值写 .env，员工字段固定为 env:// 引用，切环境只改 .env。
 * 生产期：要么把值写 keychain（modelKeyRef）/写死员工字段（其他），都行。
 */

export const ENV_REF_PREFIX = 'env://'

export function isEnvRef(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(ENV_REF_PREFIX)
}

/**
 * 解析 env:// 引用；非引用直接返回原值。
 * env 变量不存在时返回 null（调用方决定降级或抛错）。
 */
export function resolveEnvRef(value: string | null | undefined): string | null {
  if (!value) return null
  if (!isEnvRef(value)) return value
  const name = value.slice(ENV_REF_PREFIX.length)
  const v = process.env[name]
  return v && v.length > 0 ? v : null
}

/**
 * 严格版：env 变量缺失时抛错。
 * 用于不可缺的字段（modelName / modelKeyRef）。
 *
 * @param value  原字段值（可能是 env://... 或字面值）
 * @param label  字段名（错误消息里展示）
 */
export function resolveEnvRefStrict(value: string, label: string): string {
  if (!isEnvRef(value)) return value
  const name = value.slice(ENV_REF_PREFIX.length)
  const v = process.env[name]
  if (!v || v.length === 0) {
    throw new Error(
      `${label} references env var "${name}" (env://${name}), but it is not set or empty.`,
    )
  }
  return v
}
