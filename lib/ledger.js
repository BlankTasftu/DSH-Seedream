/**
 * 用量台账（JSONL 追加写）：每成功生成一次记一行，供「花了多少钱」的统计与追溯。
 *
 * 只记事实与当时的估算：张数、输出 tokens、每张像素、落盘字节数、当时生效的单价与金额。
 * 金额随价表变化，所以**写进台账的金额就是当时的估算**，事后改价不会篡改历史。
 * 追加写单行（每次一个 write 调用）足以避免并发写坏；DSH 的工具默认也是串行调度。
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { SeedreamError, describeError } from './errors.js'
import { dshHome } from './config.js'
import { formatMoney } from './pricing.js'

/** 台账默认路径。 */
export function defaultLedgerPath() {
  return join(dshHome(), 'seedream', 'usage.jsonl')
}

/** 台账路径（配置优先）。 */
export function ledgerPathOf(config) {
  return config.ledgerPath !== '' ? config.ledgerPath : defaultLedgerPath()
}

/** 追加一条用量记录。 */
export async function appendUsage(entry, path) {
  const line = `${JSON.stringify(entry)}\n`
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, line, 'utf8')
  return entry
}

/** 读取全部记录；损坏的行跳过并计入 `skipped`，不阻断统计。 */
export async function readUsage(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return { entries: [], skipped: 0, path }
    throw new SeedreamError('LEDGER_ERROR', `读取用量台账 ${path} 失败：${describeError(error)}`, { cause: error })
  }
  const entries = []
  let skipped = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed !== null && typeof parsed === 'object') entries.push(parsed)
      else skipped += 1
    } catch {
      skipped += 1
    }
  }
  return { entries, skipped, path }
}

/** 时间窗口起点（本地时间）。 */
export function periodStart(period, now = new Date()) {
  if (period === 'all') return undefined
  if (period === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (period === 'week') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    start.setDate(start.getDate() - 6)
    return start
  }
  if (period === 'month') return new Date(now.getFullYear(), now.getMonth(), 1)
  throw new SeedreamError('INVALID_ARGUMENT', `未知统计周期 ${JSON.stringify(period)}；可用 today/week/month/all`)
}

/**
 * 台账时间统一渲染成本机本地时间：台账里既有 `toISOString()`（UTC）也有补录时写的带偏移值，
 * 不归一的话同一份报告里会出现两种写法。
 * @param {string|Date|undefined} value ISO 时间或 Date。
 */
export function formatTimestamp(value) {
  const date = value instanceof Date ? value : new Date(String(value ?? ''))
  if (Number.isNaN(date.getTime())) return String(value ?? '')
  const pad = (number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 按周期汇总台账。 */
export function summarizeUsage(entries, period = 'today', now = new Date()) {  const start = periodStart(period, now)
  const summary = {
    period,
    since: start === undefined ? undefined : start.toISOString(),
    calls: 0,
    images: 0,
    outputTokens: 0,
    cost: 0,
    hasCost: false,
    unpricedImages: 0,
    byTier: [],
    lastTs: undefined,
  }
  const tiers = new Map()
  for (const entry of entries) {
    const ts = typeof entry.ts === 'string' ? new Date(entry.ts) : undefined
    if (ts === undefined || Number.isNaN(ts.getTime())) continue
    if (start !== undefined && ts < start) continue
    const billed = Number.isFinite(entry.billed) ? entry.billed : Array.isArray(entry.images) ? entry.images.length : 0
    const tokens = Number.isFinite(entry.outputTokens) ? entry.outputTokens : 0
    summary.calls += 1
    summary.images += billed
    summary.outputTokens += tokens
    summary.lastTs = entry.ts
    if (typeof entry.cost === 'number') {
      summary.cost += entry.cost
      summary.hasCost = true
    }
    if (Number.isFinite(entry.unpriced)) summary.unpricedImages += entry.unpriced
    const key = typeof entry.tier === 'string' && entry.tier !== '' ? entry.tier : String(entry.model ?? '未知')
    const bucket = tiers.get(key) ?? { tier: key, model: entry.model, images: 0, calls: 0, cost: 0, hasCost: false, currency: entry.currency }
    bucket.images += billed
    bucket.calls += 1
    if (typeof entry.cost === 'number') {
      bucket.cost += entry.cost
      bucket.hasCost = true
    }
    bucket.model = entry.model ?? bucket.model
    bucket.currency = entry.currency ?? bucket.currency
    tiers.set(key, bucket)
  }
  summary.cost = Number(summary.cost.toFixed(6))
  summary.byTier = [...tiers.values()]
    .map((bucket) => ({ ...bucket, cost: Number(bucket.cost.toFixed(6)) }))
    .sort((a, b) => b.images - a.images || String(a.tier).localeCompare(String(b.tier)))
  return summary
}

const PERIOD_LABEL = Object.freeze({ today: '今天', week: '近 7 天', month: '本月', all: '全部' })

/**
 * 把 usage 视图渲染成模型可见的文本报告（纯函数：只读视图，便于 render 与 CLI 共用）。
 * @param {Record<string, any>} view 由 lib/usage.js 组装。
 */
export function renderUsageView(view) {
  const lines = [
    `<seedream-usage period="${view.period}" currency="${view.currency}">`,
    `<label>${PERIOD_LABEL[view.period] ?? view.period}</label>`,
    `<calls>${view.calls}</calls>`,
    `<images>${view.images}</images>`,
    `<output-tokens>${view.outputTokens}</output-tokens>`,
    `<estimated-cost>${view.costText}</estimated-cost>`,
  ]
  if (Number.isFinite(view.unpricedImages) && view.unpricedImages > 0) {
    lines.push(`<unpriced-images>${view.unpricedImages}</unpriced-images>`)
  }
  if (typeof view.since === 'string') lines.push(`<since>${view.since}</since>`)
  if (Array.isArray(view.byTier) && view.byTier.length > 0) {
    lines.push('<by-tier>')
    for (const bucket of view.byTier) {
      lines.push(`- ${bucket.tier}（${bucket.model ?? '未知模型'}）: ${bucket.images} 张 / ${bucket.calls} 次 / ${bucket.costText}`)
    }
    lines.push('</by-tier>')
  }
  if (Array.isArray(view.priceTable) && view.priceTable.length > 0) {
    lines.push('<price-table>')
    for (const line of view.priceTable) lines.push(`- ${line}`)
    lines.push('</price-table>')
  }
  if (typeof view.priceNote === 'string' && view.priceNote !== '') {
    lines.push(`<price-source>${view.priceNote}</price-source>`)
  }
  if (Array.isArray(view.recent) && view.recent.length > 0) {
    lines.push('<recent>')
    for (const item of view.recent) lines.push(`- ${item.summary}`)
    lines.push('</recent>')
  }
  if (typeof view.hint === 'string' && view.hint !== '') lines.push(`<hint>${view.hint}</hint>`)
  lines.push(`<ledger>${view.ledger}</ledger>`)
  if (Number.isFinite(view.skipped) && view.skipped > 0) lines.push(`<skipped-lines>${view.skipped}</skipped-lines>`)
  lines.push(
    '<disclaimer>金额是按本地价表的估算（方舟按返回张数计费；单价只在控制台可见，API 不返回），不是官方账单。填价：seedream price set --tier 5.0-pro --price &lt;元/张&gt;。</disclaimer>',
  )
  lines.push('</seedream-usage>')
  return lines.join('\n')
}
