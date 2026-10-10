/**
 * 插件配置：纯 JS 默认值与归一化（不依赖 schemastery，便于 CLI 与测试直接引用）。
 * `lib/schema.js` 用 schemastery 声明同一套字段，供 DSH 配置面板与 loader 校验。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { SeedreamError } from './errors.js'
import { TIERS, TIER_KEYS } from './models.js'

/**
 * 默认配置。任何一项都可以在 profile 的 cordis.patch.yml 里覆盖。
 * 模型 ID 用扁平字段而不是嵌套表：schemastery 的对象 schema 会丢弃未声明的键，
 * 扁平字符串字段能让 DSH 配置面板与 YAML 编辑两条路径行为一致。
 */
export const DEFAULTS = Object.freeze({
  /** 凭据引用名（环境变量名）：进程环境 / .env / DSH 凭据库都可以提供它。 */
  apiKeyEnv: 'ARK_API_KEY',
  /** DPAPI 金库文件路径；留空表示 `<DSH_HOME>/seedream/ark-key.vault.json`。 */
  vaultPath: '',
  /** 方舟网关（国内站）。国际站为 https://ark.ap-southeast.bytepluses.com/api/v3 */
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  /** 未指定档位时的默认生成档位。 */
  defaultModel: '5.0-pro',
  /** 编辑默认档位（Seedream 5.0 Pro 的指令编辑能力最强）。 */
  editModel: '5.0-pro',
  /** 档位 → Model ID 覆盖（留空即用 lib/models.js 的默认值）。 */
  model5: TIERS['5.0'].defaultId,
  model5Pro: TIERS['5.0-pro'].defaultId,
  /** 生成物落盘目录（相对会话工作目录）。 */
  outputDir: 'images/seedream',
  /** 是否允许 outputDir / 参考图逃出会话工作目录。 */
  allowOutsideCwd: false,
  /** 同步生成长请求超时（毫秒）。 */
  requestTimeoutMs: 300_000,
  /** 429 限流退避重试次数。 */
  rateLimitRetries: 2,
  /** 429 退避间隔（毫秒）。 */
  rateLimitBackoffMs: 15_000,
  /** 默认是否加「AI 生成」水印；素材默认关闭。 */
  watermark: false,
  /** 单次工具调用最多产出张数。 */
  maxImagesPerCall: 4,
  /** PowerShell 可执行文件路径；留空则自动探测（pwsh → DSH 自带 pwsh）。 */
  powershellPath: '',
  /** 是否注册一段系统提示，让模型知道可以用 Seedream 生成图片。 */
  promptSection: true,
  /** 用量台账（JSONL）路径；留空表示 `<DSH_HOME>/seedream/usage.jsonl`。 */
  ledgerPath: '',
  /** 价格文件路径；留空表示 `<DSH_HOME>/seedream/prices.json`。 */
  priceFilePath: '',
  /** 计价币种（仅用于展示）。 */
  priceCurrency: 'CNY',
  /** 单价（元/张）。0 或留空 = 未配置，费用显示为「单价未配置」。 */
  price5: '',
  price5High: '',
  price5Pro: '',
  price5ProHigh: '',
  /** 高清档像素阈值：单张像素数超过它时使用「高价档」单价。 */
  priceHighPixelThreshold: 2_610_000,
  /** 客户端计费徽标位置：bottom-left / bottom-right / top-left / top-right。 */
  uiBadgePosition: 'bottom-left',
  /**
   * 是否在界面显示 Key 指纹（首尾各 4 字符 + 字符数 + sha256 前 8 位）。
   * 指纹不可逆、不含完整明文，仅用于辨认「当前配的是哪一把」；不需要就设 false，
   * 界面只显示「已配置 / 未配置」，也不会为它解密。
   */
  uiKeyHint: true,
  // —— 可用余额 ——
  /** 费用中心 AK/SK 金库路径；留空表示 `<DSH_HOME>/seedream/billing.vault.json`。 */
  billingVaultPath: '',
  /** 费用中心 OpenAPI 所在地域与主机（一般不用改）。 */
  billingRegion: 'cn-north-1',
  billingHost: 'billing.volcengineapi.com',
  /** 余额查询超时与缓存秒数（界面每 5 秒轮询，绝不能每次都打费用中心）。 */
  billingTimeoutMs: 15_000,
  billingCacheSeconds: 600,
  /** 本地预算：已充值总额（元）与起始日期；0 / 空 = 未设置（也可写在 budget.json 里）。 */
  budgetTotal: 0,
  budgetSince: '',
  /** 预算文件路径；留空表示 `<DSH_HOME>/seedream/budget.json`。 */
  budgetFilePath: '',
})

/** DSH 家目录：环境变量优先，其次 `~/.dsh`。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** 默认金库路径。 */
export function defaultVaultPath() {
  return join(dshHome(), 'seedream', 'ark-key.vault.json')
}

function asPositiveInt(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new SeedreamError('INVALID_ARGUMENT', `配置 ${label} 必须是正整数，收到 ${JSON.stringify(value)}`)
  }
  return parsed
}

function asBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return Boolean(value)
}

function asString(value, fallback) {
  if (value === undefined || value === null) return fallback
  const text = String(value).trim()
  return text === '' ? fallback : text
}

/** 可选数值：空串 / 0 / 负数 / 非数一律视为「未配置」（null）。 */
function asOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed
}

function asTier(value, fallback, label) {
  const tier = asString(value, fallback)
  if (!TIER_KEYS.includes(tier)) {
    throw new SeedreamError('INVALID_ARGUMENT', `配置 ${label} 必须是 ${TIER_KEYS.join('、')} 之一，收到 ${JSON.stringify(value)}`)
  }
  return tier
}

/**
 * 把 loader 传入的原始配置归一为完整配置对象。
 * @param {Record<string, unknown>|undefined} raw
 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const baseUrl = asString(input.baseUrl, DEFAULTS.baseUrl).replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new SeedreamError('INVALID_ARGUMENT', `配置 baseUrl 必须是 http(s) 地址，收到 ${JSON.stringify(baseUrl)}`)
  }
  const model5 = asString(input.model5, DEFAULTS.model5)
  const model5Pro = asString(input.model5Pro, DEFAULTS.model5Pro)
  return {
    apiKeyEnv: asString(input.apiKeyEnv, DEFAULTS.apiKeyEnv),
    vaultPath: asString(input.vaultPath, DEFAULTS.vaultPath),
    baseUrl,
    defaultModel: asTier(input.defaultModel, DEFAULTS.defaultModel, 'defaultModel'),
    editModel: asTier(input.editModel, DEFAULTS.editModel, 'editModel'),
    models: { '5.0': model5, '5.0-pro': model5Pro },
    outputDir: asString(input.outputDir, DEFAULTS.outputDir),
    allowOutsideCwd: asBoolean(input.allowOutsideCwd, DEFAULTS.allowOutsideCwd),
    requestTimeoutMs: asPositiveInt(input.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 'requestTimeoutMs'),
    rateLimitRetries: asPositiveInt(input.rateLimitRetries, DEFAULTS.rateLimitRetries, 'rateLimitRetries'),
    rateLimitBackoffMs: asPositiveInt(input.rateLimitBackoffMs, DEFAULTS.rateLimitBackoffMs, 'rateLimitBackoffMs'),
    watermark: asBoolean(input.watermark, DEFAULTS.watermark),
    maxImagesPerCall: Math.min(15, asPositiveInt(input.maxImagesPerCall, DEFAULTS.maxImagesPerCall, 'maxImagesPerCall')),
    powershellPath: asString(input.powershellPath, DEFAULTS.powershellPath),
    promptSection: asBoolean(input.promptSection, DEFAULTS.promptSection),
    ledgerPath: asString(input.ledgerPath, DEFAULTS.ledgerPath),
    priceFilePath: asString(input.priceFilePath, DEFAULTS.priceFilePath),
    priceCurrency: asString(input.priceCurrency, DEFAULTS.priceCurrency),
    price5: asOptionalNumber(input.price5),
    price5High: asOptionalNumber(input.price5High),
    price5Pro: asOptionalNumber(input.price5Pro),
    price5ProHigh: asOptionalNumber(input.price5ProHigh),
    priceHighPixelThreshold:
      asOptionalNumber(input.priceHighPixelThreshold) ?? DEFAULTS.priceHighPixelThreshold,
    uiBadgePosition: ['bottom-left', 'bottom-right', 'top-left', 'top-right'].includes(String(input.uiBadgePosition ?? ''))
      ? String(input.uiBadgePosition)
      : DEFAULTS.uiBadgePosition,
    uiKeyHint: asBoolean(input.uiKeyHint, DEFAULTS.uiKeyHint),
    billingVaultPath: asString(input.billingVaultPath, DEFAULTS.billingVaultPath),
    billingRegion: asString(input.billingRegion, DEFAULTS.billingRegion),
    billingHost: asString(input.billingHost, DEFAULTS.billingHost),
    billingTimeoutMs: asPositiveInt(input.billingTimeoutMs, DEFAULTS.billingTimeoutMs, 'billingTimeoutMs'),
    billingCacheSeconds: asPositiveInt(input.billingCacheSeconds, DEFAULTS.billingCacheSeconds, 'billingCacheSeconds'),
    budgetTotal: asOptionalNumber(input.budgetTotal) ?? DEFAULTS.budgetTotal,
    budgetSince: asString(input.budgetSince, DEFAULTS.budgetSince),
    budgetFilePath: asString(input.budgetFilePath, DEFAULTS.budgetFilePath),
  }
}

/** 金库文件的实际路径。 */
export function vaultPathOf(config) {
  return config.vaultPath !== '' ? config.vaultPath : defaultVaultPath()
}
