/**
 * 用量视图：把「台账 + 价表 + 档位映射」组装成一个自描述对象，
 * 既作为 `seedream_usage` 工具的结构化返回值，也是 CLI `usage` 的数据源。
 * 渲染由 `lib/ledger.js` 的 renderUsageView 完成（纯函数，读写分离）。
 */

import { SeedreamError } from './errors.js'
import { TIER_KEYS } from './models.js'
import { describePriceTable, estimateCost, formatMoney, loadPrices } from './pricing.js'
import { appendUsage, formatTimestamp, ledgerPathOf, readUsage, renderUsageView, summarizeUsage } from './ledger.js'

/** 允许的统计周期。 */
export const USAGE_PERIODS = Object.freeze(['today', 'week', 'month', 'all'])

/**
 * 组装用量视图。
 * @param {{ config: Record<string, any>, period?: string, detail?: boolean, detailLimit?: number }} options
 */
export async function buildUsageView(options) {
  const period = (options.period ?? 'today').trim() || 'today'
  if (!USAGE_PERIODS.includes(period)) {
    throw new SeedreamError('INVALID_ARGUMENT', `未知统计周期 ${JSON.stringify(options.period)}；可用 ${USAGE_PERIODS.join('/')}`)
  }
  const limit = Math.min(50, Math.max(1, Math.trunc(options.detailLimit ?? 10)))
  const path = ledgerPathOf(options.config)
  const { entries, skipped } = await readUsage(path)
  const summary = summarizeUsage(entries, period)
  const table = await loadPrices({ config: options.config, modelIds: options.config.models })
  const priceLines = describePriceTable(table, options.config.models)

  const byTier = summary.byTier.map((bucket) => ({
    tier: String(bucket.tier),
    ...(typeof bucket.model === 'string' ? { model: bucket.model } : {}),
    images: bucket.images,
    calls: bucket.calls,
    costText: bucket.hasCost ? formatMoney(bucket.cost, bucket.currency ?? table.currency) : '单价未配置',
  }))

  const recent = options.detail === true
    ? entries
        .slice()
        .reverse()
        .slice(0, limit)
        .map((entry) => {
          const dimensions = Array.isArray(entry.images)
            ? entry.images
                .map((image) => (image.width && image.height ? `${image.width}x${image.height}` : '?'))
                .join(', ')
            : ''
          const costText = typeof entry.cost === 'number' ? formatMoney(entry.cost, entry.currency ?? table.currency) : '未计价'
          const localTime = formatTimestamp(entry.ts)
          return {
            ts: localTime,
            summary: `${localTime} ${entry.mode ?? ''} ${entry.tier ?? ''} ${entry.size ?? ''} ${entry.billed ?? 0} 张${dimensions === '' ? '' : ` (${dimensions})`} ${costText}`,
          }
        })
    : []

  const hasCost = summary.hasCost
  // 引导：历史条目在填价前记录 → 金额为空；填价后用 recost 补齐，而不是让人以为功能坏了。
  const anyPriceConfigured = Object.values(table.models).some(
    (entry) => entry !== undefined && (entry.pricePerImage !== null || entry.pricePerImageHigh !== null),
  )
  let hint
  if (summary.unpricedImages > 0) {
    hint = anyPriceConfigured
      ? `有 ${summary.unpricedImages} 张记录时还没有单价（金额为空），可运行 seedream usage recost 按当前价表补齐历史。`
      : '单价未配置，费用显示为空：先 seedream price set --tier 5.0-pro --price <元/张>，再 seedream usage recost 补齐历史。'
  }
  const view = {
    period,
    calls: summary.calls,
    images: summary.images,
    outputTokens: summary.outputTokens,
    costText: summary.calls === 0 ? formatMoney(0, table.currency) : hasCost ? formatMoney(summary.cost, table.currency) : '单价未配置',
    unpricedImages: summary.unpricedImages,
    currency: table.currency,
    ledger: path,
    ...(hint === undefined ? {} : { hint }),
    ...(typeof table.note === 'string' ? { priceNote: table.note } : {}),
    ...(summary.since === undefined ? {} : { since: formatTimestamp(summary.since) }),
    ...(summary.lastTs === undefined ? {} : { lastTs: formatTimestamp(summary.lastTs) }),
    ...(skipped > 0 ? { skipped } : {}),
    byTier,
    priceTable: priceLines,
    recent,
  }
  return view
}

/**
 * 一行摘要，供 seedream_status 复用。
 * @param {Record<string, any>} config
 */
export async function buildUsageLine(config) {
  const today = await buildUsageView({ config, period: 'today' })
  const all = await buildUsageView({ config, period: 'all' })
  const parts = [
    `今天 ${today.images} 张 / ${today.costText}`,
    `累计 ${all.images} 张 / ${all.costText}`,
  ]
  const unpriced = all.unpricedImages ?? 0
  if (unpriced > 0) parts.push(`${unpriced} 张未计价（单价未配置，可用 seedream price set 填写）`)
  return { text: parts.join('；'), today, all }
}

/** 渲染视图文本（CLI 与工具共用同一个渲染器）。 */
export function renderUsage(view) {
  return renderUsageView(view)
}

/**
 * 用当前价表重新计算历史记录的金额。
 *
 * 为什么允许改写：台账里的金额是「当时的估算」，填价之前记录的条目都是「未计价」。
 * 重新计价把它们按当前价表补齐，同时保留 `.bak` 备份；它只改金额相关字段，
 * 张数/tokens/像素等事实字段原样保留。
 *
 * @param {{ config: Record<string, any>, dryRun?: boolean }} options
 */
export async function recostLedger(options) {
  const path = ledgerPathOf(options.config)
  const { entries, skipped } = await readUsage(path)
  const table = await loadPrices({ config: options.config, modelIds: options.config.models })
  const rewritten = entries.map((entry) => {
    const dimensions = Array.isArray(entry.images) ? entry.images : []
    const estimate = estimateCost(table, entry.model, dimensions, entry.billed)
    return {
      ...entry,
      currency: estimate.currency,
      cost: estimate.cost,
      unitPrices: estimate.unitPrices,
      priced: estimate.priced,
      unpriced: estimate.unpriced,
    }
  })
  const before = summarizeUsage(entries, 'all')
  const after = summarizeUsage(rewritten, 'all')
  if (options.dryRun === true || entries.length === 0) {
    return { path, entries: entries.length, skipped, before, after, written: false, currency: table.currency }
  }
  const { copyFile, mkdir, rename, writeFile } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  await mkdir(dirname(path), { recursive: true })
  await copyFile(path, `${path}.bak`)
  const temporary = `${path}.tmp`
  await writeFile(temporary, rewritten.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8')
  await rename(temporary, path)
  return { path, entries: rewritten.length, skipped, before, after, written: true, currency: table.currency, backup: `${path}.bak` }
}

/** 追加历史记录（补录用）：用当前价表给每条记录打折计价后写入。 */
export async function appendHistorical(records, options) {
  const table = await loadPrices({ config: options.config, modelIds: options.config.models })
  const path = ledgerPathOf(options.config)
  let written = 0
  for (const record of records) {
    const dimensions = Array.isArray(record.images) ? record.images : []
    const estimate = estimateCost(table, record.model, dimensions, record.billed)
    await appendUsage(
      {
        ...record,
        currency: estimate.currency,
        cost: estimate.cost,
        unitPrices: estimate.unitPrices,
        priced: estimate.priced,
        unpriced: estimate.unpriced,
      },
      path,
    )
    written += 1
  }
  return { path, written }
}
