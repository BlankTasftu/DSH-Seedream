/**
 * 模型档位注册表：把「5.0-pro / 5.0-flash」两个已开通档位映射到方舟 Model ID，
 * 并携带各档位的能力矩阵（画幅档位、显式像素域、参考图上限、组图能力）。
 *
 * 档位名与真实 Model ID 对齐（`doubao-seedream-5-0-flash-260915` / `...-pro-260628`），
 * 避免出现「5.0 到底是哪个」的歧义；`5.0` 作为历史别名继续可用（见 TIER_ALIASES）。
 *
 * 事实来源：火山方舟「图片生成 API」文档 + 2026-10 实测复核。
 * 所有 Model ID 都可由插件配置覆盖，但档位枚举固定为账号已开通的两个。
 */

import { SeedreamError } from './errors.js'

/** 档位 → 能力矩阵。`defaultId` 为下发的 Model ID，可被配置覆盖。 */
export const TIERS = Object.freeze({
  '5.0-pro': Object.freeze({
    key: '5.0-pro',
    alias: 'Seedream 5.0 Pro',
    defaultId: 'doubao-seedream-5-0-pro-260628',
    presets: Object.freeze(['1K', '2K']),
    minPixels: 1280 * 720,
    maxPixels: 2048 * 2048,
    multipleOf: 16,
    maxReferences: 10,
    sequential: false,
    outputFormat: true,
    stream: false,
    webSearch: false,
  }),
  '5.0-flash': Object.freeze({
    key: '5.0-flash',
    alias: 'Seedream 5.0 Flash',
    defaultId: 'doubao-seedream-5-0-flash-260915',
    /** 画幅档位白名单（方舟预设写法）。 */
    presets: Object.freeze(['2K', '3K', '4K']),
    /** 显式 WxH 的总像素域（含端点）。 */
    minPixels: 2560 * 1440,
    maxPixels: 4096 * 4096,
    /** 边长对齐要求；1 表示不额外约束。 */
    multipleOf: 1,
    /** 参考图张数上限。 */
    maxReferences: 14,
    /**
     * 是否支持 sequential_image_generation 组图。
     * 实测（2026-10-10）：5.0 flash 被网关明确拒绝
     * —— "the parameter `sequential_image_generation` is not supported by the current model"，
     * 因此多张走串行多次调用。
     */
    sequential: false,
    /** 是否支持 output_format。 */
    outputFormat: true,
    /** stream / tools 未在 flash 上验证，按「不支持」如实呈现，避免许下做不到的能力。 */
    stream: false,
    webSearch: false,
  }),
})

/** 允许的档位名（模型可见枚举）。 */
export const TIER_KEYS = Object.freeze(Object.keys(TIERS))

/**
 * 历史别名 → 现行档位名。
 * 早期版本把 flash 档叫 `5.0`，台账/配置/选择文件里可能还留着；统一归一到 `5.0-flash`，
 * 保证统计口径与界面显示一致。
 */
export const TIER_ALIASES = Object.freeze({ '5.0': '5.0-flash', '5.0-lite': '5.0-flash', flash: '5.0-flash', pro: '5.0-pro' })

/** 把任意写法（含历史别名）归一为现行档位名；无法识别时原样返回。 */
export function normalizeTierName(value) {
  const key = String(value ?? '').trim()
  if (key === '') return key
  if (TIER_KEYS.includes(key)) return key
  return TIER_ALIASES[key.toLowerCase()] ?? key
}

/** 宽高比上下界（方舟统一约束）。 */
const MAX_ASPECT = 16

/**
 * 解析档位，返回档位定义与最终下发的 Model ID。
 * @param {string|undefined} requested 档位名；缺省用配置的默认档位。
 * @param {Record<string, string>} modelIds 档位 → Model ID 覆盖表。
 * @param {string} fallbackTier 未指定时的档位。
 */
export function resolveTier(requested, modelIds, fallbackTier) {
  const key = normalizeTierName((requested ?? '').trim()) || normalizeTierName(fallbackTier)
  const tier = TIERS[key]
  if (tier === undefined) {
    throw new SeedreamError(
      'INVALID_ARGUMENT',
      `未知模型档位 ${JSON.stringify(requested)}；可用档位：${TIER_KEYS.join('、')}`,
    )
  }
  const override = modelIds?.[key]
  return { tier, modelId: typeof override === 'string' && override.trim() !== '' ? override.trim() : tier.defaultId }
}

/**
 * 把请求的画幅归一为方舟接受的写法。
 *
 * 两条互斥路线：档位（1K/2K/3K/4K）与显式 `宽x高`。显式值会被钳制进该档位的
 * 合法像素域（低于下限等比放大、超出上界等比缩小、按需对齐到 16 的倍数），
 * 钳制不可达时如实拒绝而不是把非法值丢给网关。
 *
 * @param {string|undefined} requested 画幅；缺省取档位首选预设。
 * @param {typeof TIERS[string]} tier 档位能力矩阵。
 * @returns {{ value: string, pixels?: number, adjusted: boolean }}
 */
export function normalizeSize(requested, tier) {
  const raw = (requested ?? '').trim()
  if (raw === '') {
    const preferred = tier.presets.includes('2K') ? '2K' : tier.presets[0]
    return { value: preferred, adjusted: false }
  }
  const upper = raw.toUpperCase()
  if (/^\d+K$/.test(upper)) {
    if (!tier.presets.includes(upper)) {
      throw new SeedreamError(
        'INVALID_ARGUMENT',
        `档位 ${upper} 不被 ${tier.alias} 支持；该档位可用：${tier.presets.join('、')}，也可用显式「宽x高」`,
      )
    }
    return { value: upper, adjusted: upper !== raw }
  }
  const match = /^(\d+)\s*[x*×]\s*(\d+)$/.exec(raw)
  if (match === null) {
    throw new SeedreamError(
      'INVALID_ARGUMENT',
      `画幅 ${JSON.stringify(raw)} 不是方舟接受的格式：请用档位（${tier.presets.join('/')}）或显式「宽x高」，例如 2048x2048`,
    )
  }
  const requestedWidth = Number(match[1])
  const requestedHeight = Number(match[2])
  if (requestedWidth <= 0 || requestedHeight <= 0) {
    throw new SeedreamError('INVALID_ARGUMENT', `画幅 ${raw} 的宽高必须是正整数`)
  }
  const short = Math.min(requestedWidth, requestedHeight)
  const long = Math.max(requestedWidth, requestedHeight)
  if (long / short > MAX_ASPECT) {
    throw new SeedreamError(
      'INVALID_ARGUMENT',
      `画幅 ${raw} 的宽高比超出方舟允许范围 [1/${MAX_ASPECT}, ${MAX_ASPECT}]`,
    )
  }
  let width = requestedWidth
  let height = requestedHeight
  if (width * height < tier.minPixels) {
    const scale = Math.sqrt(tier.minPixels / (width * height))
    width = Math.ceil((width * scale) / tier.multipleOf) * tier.multipleOf
    height = Math.ceil((height * scale) / tier.multipleOf) * tier.multipleOf
  }
  if (width * height > tier.maxPixels) {
    const scale = Math.sqrt(tier.maxPixels / (width * height))
    width = Math.floor((width * scale) / tier.multipleOf) * tier.multipleOf
    height = Math.floor((height * scale) / tier.multipleOf) * tier.multipleOf
  }
  if (width < 1 || height < 1 || width * height < tier.minPixels || width * height > tier.maxPixels) {
    throw new SeedreamError(
      'INVALID_ARGUMENT',
      `画幅 ${raw} 无法被调整进 ${tier.alias} 的合法域（总像素 ${tier.minPixels}–${tier.maxPixels}，宽高比 [1/${MAX_ASPECT}, ${MAX_ASPECT}]，边长对齐 ${tier.multipleOf}）`,
    )
  }
  const value = `${width}x${height}`
  return { value, pixels: width * height, adjusted: value !== raw.replace(/\s*[×*]\s*/g, 'x') }
}

/** 人类可读的档位能力摘要，供 seedream_status 与 CLI 复用。 */
export function describeTiers(modelIds) {
  return TIER_KEYS.map((key) => {
    const tier = TIERS[key]
    const modelId = modelIds?.[key]?.trim() || tier.defaultId
    return {
      tier: key,
      alias: tier.alias,
      modelId,
      presets: [...tier.presets],
      pixelRange: [tier.minPixels, tier.maxPixels],
      multipleOf: tier.multipleOf,
      maxReferences: tier.maxReferences,
      sequential: tier.sequential,
      outputFormat: tier.outputFormat,
      webSearch: tier.webSearch,
    }
  })
}
