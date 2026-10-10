/**
 * 火山方舟（Volcengine Ark）图像生成客户端。
 *
 * 关键事实（官方文档 + 2026-08 实测复核）：
 * - 单一端点 `POST {baseUrl}/images/generations`，文生图 / 参考图 I2I / 指令编辑共用；
 *   方舟没有 `/images/edits`，也没有 mask 局部重绘能力。
 * - 认证只有一个头：`Authorization: Bearer <API Key>`。
 * - 同步返回：`data[].url`（24 小时失效，需立刻下载）或 `data[].b64_json`。
 * - `model` 既可直接填 Model ID，也可填接入点 ID（ep-xxxx）。
 * - 组图（`sequential_image_generation: auto`）仅 Lite/4.x 支持，5.0 Pro 不支持。
 */

import { SeedreamError, describeError, redactSecrets } from './errors.js'

/** 网关错误码 → 插件错误码的判定。 */
function classifyFailure(status, code, message) {
  const haystack = `${code} ${message}`
  if (status === 401 || code === 'AuthenticationError' || status === 403 || code === 'AccessDenied') {
    return 'AUTH_FAILED'
  }
  if (
    status === 404 ||
    /InvalidEndpointOrModel|ModelNotFound|ModelNotOpen|does not exist|not found|not activated|未开通|不存在/i.test(haystack)
  ) {
    return 'MODEL_UNAVAILABLE'
  }
  if (/SensitiveContentDetected|OutputImageSensitiveContentDetected/i.test(haystack)) return 'SENSITIVE_CONTENT'
  if (status === 429 || /RateLimit|RequestBurstTooFast|SetLimitExceeded/i.test(haystack)) return 'RATE_LIMITED'
  if (status === 400 || code === 'InvalidParameter' || code === 'MissingParameter') return 'INVALID_PARAMETER'
  return 'HTTP_ERROR'
}

/** 方舟错误字段是任意 JSON 值：安全序列化，避免 [object Object] 掩盖真实原因。 */
function textOf(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

/** 从响应体提取 { code, message }：兼容 error.code 与顶层 code 两种包裹。 */
function parseErrorBody(data) {
  const error = data !== null && typeof data === 'object' && data.error !== null && typeof data.error === 'object' ? data.error : undefined
  const code = [error?.code, data?.code].find((value) => typeof value === 'string' && value !== '')
  const message = [error?.message, data?.message].find((value) => typeof value === 'string' && value !== '')
  return { code: code ?? '', message: message ?? '' }
}

/** 可取消延时（限流退避的唯一等待点）。 */
function delay(ms, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(new SeedreamError('TIMEOUT', '调用方已取消'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      rejectPromise(new SeedreamError('TIMEOUT', '调用方已取消'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise(undefined)
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class ArkClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl 网关基础地址（含 /api/v3）。
   * @param {number} options.timeoutMs 单次同步请求超时。
   * @param {number} options.rateLimitRetries 429 重试次数。
   * @param {number} options.rateLimitBackoffMs 429 退避间隔。
   * @param {(level: string, message: string) => void} [options.log] 日志出口。
   */
  constructor(options) {
    this.baseUrl = options.baseUrl
    this.timeoutMs = options.timeoutMs
    this.rateLimitRetries = options.rateLimitRetries
    this.rateLimitBackoffMs = options.rateLimitBackoffMs
    this.log = options.log ?? (() => {})
  }

  /**
   * 发起一次图像生成请求。
   * @param {Record<string, unknown>} body 方舟请求体。
   * @param {string} apiKey 明文 Key（仅用于本次请求头）。
   * @param {AbortSignal|undefined} signal 调用方取消信号。
   */
  async request(body, apiKey, signal) {
    let last = { status: 0, data: {} }
    for (let attempt = 0; ; attempt += 1) {
      last = await this.postJson('/images/generations', body, apiKey, signal)
      if (last.status !== 429){
        break
      }
      if (attempt >= this.rateLimitRetries) {
        const parsed = parseErrorBody(last.data)
        throw new SeedreamError('RATE_LIMITED', `方舟限流（HTTP 429${parsed.code === '' ? '' : ` ${parsed.code}`}）：${parsed.message || '已达账号/接入点配额'}。稍后重试或减少张数。`)
      }
      this.log('warn', `dsh-seedream: 命中方舟限流，${this.rateLimitBackoffMs}ms 后重试（第 ${attempt + 1}/${this.rateLimitRetries} 次）`)
      await delay(this.rateLimitBackoffMs, signal)
    }
    if (last.status < 200 || last.status >= 300) {
      const parsed = parseErrorBody(last.data)
      const code = classifyFailure(last.status, parsed.code, parsed.message)
      throw new SeedreamError(
        code,
        `方舟返回 HTTP ${last.status}${parsed.code === '' ? '' : ` (${parsed.code})`}：${parsed.message || textOf(last.data).slice(0, 400) || '无响应体'}`,
      )
    }
    const model = typeof last.data.model === 'string' && last.data.model.trim() !== '' ? last.data.model.trim() : String(body.model)
    const entries = Array.isArray(last.data.data) ? last.data.data : []
    const images = []
    const failures = []
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.error === 'object' && entry.error !== null) {
        failures.push({ code: String(entry.error.code ?? ''), message: String(entry.error.message ?? '') })
        continue
      }
      if (typeof entry.url === 'string' && entry.url !== '') images.push({ url: entry.url, size: typeof entry.size === 'string' ? entry.size : undefined })
      else if (typeof entry.b64_json === 'string' && entry.b64_json !== '') images.push({ base64: entry.b64_json, size: typeof entry.size === 'string' ? entry.size : undefined })
    }
    if (images.length === 0) {
      const first = failures[0]
      if (first !== undefined) {
        throw new SeedreamError(
          classifyFailure(200, first.code, first.message),
          `方舟生成失败（${first.code || 'unknown'}）：${first.message || '未给出原因'}`,
        )
      }
      throw new SeedreamError('BAD_RESPONSE', `方舟响应成功但缺少 data[].url 图片结果：${textOf(last.data).slice(0, 300)}`)
    }
    return { status: last.status, model, images, failures, usage: last.data.usage }
  }

  async postJson(path, body, apiKey, signal) {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let response
    let text
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: combined,
      })
      text = await response.text()
    } catch (error) {
      if (signal?.aborted) throw new SeedreamError('TIMEOUT', '调用方已取消本次生成')
      const name = error instanceof Error ? error.name : ''
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new SeedreamError('TIMEOUT', `生成请求超过 ${this.timeoutMs}ms 未返回：方舟是同步接口，可调大 requestTimeoutMs 或减少张数`)
      }
      if (error instanceof TypeError) {
        throw new SeedreamError('NETWORK_ERROR', `连接方舟网关失败：${redactSecrets(error.message)}`, { cause: error })
      }
      // 传输层之外的非预期异常原样上抛（不冒充网络错误），但先把可能夹带凭据的文本擦掉
      if (error instanceof Error) error.message = redactSecrets(error.message)
      throw error
    }
    let data
    try {
      data = JSON.parse(text)
    } catch {
      data = { message: text.slice(0, 400) }
    }
    if (data === null || typeof data !== 'object') data = { message: String(text).slice(0, 400) }
    return { status: response.status, data }
  }

  /**
   * 下载生成结果（方舟 URL 24 小时失效，必须立即落盘）。
   * @param {string} url
   * @param {AbortSignal|undefined} signal
   */
  async download(url, signal) {
    const timeout = AbortSignal.timeout(Math.min(this.timeoutMs, 120_000))
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let response
    try {
      response = await fetch(url, { redirect: 'follow', signal: combined })
    } catch (error) {
      throw new SeedreamError('DOWNLOAD_FAILED', `下载生成图失败：${describeError(error)}`, { cause: error })
    }
    if (!response.ok) {
      throw new SeedreamError('DOWNLOAD_FAILED', `下载生成图失败：HTTP ${response.status}`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength === 0) throw new SeedreamError('DOWNLOAD_FAILED', '下载生成图失败：响应为空')
    if (buffer.byteLength > 64 * 1024 * 1024) {
      throw new SeedreamError('DOWNLOAD_FAILED', `下载生成图失败：单张超过 64MB（${buffer.byteLength} 字节）`)
    }
    return { bytes: buffer, contentType: response.headers.get('content-type') ?? undefined }
  }
}
