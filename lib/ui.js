/**
 * 客户端界面（同一插件内，不新增插件）：
 * 1. 实时计费徽标 —— 页面右下角常驻，5s 轮询本插件的 `/dsh-seedream/state`；
 * 2. 管理面板 —— 图形化查看/写入 API Key（写入走 DPAPI 金库）、编辑单价、按新价重算历史。
 *
 * 为什么是「注入行 + 自有路由」而不是客户端插件：
 * 桌面壳的 index.html 从安装包静态 dist 直出，`tapIndex` 到不了页面；唯一通道是
 * `webserver/index-inject` 推的结构化行（宿主启动时收集一次），行内脚本再自行加载
 * 本插件路由下发的 client.js。因此**新增/修改这段界面需要重启 DSH**。
 *
 * 安全：所有路由都过三层信任栅栏（自校验 → 宿主 connection 栅栏 → 写操作仅限本机），
 * 并且**任何响应都不回传 Key 明文**，只回传「是否已配置 / 来源 / 金库路径」。
 */

import { readFile } from 'node:fs/promises'
import { statSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SeedreamError, describeError, redactSecrets } from './errors.js'
import { vaultPathOf } from './config.js'
import { describeApiKey } from './credentials.js'
import { clearVault, ensureKeyHint, setSecret, vaultStatus } from './vault.js'
import { describePriceTable, loadPrices, priceFilePathOf, readPriceFile, writePriceFile } from './pricing.js'
import { ledgerPathOf } from './ledger.js'
import { resolveTier, describeTiers } from './models.js'
import { buildUsageView, recostLedger } from './usage.js'
import { buildBalanceView, budgetFilePathOf, readBudgetFile, writeBudgetFile } from './balance.js'
import { billingHint, billingVaultPathOf, clearBillingCredentials, setBillingCredentials } from './billing.js'

/** 本插件占用的路由前缀。 */
export const ROUTE_PREFIX = '/dsh-seedream'

/** 客户端脚本文件名（与 lib/client.js 同目录）。 */
const CLIENT_SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'client.js')

/** 旧格式金库补写指纹：进程级一次性开关，避免每次轮询都解密。 */
const hintBackfill = { attempted: false }

/** 只接受本机管理的额外白名单（逗号分隔，用于确实需要远端管理的场景）。 */
function adminAuthorities() {  return String(process.env.DSH_SEEDREAM_ADMIN_HOSTS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
}

function isLoopbackHostname(hostname) {
  const name = String(hostname ?? '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (name === '') return false
  if (name === 'localhost' || name.endsWith('.localhost') || name === '::1') return true
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name)
  if (parts === null) return false
  if (Number(parts[1]) !== 127) return false
  return [parts[2], parts[3], parts[4]].every((segment) => Number(segment) <= 255)
}

/** 桌面壳注入行：内联脚本自行挂 client.js，并吞掉加载失败（路由不在时也不会拖垮应用启动）。 */
const INJECTION_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  `var s=document.createElement("script");s.src="${ROUTE_PREFIX}/client.js";s.async=true;` +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

/**
 * 注册 index 注入行。**必须在 apply() 里第一时间调用**：桌面端在宿主启动时一次性收集这张表，
 * 晚于那次收集的订阅永远进不了表。
 * @param {any} root 插件上下文
 * @returns {() => void} disposer
 */
export function registerIndexInjection(root) {
  return root.on('webserver/index-inject', (table) => {
    try {
      if (!Array.isArray(table)) return
      for (const row of table) {
        if (row === null || typeof row !== 'object') continue
        if (row.kind === 'script-src' && row.src === `${ROUTE_PREFIX}/client.js`) return
        if (row.kind === 'script' && typeof row.text === 'string' && row.text.includes(`${ROUTE_PREFIX}/client.js`)) return
      }
      table.push({ kind: 'script', placement: 'body', text: INJECTION_ROW_TEXT })
    } catch (error) {
      // 注入失败不应影响宿主启动
    }
  })
}

/** 读取请求体（带上限），返回 UTF-8 文本。 */
function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new SeedreamError('INVALID_ARGUMENT', `请求体超过 ${maxBytes} 字节`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', (error) => reject(error))
  })
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** 客户端脚本按 mtime 缓存读取，改完硬刷新页面即生效（无需重启）。 */
let scriptCache
function loadClientScript() {
  try {
    const info = statSync(CLIENT_SCRIPT_PATH)
    if (scriptCache !== undefined && scriptCache.mtimeMs === info.mtimeMs) return scriptCache.text
    const text = readFileSync(CLIENT_SCRIPT_PATH, 'utf8')
    scriptCache = { text, mtimeMs: info.mtimeMs }
    return text
  } catch (error) {
    throw new SeedreamError('IO_ERROR', `读取客户端脚本失败：${describeError(error)}`, { cause: error })
  }
}

/**
 * 组装界面所需的全部状态（不含任何秘密）。
 * @param {{ config: Record<string, any>, ctx: any }} options
 */
export async function buildUiState(options) {
  const { config, ctx } = options
  const [key, table] = await Promise.all([
    describeApiKey({ config, ctx }),
    loadPrices({ config, modelIds: config.models }),
  ])
  const periods = {}
  for (const period of ['today', 'week', 'month', 'all']) {
    const view = await buildUsageView({ config, period, detail: false })
    periods[period] = {
      calls: view.calls,
      images: view.images,
      outputTokens: view.outputTokens,
      cost: typeof view.costText === 'string' && view.costText.startsWith('¥') ? Number(view.costText.slice(1)) : null,
      costText: view.costText,
      unpricedImages: view.unpricedImages,
    }
  }
  const recentView = await buildUsageView({ config, period: 'all', detail: true })
  const tiers = describeTiers(config.models)
  const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined
  const vaultPath = vaultPathOf(config)

  // 旧格式金库没有指纹：解密一次补写（每个进程只尝试一次，失败也不影响状态返回）。
  // uiKeyHint=false 时既不返回指纹、也不为它解密。
  const hintEnabled = config.uiKeyHint !== false
  let hint = hintEnabled ? key.vault?.hint : undefined
  if (hintEnabled && key.vault?.configured === true && (hint === undefined || typeof hint !== 'object')) {
    if (hintBackfill.attempted !== true) {
      hintBackfill.attempted = true
      try {
        hint = await ensureKeyHint({ path: vaultPath, powershellPath: config.powershellPath })
      } catch {
        hint = undefined
      }
    }
  }

  return {
    ok: true,
    key: {
      configured: key.configured,
      source: key.effectiveSource ?? null,
      reference: key.reference,
      vaultPath,
      hint: hint === undefined || typeof hint !== 'object' ? null : hint,
      hintEnabled,
      updatedAt: key.vault?.updatedAt ?? null,
      cipherBytes: key.vault?.bytes ?? null,
      sources: {
        vault: key.vault?.configured === true,
        credentials: key.credentialsServiceConfigured === true,
        environment: key.processEnvironmentConfigured === true,
      },
      canClearCredentials: typeof credentials?.unset === 'function',
      canClearVault: key.vault?.configured === true,
    },
    usage: periods,
    prices: {
      currency: table.currency,
      highPixelThreshold: table.highPixelThreshold,
      note: table.note ?? null,
      file: priceFilePathOf(config),
      sources: table.sources,
      table: describePriceTable(table, config.models),
      entries: tiers.map((tier) => {
        const entry = table.models[tier.modelId] ?? {}
        return {
          tier: tier.tier,
          modelId: tier.modelId,
          price: entry.pricePerImage ?? null,
          high: entry.pricePerImageHigh ?? null,
        }
      }),
    },
    tiers,
    recent: recentView.recent,
    ledger: ledgerPathOf(config),
    ui: { badgePosition: config.uiBadgePosition },
    // 余额：界面每 5 秒轮询，这里只读缓存（官方余额有 TTL，不强制刷新）
    balance: await buildBalanceView({ config, ctx, refresh: false }),
    budgetFile: budgetFilePathOf(config),
    billingVaultPath: billingVaultPathOf(config),
    disclaimer: '金额是按本地价表的估算（方舟按返回张数计费，单价只在控制台可见），不是官方账单。',
  }
}

/**
 * 注册客户端界面路由。
 * @param {any} ctx 已就绪 webServer（可含 connection）的作用域
 * @param {Record<string, any>} config 归一化配置
 * @param {(level: string, message: string) => void} log 日志出口
 * @returns {Array<() => void>} disposers
 */
export function registerClientUi(ctx, config, log) {
  const disposers = []
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  if (connection === undefined || typeof connection.requestRejection !== 'function') {
    log('warn', 'dsh-seedream: 未找到 connection 信任栅栏，客户端界面路由将只依赖插件自校验（请勿在非本机暴露该端口）')
  }
  let warnedRemoteWrite = false

  /** 三层信任栅栏：自校验 → 写操作限本机 → 宿主栅栏；任何异常都按拒绝处理。 */
  function rejected(req, res, options) {
    const deny = (code) => {
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end('forbidden')
      return true
    }
    try {
      const headers = req.headers ?? {}
      let hostUrl
      try {
        hostUrl = new URL(`http://${String(headers.host ?? '')}`)
      } catch {
        return deny(403)
      }
      const loopback = isLoopbackHostname(hostUrl.hostname)
      if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return deny(403)
      const origin = headers.origin
      if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
        let originUrl
        try {
          originUrl = new URL(origin)
        } catch {
          return deny(403)
        }
        if (originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) return deny(403)
      }
      if (options?.write === true && !loopback) {
        const allowed = adminAuthorities().some((entry) =>
          entry.includes(':') ? entry === hostUrl.host.toLowerCase() : entry === hostUrl.hostname.toLowerCase(),
        )
        if (!allowed) {
          if (!warnedRemoteWrite) {
            warnedRemoteWrite = true
            log('warn', `dsh-seedream: 已拒绝来自非本机（Host=${hostUrl.host}）的写请求；确需远端管理请声明 DSH_SEEDREAM_ADMIN_HOSTS`)
          }
          return deny(403)
        }
      }
      if (!loopback && connection === undefined) {
        // 非回环且没有宿主栅栏可委托 → 只在显式白名单里才放行（回环以外的读也保守拒绝）
        const allowed = adminAuthorities().some((entry) =>
          entry.includes(':') ? entry === hostUrl.host.toLowerCase() : entry === hostUrl.hostname.toLowerCase(),
        )
        if (!allowed) return deny(403)
      }
      if (connection !== undefined && typeof connection.requestRejection === 'function') {
        const verdict = connection.requestRejection(req)
        if (verdict !== undefined && verdict !== null && verdict !== false) {
          return deny(typeof verdict === 'number' ? verdict : 403)
        }
      }
      return false
    } catch (error) {
      log('warn', `dsh-seedream: 信任栅栏异常，按拒绝处理：${describeError(error)}`)
      return deny(403)
    }
  }

  function route(definition) {
    return ctx.webServer.register({
      ...definition,
      handler: async (req, res) => {
        // 写操作以**请求方法**判定（WebRoute 契约里没有 method 字段，方法只能从请求上看）
        if (rejected(req, res, { write: String(req.method ?? 'GET').toUpperCase() === 'POST' })) return
        try {
          await definition.handler(req, res)
        } catch (error) {
          const code = error instanceof SeedreamError ? error.code : 'INTERNAL'
          const detail = redactSecrets(describeError(error))
          log('warn', `dsh-seedream: ${definition.path} 失败：[${code}] ${detail}`)
          if (!res.headersSent) {
            sendJson(res, error instanceof SeedreamError && code === 'INVALID_ARGUMENT' ? 400 : 500, { ok: false, code, message: detail })
          }
        }
      },
    })
  }

  disposers.push(
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/client.js`,
      handler: (req, res) => {
        const text = loadClientScript()
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(text),
        })
        res.end(text)
      },
    }),
  )

  disposers.push(
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/state`,
      handler: async (req, res) => {
        sendJson(res, 200, await buildUiState({ config, ctx }))
      },
    }),
  )

  disposers.push(
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/key`,
      handler: async (req, res) => {
        const payload = JSON.parse((await readBody(req, 16 * 1024)) || '{}')
        const vaultPath = vaultPathOf(config)
        // 删除：按来源删（vault = DPAPI 金库文件；credentials = DSH 凭据库里的该引用）
        if (payload?.clear === true) {
          const source = payload.source === 'credentials' ? 'credentials' : 'vault'
          if (source === 'credentials') {
            const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
            if (credentials === undefined || typeof credentials.unset !== 'function') {
              sendJson(res, 400, { ok: false, code: 'NOT_AVAILABLE', message: '当前环境没有可写的 DSH 凭据服务，无法删除凭据库里的值' })
              return
            }
            await credentials.unset(config.apiKeyEnv)
            sendJson(res, 200, { ok: true, cleared: true, source, reference: config.apiKeyEnv })
            return
          }
          await clearVault(vaultPath)
          sendJson(res, 200, { ok: true, cleared: true, source, configured: false })
          return
        }
        const value = typeof payload?.value === 'string' ? payload.value.trim() : ''
        if (value === '') {
          sendJson(res, 400, { ok: false, code: 'INVALID_ARGUMENT', message: 'API Key 不能为空' })
          return
        }
        const before = await vaultStatus(vaultPath)
        const result = await setSecret(value, { path: vaultPath, powershellPath: config.powershellPath })
        sendJson(res, 200, {
          ok: true,
          configured: true,
          vaultPath,
          replaced: before.configured === true,
          previousHint: before.hint ?? null,
          hint: result.hint,
          updatedAt: result.updatedAt,
          encryption: 'Windows DPAPI（当前用户范围）',
        })
      },
    }),
  )

  disposers.push(
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/price`,
      handler: async (req, res) => {
        const payload = JSON.parse((await readBody(req, 16 * 1024)) || '{}')
        const path = priceFilePathOf(config)
        if (payload?.clear === true) {
          const { rm } = await import('node:fs/promises')
          await rm(path, { force: true })
          sendJson(res, 200, { ok: true, cleared: true })
          return
        }
        const { tier, price, high, note } = payload ?? {}
        const parsedPrice = Number(price)
        if (typeof tier !== 'string' || tier === '' || !Number.isFinite(parsedPrice) || parsedPrice <= 0) {
          sendJson(res, 400, { ok: false, code: 'INVALID_ARGUMENT', message: '需要 tier 与大于 0 的 price' })
          return
        }
        const { modelId } = resolveTier(tier, config.models, config.defaultModel)
        const document = (await readPriceFile(path)) ?? {}
        const models = document.models !== null && typeof document.models === 'object' ? { ...document.models } : {}
        const entry = models[modelId] !== null && typeof models[modelId] === 'object' ? { ...models[modelId] } : {}
        entry.pricePerImage = parsedPrice
        const parsedHigh = Number(high)
        if (Number.isFinite(parsedHigh) && parsedHigh > 0) entry.pricePerImageHigh = parsedHigh
        models[modelId] = entry
        const parsedNote = typeof note === 'string' && note.trim() !== '' ? note.trim() : document.note
        await writePriceFile(path, {
          currency: document.currency ?? config.priceCurrency,
          highPixelThreshold: document.highPixelThreshold ?? config.priceHighPixelThreshold,
          ...(parsedNote === undefined ? {} : { note: parsedNote }),
          models,
        })
        sendJson(res, 200, { ok: true, tier, modelId, price: parsedPrice, high: entry.pricePerImageHigh ?? null, file: path })
      },
    }),
  )

  disposers.push(
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/recost`,
      handler: async (req, res) => {
        const result = await recostLedger({ config })
        sendJson(res, 200, {
          ok: true,
          entries: result.entries,
          before: result.before.cost,
          after: result.after.cost,
          unpriced: result.after.unpricedImages,
          backup: result.backup ?? null,
        })
      },
    }),
  )

  disposers.push(
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/balance`,
      handler: async (req, res) => {
        // refresh=true 强制刷新（有 30 秒节流）；否则读缓存
        const payload = req.method === 'POST' ? JSON.parse((await readBody(req, 8 * 1024)) || '{}') : {}
        const view = await buildBalanceView({ config, ctx, refresh: payload?.refresh === true })
        sendJson(res, 200, { ok: true, ...view })
      },
    }),
  )

  disposers.push(
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/billing`,
      handler: async (req, res) => {
        const payload = JSON.parse((await readBody(req, 16 * 1024)) || '{}')
        if (payload?.clear === true) {
          await clearBillingCredentials({ config })
          sendJson(res, 200, { ok: true, cleared: true, configured: false })
          return
        }
        const accessKey = typeof payload?.accessKey === 'string' ? payload.accessKey.trim() : ''
        const secretKey = typeof payload?.secretKey === 'string' ? payload.secretKey.trim() : ''
        if (accessKey === '' || secretKey === '') {
          sendJson(res, 400, { ok: false, code: 'INVALID_ARGUMENT', message: 'Access Key 与 Secret Key 都不能为空' })
          return
        }
        const result = await setBillingCredentials(accessKey, secretKey, { config })
        // 立刻验证一次：能查通才说明权限配置正确（失败也不回滚，界面会显示错误原因）
        // 回显前按值擦除 AK/SK：即便上游异常夹带了它们，也不会进入响应
        const scrub = (value) => {
          let output = String(value ?? '')
          for (const secret of [accessKey, secretKey]) {
            if (secret.length >= 8 && output.includes(secret)) output = output.split(secret).join('***REDACTED***')
          }
          return redactSecrets(output)
        }
        let verified = false
        let verifyError = null
        try {
          const view = await buildBalanceView({ config, ctx, refresh: true })
          verified = view.official?.available !== null && view.official?.available !== undefined
          verifyError = view.official?.error == null ? null : scrub(view.official.error)
        } catch (error) {
          verifyError = scrub(describeError(error))
        }
        sendJson(res, 200, { ok: true, configured: true, path: result.path, hint: result.hint, verified, verifyError })
      },
    }),
  )

  disposers.push(
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/budget`,
      handler: async (req, res) => {
        const payload = JSON.parse((await readBody(req, 8 * 1024)) || '{}')
        const path = budgetFilePathOf(config)
        if (payload?.clear === true) {
          const { rm } = await import('node:fs/promises')
          await rm(path, { force: true })
          sendJson(res, 200, { ok: true, cleared: true })
          return
        }
        const total = Number(payload?.total)
        if (!Number.isFinite(total) || total <= 0) {
          sendJson(res, 400, { ok: false, code: 'INVALID_ARGUMENT', message: '预算总额必须是大于 0 的数字' })
          return
        }
        const since = typeof payload?.since === 'string' ? payload.since.trim() : ''
        await writeBudgetFile(config, { total, ...(since === '' ? {} : { since }) })
        const overriddenByConfig = Number(config.budgetTotal) > 0
        sendJson(res, 200, {
          ok: true,
          total,
          since: since === '' ? null : since,
          file: path,
          overriddenByConfig,
          ...(overriddenByConfig ? { note: `配置里写了 budgetTotal=${config.budgetTotal}，它的优先级高于本文件；要让界面生效请删掉该配置项` } : {}),
        })
      },
    }),
  )

  log('info', `dsh-seedream: 客户端界面已注册（${ROUTE_PREFIX}/client.js、state、key、price、recost、balance、billing、budget）`)
  return disposers
}
