/**
 * Seedream 插件的统一错误类型。
 *
 * 每个失败都带一个稳定的 `code`，让工具层能按类别给出可操作的提示，
 * 而不是把网关原始报文直接抛给模型。
 */

/** @typedef {'MISSING_CREDENTIAL'|'AUTH_FAILED'|'MODEL_UNAVAILABLE'|'INVALID_ARGUMENT'|'INVALID_PARAMETER'|'SENSITIVE_CONTENT'|'RATE_LIMITED'|'TIMEOUT'|'NETWORK_ERROR'|'HTTP_ERROR'|'BAD_RESPONSE'|'DOWNLOAD_FAILED'|'IO_ERROR'|'NO_ATTACHMENTS'|'POWERSHELL_MISSING'|'VAULT_ERROR'} SeedreamErrorCode */

export class SeedreamError extends Error {
  /**
   * @param {SeedreamErrorCode} code stable machine-readable failure class.
   * @param {string} message operator-facing explanation.
   * @param {{ cause?: unknown, detail?: Record<string, unknown> }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'SeedreamError'
    this.code = code
    if (options.detail !== undefined) this.detail = options.detail
  }
}

/** Non-throwing classifier used by callers that only branch on failure class. */
export function isSeedreamError(error) {
  return error instanceof SeedreamError
}

/** Render a bounded, secret-free description of an unknown thrown value. */
export function describeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

/**
 * 兜底擦除：任何要展示或落日志的文本在出口前过一遍，防止「上游异常消息里夹带凭据」
 * 这类意外泄露（方舟 Key 形如 `ark-<hex>-<hex>`，这里按形态匹配）。
 * @param {unknown} text 待擦除文本。
 */
export function redactSecrets(text) {
  return String(text ?? '').replace(/\bark-[A-Za-z0-9._-]{6,}/gi, 'ark-***REDACTED***')
}
