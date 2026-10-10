/**
 * 可用余额视图：**官方余额优先，本地预算兜底**。
 *
 * - 官方：费用中心 OpenAPI `QueryBalanceAcct`（需 AK/SK，见 lib/billing.js）。
 *   界面每 5 秒轮询一次，绝不能每次都打费用中心，所以这里做进程级缓存 + 强制刷新节流。
 * - 本地：用「已充值总额 − 台账累计花费」算剩余，并按近 7 天日均估算还能用几天。
 *   零凭据即可用，但只是本地账，不等于账户真实余额。
 *
 * 官方查询失败时**不会**把失败当成「余额为 0」：保留上一次成功值并标注 stale + 错误原因，
 * 同时本地预算仍然可用。
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { SeedreamError, describeError } from './errors.js'
import { dshHome } from './config.js'
import { ledgerPathOf, readUsage } from './ledger.js'
import {
  billingStatus,
  billingVaultPathOf,
  queryBalance,
  resolveBillingCredentials,
} from './billing.js'

/** 本地预算文件路径：改它不需要重启（与 prices.json 同一套思路）。 */
export function budgetFilePathOf(config) {
  return config.budgetFilePath !== '' ? config.budgetFilePath : join(dshHome(), 'seedream', 'budget.json')
}

/** 读取预算文件；不存在或损坏时返回 undefined。 */
export async function readBudgetFile(config) {
  try {
    const parsed = JSON.parse(await readFile(budgetFilePathOf(config), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined
    throw new SeedreamError('BUDGET_FILE_ERROR', `读取预算文件失败：${describeError(error)}`, { cause: error })
  }
}

/** 写入预算文件（原子替换）。 */
export async function writeBudgetFile(config, document) {
  const path = budgetFilePathOf(config)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
  return path
}

/** 进程级缓存：官方余额 + 上次成功时间 + 上次错误。 */
const cache = {
  balance: undefined,
  fetchedAt: 0,
  error: undefined,
  lastAttemptAt: 0,
}

/** 仅供测试使用：重置缓存。 */
export function resetBalanceCache() {
  cache.balance = undefined
  cache.fetchedAt = 0
  cache.error = undefined
  cache.lastAttemptAt = 0
}

/** 强制刷新的最小间隔（毫秒）：防止界面/工具连续点刷新把费用中心打爆。 */
const MIN_REFRESH_INTERVAL_MS = 30_000

function toNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * 本地预算：已充值 − 台账累计（自 `budgetSince` 起）。
 * @param {{ total: number, since?: string, currency: string, entries: Array<Record<string, any>>, now?: Date }} options
 */
export function computeBudget(options) {
  const now = options.now ?? new Date()
  const since = options.since === undefined || options.since === '' ? undefined : new Date(options.since)
  const sinceMs = since === undefined || Number.isNaN(since.getTime()) ? undefined : since.getTime()
  let spent = 0
  let unpricedImages = 0
  let earliest = undefined
  const windowStart = now.getTime() - 7 * 86_400_000
  let recentSpend = 0
  let recentPriced = false
  for (const entry of options.entries) {
    const ts = typeof entry.ts === 'string' ? new Date(entry.ts) : undefined
    if (ts === undefined || Number.isNaN(ts.getTime())) continue
    if (sinceMs !== undefined && ts.getTime() < sinceMs) continue
    if (earliest === undefined || ts.getTime() < earliest) earliest = ts.getTime()
    if (typeof entry.cost === 'number') spent += entry.cost
    if (Number.isFinite(entry.unpriced)) unpricedImages += entry.unpriced
    if (ts.getTime() >= windowStart) {
      if (typeof entry.cost === 'number') {
        recentSpend += entry.cost
        recentPriced = true
      }
    }
  }
  spent = Number(spent.toFixed(6))
  const total = options.total
  const remaining = Number(Math.max(0, total - spent).toFixed(6))
  const spanDays = earliest === undefined ? 0 : Math.max(1, Math.ceil((now.getTime() - earliest) / 86_400_000))
  // 日均：优先用近 7 天；近 7 天没有计价记录时退回「自首条记录以来的均值」
  const dailyAverage = recentPriced
    ? Number((recentSpend / Math.min(7, Math.max(1, spanDays))).toFixed(6))
    : spanDays > 0 && spent > 0
      ? Number((spent / spanDays).toFixed(6))
      : 0
  const daysLeft = dailyAverage > 0 ? Math.floor(remaining / dailyAverage) : null
  return {
    total,
    spent,
    remaining,
    currency: options.currency,
    since: sinceMs === undefined ? null : new Date(sinceMs).toISOString(),
    dailyAverage,
    daysLeft,
    unpricedImages,
  }
}

/**
 * 组装余额视图。
 * @param {{ config: Record<string, any>, refresh?: boolean, ctx?: any }} options
 */
export async function buildBalanceView(options) {
  const config = options.config
  const status = await billingStatus({ config })
  const credentials = await resolveBillingCredentials({ config })
  const ttlMs = Math.max(0, Number(config.billingCacheSeconds ?? 600)) * 1000
  const now = Date.now()

  let official
  if (credentials !== undefined) {
    const fresh = cache.balance !== undefined && now - cache.fetchedAt < ttlMs
    const throttleOk = now - cache.lastAttemptAt >= MIN_REFRESH_INTERVAL_MS
    const shouldQuery = !fresh && (options.refresh !== true || throttleOk)
    if (shouldQuery) {
      cache.lastAttemptAt = now
      try {
        const balance = await queryBalance({
          accessKey: credentials.accessKey,
          secretKey: credentials.secretKey,
          region: config.billingRegion,
          host: config.billingHost,
          timeoutMs: config.billingTimeoutMs,
        })
        cache.balance = balance
        cache.fetchedAt = now
        cache.error = undefined
      } catch (error) {
        cache.error = error instanceof SeedreamError ? `${error.code}: ${error.message}` : describeError(error)
      }
    }
    const stale = cache.balance !== undefined && now - cache.fetchedAt >= ttlMs
    official = {
      configured: true,
      source: credentials.source,
      hint: credentials.hint ?? null,
      available: cache.balance?.AvailableBalance ?? null,
      currency: config.priceCurrency,
      fields: cache.balance === undefined
        ? null
        : Object.fromEntries(Object.entries(cache.balance).filter(([key]) => key !== 'fetchedAt')),
      fetchedAt: cache.balance?.fetchedAt ?? null,
      stale,
      error: cache.error ?? null,
    }
  }

  // 本地预算：用台账算（无论是否有官方余额都算，便于对照）
  const { entries } = await readUsage(ledgerPathOf(config))
  const budgetFile = await readBudgetFile(config)
  const configTotal = toNumber(config.budgetTotal)
  const fileTotal = toNumber(budgetFile?.total)
  const total = configTotal !== null && configTotal > 0 ? configTotal : fileTotal !== null && fileTotal > 0 ? fileTotal : null
  const since = typeof config.budgetSince === 'string' && config.budgetSince !== ''
    ? config.budgetSince
    : typeof budgetFile?.since === 'string' && budgetFile.since !== ''
      ? budgetFile.since
      : ''
  const budget = total !== null
    ? { ...computeBudget({ total, since, currency: config.priceCurrency, entries }), file: budgetFilePathOf(config), fromConfig: configTotal !== null && configTotal > 0 }
    : null

  const mode = official !== undefined && official.available !== null
    ? 'official'
    : official !== undefined
      ? 'official-error'
      : budget !== null
        ? 'budget'
        : 'none'

  return {
    mode,
    official: official ?? null,
    budget,
    billing: {
      configured: status.configured || status.environmentConfigured,
      environmentConfigured: status.environmentConfigured,
      path: status.path,
      hint: status.hint,
      updatedAt: status.updatedAt,
    },
  }
}

/** 余额是否可直接展示为「可用余额」数字。 */
export function availableAmount(view) {
  if (view?.official?.available !== null && view?.official?.available !== undefined) return toNumber(view.official.available)
  return null
}

/** 一行摘要（供 seedream_status 用）。 */
export function summarizeBalance(view) {
  if (view === undefined || view === null) return '未启用'
  if (view.official !== null && view.official.available !== null) {
    const suffix = view.official.stale ? '（缓存值）' : ''
    return `官方可用余额 ${view.official.available} ${view.official.currency}${suffix}`
  }
  if (view.official !== null && view.official.error !== null) {
    return `官方余额查询失败：${view.official.error}`
  }
  if (view.budget !== null) {
    return `本地预算剩余 ${view.budget.remaining} ${view.budget.currency}（已花 ${view.budget.spent}/${view.budget.total}${view.budget.daysLeft === null ? '' : `，预计可用 ${view.budget.daysLeft} 天`}）`
  }
  return '未配置（可在界面「可用余额」区块填入 AK/SK，或设置本地预算）'
}

/** 渲染成模型可读的文本块。 */
export function renderBalanceView(view) {
  const lines = ['<seedream-balance>', `<mode>${view.mode}</mode>`]
  if (view.official !== null) {
    lines.push('<official>')
    if (view.official.available !== null) {
      lines.push(`<available>${view.official.available}</available>`)
      for (const [key, value] of Object.entries(view.official.fields ?? {})) lines.push(`<${key}>${value}</${key}>`)
      lines.push(`<fetched-at>${view.official.fetchedAt ?? '—'}</fetched-at>`)
      lines.push(`<source>${view.official.source}</source>`)
      if (view.official.stale) lines.push('<stale>true</stale>')
    } else {
      lines.push('<error>尚未取到余额</error>')
    }
    if (view.official.error !== null) lines.push(`<error>${view.official.error}</error>`)
    lines.push('</official>')
  }
  if (view.budget !== null) {
    lines.push('<budget>')
    lines.push(`<total>${view.budget.total}</total>`)
    lines.push(`<spent>${view.budget.spent}</spent>`)
    lines.push(`<remaining>${view.budget.remaining}</remaining>`)
    if (view.budget.dailyAverage > 0) lines.push(`<daily-average>${view.budget.dailyAverage}</daily-average>`)
    if (view.budget.daysLeft !== null) lines.push(`<days-left>${view.budget.daysLeft}</days-left>`)
    if (view.budget.since !== null) lines.push(`<since>${view.budget.since}</since>`)
    if (view.budget.unpricedImages > 0) lines.push(`<unpriced-images>${view.budget.unpricedImages}</unpriced-images>`)
    lines.push('</budget>')
  }
  if (view.billing.configured !== true) {
    lines.push('<hint>未配置 AK/SK：当前只能按本地预算估算。要显示账户真实可用余额，请在界面「可用余额」区块填入子账号 AK/SK（只需「费用中心只读」权限）。</hint>')
  } else if (view.official?.error !== null && view.official?.error !== undefined) {
    lines.push(`<hint>官方余额查询失败（${view.official.error}）；请检查 AK/SK 是否只授予了费用中心只读权限。</hint>`)
  }
  lines.push('<disclaimer>官方余额来自火山引擎费用中心 QueryBalanceAcct；本地预算是「已充值 − 台账累计」的自算值，不是账户余额。</disclaimer>')
  lines.push('</seedream-balance>')
  return lines.join('\n')
}
