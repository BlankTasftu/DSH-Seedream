/**
 * 火山引擎费用中心 OpenAPI（余额查询）。
 *
 * 为什么不能直接用方舟 API Key：数据面（`ark.cn-beijing.volces.com/api/v3`）没有余额端点
 * （实测 10 个候选路径全部 404）。账户余额属于**费用中心 OpenAPI**，必须用 AK/SK 做
 * Volcengine Signature V4（HMAC-SHA256）签名。
 *
 * 本文件实现签名算法与 `QueryBalanceAcct` 调用，AK/SK 与方舟 Key 一样只存 DPAPI 密文，
 * 并且只在调用费用中心时使用（不参与任何图像请求）。
 *
 * 签名算法对齐官方 Python SDK 的 SignerV4（volcenginesdkcore/signv4.py），
 * 并有 test/signv4-crosscheck.mjs 用同一份官方算法做交叉验证。
 */

import { createHash, createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { SeedreamError, describeError, redactSecrets } from './errors.js'
import { getSecret, setSecret, clearVault, vaultStatus } from './vault.js'
import { dshHome } from './config.js'
import { join } from 'node:path'

/** 费用中心 OpenAPI 默认参数。 */
export const BILLING_DEFAULTS = Object.freeze({
  host: 'billing.volcengineapi.com',
  region: 'cn-north-1',
  service: 'billing',
  version: '2022-01-01',
  action: 'QueryBalanceAcct',
})

/** 官方 SDK 使用的环境变量名。 */
export const BILLING_ENV = Object.freeze({ accessKey: 'VOLC_ACCESSKEY', secretKey: 'VOLC_SECRETKEY' })

/** 余额类凭据的金库文件（与方舟 Key 分开存放，互不影响）。 */
export function billingVaultPathOf(config) {
  return config.billingVaultPath !== '' ? config.billingVaultPath : join(dshHome(), 'seedream', 'billing.vault.json')
}

/** RFC3986 编码（官方 signer 的 quote(safe='-_.~')）。 */
function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** 规范化查询串：按 key 再按 value 排序，逐项 RFC3986 编码。 */
export function canonicalQueryString(query) {
  const pairs = Object.entries(query).map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(String(value))])
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
  return pairs.map(([key, value]) => `${key}=${value}`).join('&')
}

function hmac(key, message) {
  return createHmac('sha256', key).update(message, 'utf8').digest()
}

/**
 * 精确擦除：把已知的 AK/SK 明文从任何待展示文本里抹掉。
 * `redactSecrets()` 只按 `ark-…` 形态匹配，覆盖不到 AK/SK 的形状，
 * 所以在费用中心这条链路上再加一层「按值擦除」——它不会误伤哈希、URL 等正常文本。
 */
function scrubCredentials(text, credentials) {
  let output = String(text ?? '')
  for (const secret of [credentials?.accessKey, credentials?.secretKey]) {
    if (typeof secret === 'string' && secret.length >= 8 && output.includes(secret)) {
      output = output.split(secret).join('***REDACTED***')
    }
  }
  return redactSecrets(output)
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 派生签名密钥：sk → date → region → service → "request"。 */
export function signingKey(secretKey, dateStamp, region, service) {
  return hmac(hmac(hmac(hmac(secretKey, dateStamp), region), service), 'request')
}

/** 把 Date 渲染成官方格式的 X-Date（UTC，`YYYYMMDDTHHMMSSZ`）。 */
export function formatXDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/**
 * 计算一次 POST 请求的签名头（纯函数，便于交叉验证与单测）。
 * @param {object} input
 * @param {string} input.accessKey
 * @param {string} input.secretKey
 * @param {string} input.host 例：billing.volcengineapi.com
 * @param {string} input.path 例：/
 * @param {string} input.method 例：POST
 * @param {Record<string,string>} input.query
 * @param {string} input.body
 * @param {string} input.contentType
 * @param {string} input.region
 * @param {string} input.service
 * @param {Date} [input.date] 便于固定时间做确定性测试
 */
export function signRequest(input) {
  const method = (input.method ?? 'POST').toUpperCase()
  const path = input.path === undefined || input.path === '' ? '/' : input.path
  const body = input.body ?? ''
  const contentType = input.contentType ?? 'application/json; charset=utf-8'
  const date = input.date ?? new Date()
  const xDate = typeof input.xDate === 'string' ? input.xDate : formatXDate(date)
  const bodyHash = sha256Hex(body)

  /** 参与签名的头：Content-Type / Content-Md5 / Host / X-*（小写）。 */
  const signedHeaders = {
    'content-type': contentType,
    host: String(input.host).replace(/:(80|443)$/, ''),
    'x-content-sha256': bodyHash,
    'x-date': xDate,
  }
  const signedHeaderNames = Object.keys(signedHeaders).sort()
  const signedStr = signedHeaderNames.map((name) => `${name}:${signedHeaders[name]}\n`).join('')
  const canonicalRequest = [
    method,
    path,
    canonicalQueryString(input.query ?? {}),
    signedStr,
    signedHeaderNames.join(';'),
    bodyHash,
  ].join('\n')

  const dateStamp = xDate.slice(0, 8)
  const credentialScope = [dateStamp, input.region, input.service, 'request'].join('/')
  const stringToSign = ['HMAC-SHA256', xDate, credentialScope, sha256Hex(canonicalRequest)].join('\n')
  const signature = createHmac('sha256', signingKey(input.secretKey, dateStamp, input.region, input.service))
    .update(stringToSign, 'utf8')
    .digest('hex')

  return {
    'Content-Type': contentType,
    Accept: 'application/json',
    'X-Date': xDate,
    'X-Content-Sha256': bodyHash,
    Authorization: `HMAC-SHA256 Credential=${input.accessKey}/${credentialScope}, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`,
  }
}

/** 从响应体里取出余额相关字段（字段可能随账号类型增减，取到多少报多少）。 */
export function extractBalance(payload) {
  const result = payload !== null && typeof payload === 'object' && payload.Result !== null && typeof payload.Result === 'object'
    ? payload.Result
    : {}
  const fields = ['AvailableBalance', 'CashBalance', 'CreditLimit', 'FreezeAmount', 'ArrearsBalance']
  const balance = {}
  for (const field of fields) {
    const value = result[field]
    if (typeof value === 'string' && value.trim() !== '') balance[field] = value.trim()
    else if (typeof value === 'number') balance[field] = String(value)
  }
  const error = payload?.ResponseMetadata?.Error
  return { balance, error: error === undefined || error === null ? undefined : { code: String(error.Code ?? ''), message: String(error.Message ?? '') } }
}

/**
 * 查询账户可用余额。
 * @param {{ accessKey: string, secretKey: string, region?: string, service?: string, host?: string, version?: string, action?: string, timeoutMs?: number, signal?: AbortSignal }} options
 */
export async function queryBalance(options) {
  const host = options.host ?? BILLING_DEFAULTS.host
  const region = options.region ?? BILLING_DEFAULTS.region
  const service = options.service ?? BILLING_DEFAULTS.service
  const query = {
    Action: options.action ?? BILLING_DEFAULTS.action,
    Version: options.version ?? BILLING_DEFAULTS.version,
  }
  const body = '{}'
  const headers = signRequest({
    accessKey: options.accessKey,
    secretKey: options.secretKey,
    host,
    path: '/',
    method: 'POST',
    query,
    body,
    region,
    service,
  })
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  let response
  let text
  const scrub = (value) => scrubCredentials(value, options)
  try {
    response = await fetch(`https://${host}/?${canonicalQueryString(query)}`, {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      signal,
    })
    text = await response.text()
  } catch (error) {
    if (options.signal?.aborted) throw new SeedreamError('TIMEOUT', '调用方已取消余额查询')
    const name = error instanceof Error ? error.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new SeedreamError('TIMEOUT', `查询余额超过 ${options.timeoutMs ?? 15_000}ms 未返回`)
    }
    throw new SeedreamError('NETWORK_ERROR', `连接费用中心失败：${scrub(describeError(error))}`, { cause: error })
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new SeedreamError('BAD_RESPONSE', `费用中心返回了非 JSON 响应（HTTP ${response.status}）：${scrub(text.slice(0, 200))}`)
  }
  if (response.status === 401 || response.status === 403) {
    throw new SeedreamError('AUTH_FAILED', `AK/SK 无效或缺少「费用中心只读」权限（HTTP ${response.status}）`)
  }
  if (!response.ok) {
    const parsed = extractBalance(payload)
    throw new SeedreamError('HTTP_ERROR', `费用中心返回 HTTP ${response.status}${parsed.error === undefined ? '' : `（${parsed.error.code}: ${parsed.error.message}）`}`)
  }
  const parsed = extractBalance(payload)
  if (parsed.error !== undefined) {
    throw new SeedreamError('HTTP_ERROR', `费用中心返回错误：${parsed.error.code} ${parsed.error.message}`)
  }
  if (Object.keys(parsed.balance).length === 0) {
    throw new SeedreamError('BAD_RESPONSE', '费用中心没有返回任何余额字段（账号可能未开通费用中心 API 权限）')
  }
  return { ...parsed.balance, fetchedAt: new Date().toISOString() }
}

/** AK/SK 的指纹：AK 首尾各 4 位，SK 只报长度（SK 是敏感的主密钥，不显示任何字符）。 */
export function billingHint(accessKey, secretKey) {
  return {
    accessKey: `${String(accessKey).slice(0, 4)}…${String(accessKey).slice(-4)}`,
    accessKeyLength: String(accessKey).length,
    secretKeyLength: String(secretKey).length,
  }
}

/**
 * 解析费用中心凭据：DPAPI 金库 → 环境变量（VOLC_ACCESSKEY / VOLC_SECRETKEY）。
 * @returns {Promise<{ accessKey: string, secretKey: string, source: string, hint?: object }|undefined>}
 */
export async function resolveBillingCredentials(options) {
  const path = billingVaultPathOf(options.config)
  const raw = await getSecret({ path, powershellPath: options.config.powershellPath })
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed?.accessKey === 'string' && typeof parsed?.secretKey === 'string' && parsed.accessKey !== '' && parsed.secretKey !== '') {
        return { accessKey: parsed.accessKey, secretKey: parsed.secretKey, source: `DPAPI 金库（${path}）`, hint: billingHint(parsed.accessKey, parsed.secretKey) }
      }
    } catch {
      throw new SeedreamError('VAULT_ERROR', `费用中心凭据金库 ${path} 内容不是预期的 JSON；请重新保存 AK/SK`)
    }
  }
  const accessKey = process.env[BILLING_ENV.accessKey]
  const secretKey = process.env[BILLING_ENV.secretKey]
  if (typeof accessKey === 'string' && accessKey !== '' && typeof secretKey === 'string' && secretKey !== '') {
    return { accessKey, secretKey, source: `环境变量 ${BILLING_ENV.accessKey} / ${BILLING_ENV.secretKey}`, hint: billingHint(accessKey, secretKey) }
  }
  return undefined
}

/** 写入 AK/SK（DPAPI 加密后落盘，SK 不落明文）。 */
export async function setBillingCredentials(accessKey, secretKey, options) {
  const ak = String(accessKey ?? '').trim()
  const sk = String(secretKey ?? '').trim()
  if (ak === '' || sk === '') throw new SeedreamError('INVALID_ARGUMENT', 'Access Key 与 Secret Key 都不能为空')
  const path = billingVaultPathOf(options.config)
  const result = await setSecret(JSON.stringify({ accessKey: ak, secretKey: sk }), { path, powershellPath: options.config.powershellPath })
  return { path: result.path, hint: billingHint(ak, sk), updatedAt: result.updatedAt }
}

/** 清除 AK/SK。 */
export async function clearBillingCredentials(options) {
  const path = billingVaultPathOf(options.config)
  await clearVault(path)
  return { path, cleared: true }
}

/** AK/SK 配置状态（不解密、不回显）。 */
export async function billingStatus(options) {
  const path = billingVaultPathOf(options.config)
  const status = await vaultStatus(path)
  return {
    configured: status.configured,
    path,
    updatedAt: status.updatedAt,
    hint: status.hint === undefined ? null : status.hint,
    environmentConfigured:
      typeof process.env[BILLING_ENV.accessKey] === 'string' && process.env[BILLING_ENV.accessKey] !== '' &&
      typeof process.env[BILLING_ENV.secretKey] === 'string' && process.env[BILLING_ENV.secretKey] !== '',
  }
}

/** 读取金库文件原始文本（仅用于测试断言「不含明文」，不对外暴露）。 */
export async function readBillingVaultRaw(options) {
  try {
    return await readFile(billingVaultPathOf(options.config), 'utf8')
  } catch {
    return undefined
  }
}
