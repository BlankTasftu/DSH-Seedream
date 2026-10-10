/**
 * 计价表：把方舟返回的「张数 + 输出像素」折算成费用估算。
 *
 * 为什么是「估算」而不是账单：
 * - 计费口径已确认是**按返回张数**（`usage.generated_images`，含组图/图层等一张一张算），
 *   这一半是权威事实，插件如实记录；
 * - 但**单价**随模型与分辨率档变化，只在方舟控制台可见，API 不返回。因此单价做成
 *   可配置项（内置默认为 null = 未配置），金额永远是「按当前价表的估算」，不是官方账单。
 *
 * 价格来源优先级：插件配置（profile） > 价格文件（prices.json） > 内置默认（null）。
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { SeedreamError, describeError } from './errors.js'
import { dshHome } from './config.js'

/** 单张高清档的像素阈值：超过此像素数按高价档计价（方舟 5.0 系列文档口径 261 万像素）。 */
export const DEFAULT_HIGH_PIXEL_THRESHOLD = 2_610_000

/** 内置默认价表：单价一律为 null —— 未配置就不猜数字，报告里如实标注「单价未配置」。 */
export const DEFAULT_PRICES = Object.freeze({
  currency: 'CNY',
  highPixelThreshold: DEFAULT_HIGH_PIXEL_THRESHOLD,
  models: Object.freeze({
    'doubao-seedream-5-0-flash-260915': Object.freeze({ pricePerImage: null, pricePerImageHigh: null }),
    'doubao-seedream-5-0-pro-260628': Object.freeze({ pricePerImage: null, pricePerImageHigh: null }),
  }),
})

/** 价格文件默认路径。 */
export function defaultPriceFilePath() {
  return join(dshHome(), 'seedream', 'prices.json')
}

/** 价格文件路径（配置优先）。 */
export function priceFilePathOf(config) {
  return config.priceFilePath !== '' ? config.priceFilePath : defaultPriceFilePath()
}

/** 把「空 / 0 / 非数」一律当作未配置。 */
function asPrice(value) {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed
}

/** 读取价格文件；不存在或损坏时返回 undefined（不阻断生成）。 */
export async function readPriceFile(path) {
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined
    throw new SeedreamError('PRICE_FILE_ERROR', `读取价格文件 ${path} 失败：${describeError(error)}`, { cause: error })
  }
}

/** 原子写入价格文件。 */
export async function writePriceFile(path, document) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
  return path
}

/**
 * 组装生效价表。
 * @param {{ config: Record<string, any>, modelIds: Record<string, string> }} options
 */
export async function loadPrices(options) {
  const table = {
    currency: DEFAULT_PRICES.currency,
    highPixelThreshold: DEFAULT_PRICES.highPixelThreshold,
    models: {},
    sources: [],
    note: undefined,
  }
  const modelIds = options.modelIds ?? {}

  // 内置默认
  for (const [id, entry] of Object.entries(DEFAULT_PRICES.models)) {
    table.models[id] = { pricePerImage: entry.pricePerImage, pricePerImageHigh: entry.pricePerImageHigh }
  }

  // 价格文件
  const pricePath = priceFilePathOf(options.config)
  const file = await readPriceFile(pricePath)
  if (file !== undefined) {
    if (typeof file.currency === 'string' && file.currency.trim() !== '') table.currency = file.currency.trim()
    if (typeof file.note === 'string' && file.note.trim() !== '') table.note = file.note.trim()
    const threshold = asPrice(file.highPixelThreshold)
    if (threshold !== null) table.highPixelThreshold = threshold
    if (file.models !== null && typeof file.models === 'object') {
      for (const [id, entry] of Object.entries(file.models)) {
        if (entry === null || typeof entry !== 'object') continue
        table.models[id] = { pricePerImage: asPrice(entry.pricePerImage), pricePerImageHigh: asPrice(entry.pricePerImageHigh) }
      }
    }
    table.sources.push(pricePath)
  }

  // 插件配置（最高优先级）
  const config = options.config
  if (typeof config.priceCurrency === 'string' && config.priceCurrency.trim() !== '') {
    table.currency = config.priceCurrency.trim()
  }
  const configThreshold = asPrice(config.priceHighPixelThreshold)
  if (configThreshold !== null) table.highPixelThreshold = configThreshold
  const configMap = [
    [modelIds['5.0'], config.price5, config.price5High],
    [modelIds['5.0-pro'], config.price5Pro, config.price5ProHigh],
  ]
  for (const [modelId, base, high] of configMap) {
    if (typeof modelId !== 'string' || modelId === '') continue
    const baseValue = asPrice(base)
    const highValue = asPrice(high)
    if (baseValue === null && highValue === null) continue
    table.models[modelId] = { pricePerImage: baseValue, pricePerImageHigh: highValue }
    table.sources.push('plugin config')
  }
  table.sources = [...new Set(table.sources)]
  return table
}

/**
 * 单张价格：像素数超过阈值走高價档，未配置则返回 null。
 * @returns {{ price: number|null, band: 'base'|'high' }}
 */
export function priceForImage(table, modelId, pixels) {
  const entry = table.models[modelId]
  const high = typeof pixels === 'number' && pixels > table.highPixelThreshold
  if (entry === undefined) return { price: null, band: high ? 'high' : 'base' }
  const price = high ? (entry.pricePerImageHigh ?? entry.pricePerImage) : entry.pricePerImage
  return { price: price ?? null, band: high ? 'high' : 'base' }
}

/**
 * 估算一次调用的费用。
 * @param {Array<{ width?: number, height?: number }>} images 本次落盘的图片（用于取像素数）。
 * @param {number} generatedImages 方舟回报的计费张数（权威事实）。
 */
export function estimateCost(table, modelId, images, generatedImages) {
  const pixels = images
    .map((image) => (typeof image.width === 'number' && typeof image.height === 'number' ? image.width * image.height : undefined))
    .filter((value) => typeof value === 'number')
  const billed = Number.isFinite(generatedImages) && generatedImages > 0 ? generatedImages : Math.max(images.length, 1)
  const bands = pixels.length > 0 ? pixels : new Array(billed).fill(undefined)
  let cost = 0
  let priced = 0
  let unpriced = 0
  const unitPrices = []
  for (const value of bands) {
    const { price } = priceForImage(table, modelId, value)
    if (price === null) {
      unpriced += 1
      unitPrices.push(null)
      continue
    }
    cost += price
    priced += 1
    unitPrices.push(price)
  }
  // 方舟回报张数多于本地落盘图（例如部分失败）时，多出的按基准档估价。
  for (let index = bands.length; index < billed; index += 1) {
    const { price } = priceForImage(table, modelId, undefined)
    if (price === null) {
      unpriced += 1
      unitPrices.push(null)
      continue
    }
    cost += price
    priced += 1
    unitPrices.push(price)
  }
  return {
    currency: table.currency,
    billed,
    cost: priced > 0 ? Number(cost.toFixed(6)) : null,
    priced,
    unpriced,
    unitPrices,
    estimated: unpriced > 0,
  }
}

/** 金额展示：CNY 用 ¥，其它币种带前缀；常规金额 2 位小数，极小金额 4 位。 */
export function formatMoney(amount, currency) {
  if (amount === null || amount === undefined) return '—'
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : `${currency} `
  return `${symbol}${amount.toFixed(amount < 0.1 ? 4 : 2)}`
}

/** 价表的人话摘要（用于状态与报告）。 */
export function describePriceTable(table, tierMap) {
  const lines = []
  for (const [tier, modelId] of Object.entries(tierMap ?? {})) {
    const entry = table.models[modelId]
    if (entry === undefined || (entry.pricePerImage === null && entry.pricePerImageHigh === null)) {
      lines.push(`${tier}: 单价未配置`)
      continue
    }
    if (entry.pricePerImage === null) {
      lines.push(`${tier}: 基准档未配置，超过 ${table.highPixelThreshold} 像素 ${formatMoney(entry.pricePerImageHigh, table.currency)}/张`)
      continue
    }
    const base = `${formatMoney(entry.pricePerImage, table.currency)}/张`
    lines.push(
      entry.pricePerImageHigh === null
        ? `${tier}: ${base}（高清档未单独配置，按同价计）`
        : `${tier}: ${base}，超过 ${table.highPixelThreshold} 像素 ${formatMoney(entry.pricePerImageHigh, table.currency)}/张`,
    )
  }
  return lines
}
