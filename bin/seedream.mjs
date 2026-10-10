#!/usr/bin/env node
/**
 * seedream CLI —— 配置与自检入口，不经过 Agent。
 *
 * 用法：
 *   node bin/seedream.mjs key set [--from-env NAME] [--vault PATH]
 *   node bin/seedream.mjs key status [--vault PATH]
 *   node bin/seedream.mjs key clear  [--vault PATH]
 *   node bin/seedream.mjs models
 *   node bin/seedream.mjs probe [--live] [--tier 5.0-pro]
 *   node bin/seedream.mjs generate --prompt "..." [--model 5.0-pro] [--size 2K] [--count 1] [--out DIR]
 *
 * 安全约定：Key 只从 stdin 或环境变量读入，**不接受** `--key` 这类命令行明文参数
 * （命令行会进 shell 历史与进程列表）；写入磁盘时只落 DPAPI 密文。
 */

import { resolveConfig, vaultPathOf } from '../lib/config.js'
import { clearVault, getSecret, keyHint, setSecret, vaultStatus } from '../lib/vault.js'
import { describeApiKey, resolveApiKey } from '../lib/credentials.js'
import { TIER_KEYS, describeTiers, normalizeSize, resolveTier } from '../lib/models.js'
import { ArkClient } from '../lib/ark.js'
import { runSeedream } from '../lib/tools.js'
import { SeedreamError } from '../lib/errors.js'
import { buildUsageView, recostLedger, renderUsage } from '../lib/usage.js'
import { buildBalanceView, renderBalanceView } from '../lib/balance.js'
import { describePriceTable, formatMoney, loadPrices, priceFilePathOf, readPriceFile, writePriceFile } from '../lib/pricing.js'
import { ledgerPathOf } from '../lib/ledger.js'

function parseArgs(argv) {
  const flags = {}
  const rest = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) flags[key] = true
      else {
        flags[key] = next
        index += 1
      }
    } else rest.push(token)
  }
  return { flags, rest }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}

function configFrom(flags) {
  const overrides = {}
  if (typeof flags.vault === 'string') overrides.vaultPath = flags.vault
  if (typeof flags.baseUrl === 'string') overrides.baseUrl = flags.baseUrl
  return resolveConfig(overrides)
}

const USAGE = `seedream CLI

  key set [--from-env NAME] [--vault PATH]   把 API Key 用 Windows DPAPI 加密写入金库（Key 从 stdin 读）
  key status [--vault PATH]                  查看各来源配置情况（不显示 Key）
  key clear [--vault PATH]                   删除金库文件
  models                                     列出三个档位与解析后的 Model ID
  probe [--live] [--tier TIER]               探测模型可用性（默认只做不计费的参数探测）
  generate --prompt P [--model TIER] [--size S] [--count N] [--out DIR] [--name NAME]
  usage [--period today|week|month|all] [--detail]
                                             用量与费用统计（金额按本地价表估算）
  balance [--refresh]                        可用余额：官方（需 AK/SK）优先，本地预算兜底
  price show                                 查看生效价表与来源
  price set --tier TIER --price N [--high N] [--threshold N] [--currency CNY] [--note "..."]
                                             写入单价（元/张），--high 为超过阈值像素的高价档，
                                             --note 记录价格来源（会显示在用量报告里）
  price clear                                删除价格文件，回到「单价未配置」

示例：
  "ark-xxxx" | node bin/seedream.mjs key set
  node bin/seedream.mjs price set --tier 5.0-pro --price 0.32 --high 0.95
  node bin/seedream.mjs usage --period month --detail
`

async function commandKey(flags, action) {
  const config = configFrom(flags)
  const path = vaultPathOf(config)
  if (action === 'set') {
    const fromEnv = typeof flags['from-env'] === 'string' ? flags['from-env'] : undefined
    const secret = fromEnv === undefined ? await readStdin() : (process.env[fromEnv] ?? '')
    if (secret.trim() === '') {
      console.error(`没有读到 Key。${fromEnv === undefined ? '请把 Key 通过 stdin 传入（例如 "ark-xxx" | node bin/seedream.mjs key set），' : `环境变量 ${fromEnv} 为空，`}拒绝写入空值。`)
      process.exitCode = 2
      return
    }
    const result = await setSecret(secret.trim(), { path, powershellPath: config.powershellPath })
    console.log(`已写入 ${result.path}`)
    console.log(`加密方式：Windows DPAPI（当前用户范围，backend=${result.backend}）；磁盘上只有密文，任何其他用户/机器都无法解开。`)
    if (!/^ark-/i.test(secret.trim())) {
      console.log('提示：该值不像方舟 API Key（通常以 ark- 开头），如确认无误可忽略。')
    }
    return
  }
  if (action === 'status') {
    const status = await describeApiKey({ config })
    const tiers = describeTiers(config.models)
    console.log(`凭据引用：${status.reference}`)
    console.log(`金库：${status.vault.configured ? '已配置' : '未配置'}  ${status.vault.path}`)
    console.log(`凭据服务：${status.credentialsServiceConfigured === undefined ? '不可用' : status.credentialsServiceConfigured ? '已配置' : '未配置'}`)
    console.log(`进程环境：${status.processEnvironmentConfigured ? '已配置' : '未配置'}`)
    console.log(`生效来源：${status.effectiveSource ?? '（无，生成会报 MISSING_CREDENTIAL）'}`)
    console.log(`默认档位：${config.defaultModel}；编辑档位：${config.editModel}`)
    for (const tier of tiers) console.log(`  ${tier.tier} → ${tier.modelId}`)
    return
  }
  if (action === 'clear') {
    await clearVault(path)
    console.log(`已删除 ${path}`)
    return
  }
  console.error(USAGE)
  process.exitCode = 2
}

function commandModels(config) {
  console.log(`网关：${config.baseUrl}`)
  console.log(`默认档位：${config.defaultModel}；编辑档位：${config.editModel}；产出目录：${config.outputDir}`)
  for (const tier of describeTiers(config.models)) {
    console.log(`\n${tier.tier}  (${tier.alias})`)
    console.log(`  Model ID      ${tier.modelId}`)
    console.log(`  画幅档位      ${tier.presets.join(' / ')}`)
    console.log(`  显式像素域    ${tier.pixelRange[0]} – ${tier.pixelRange[1]}（边长对齐 ${tier.multipleOf}）`)
    console.log(`  参考图上限    ${tier.maxReferences}`)
    console.log(`  一次多张      ${tier.sequential ? '支持（组图）' : '不支持（串行多次调用）'}`)
    console.log(`  联网搜索      ${tier.webSearch ? '支持' : '不支持'}`)
  }
}

async function commandProbe(config, flags) {
  const live = flags.live === true
  const rawIds = typeof flags['model-id'] === 'string' ? flags['model-id'].split(',').map((id) => id.trim()).filter((id) => id !== '') : []
  const requested = typeof flags.tier === 'string' ? flags.tier : undefined
  const targets = rawIds.length > 0
    ? rawIds.map((id) => ({ key: id, modelId: id, tier: resolveTier(requested ?? config.defaultModel, config.models, config.defaultModel).tier }))
    : (requested === undefined ? TIER_KEYS : [requested]).map((key) => {
        const resolved = resolveTier(key, config.models, config.defaultModel)
        return { key, modelId: resolved.modelId, tier: resolved.tier }
      })
  const credential = await resolveApiKey({ config })
  const client = new ArkClient({
    baseUrl: config.baseUrl,
    timeoutMs: config.requestTimeoutMs,
    rateLimitRetries: 0,
    rateLimitBackoffMs: config.rateLimitBackoffMs,
    log: (level, message) => console.error(`${level}: ${message}`),
  })
  console.log(`凭据来源：${credential.source}`)
  for (const target of targets) {
    const size = normalizeSize(undefined, target.tier)
    const body = { model: target.modelId, prompt: 'probe', size: size.value, response_format: 'url', watermark: false }
    if (!live) body.prompt = ''
    try {
      const result = await client.request(body, credential.value, undefined)
      console.log(`✓ ${target.key.padEnd(9)} ${target.modelId} —— 生成成功，返回 ${result.images.length} 张`)
      if (live) console.log('   （本次为真实计费调用；图片 URL 24 小时内有效，未落盘）')
    } catch (error) {
      const code = error instanceof SeedreamError ? error.code : 'UNKNOWN'
      if (!live && (code === 'INVALID_PARAMETER' || code === 'MISSING_PARAMETER')) {
        console.log(`✓ ${target.key.padEnd(9)} ${target.modelId} —— 模型可达（空 prompt 被拒是预期行为）`)
      } else if (code === 'MODEL_UNAVAILABLE') {
        console.log(`✗ ${target.key.padEnd(9)} ${target.modelId} —— 该账号下不可用：${error.message}`)
      } else {
        console.log(`? ${target.key.padEnd(9)} ${target.modelId} —— ${code}: ${error.message}`)
      }
    }
  }
}

async function commandGenerate(config, flags) {
  if (typeof flags.prompt !== 'string' || flags.prompt.trim() === '') {
    console.error('generate 需要 --prompt')
    process.exitCode = 2
    return
  }
  const cwd = typeof flags.cwd === 'string' ? flags.cwd : process.cwd()
  const value = await runSeedream({
    ctx: { get: () => undefined },
    config,
    log: (level, message) => console.error(`${level}: ${message}`),
    exec: { agent: { session: { header: { cwd } } }, signal: undefined },
    args: {
      prompt: flags.prompt,
      ...(typeof flags.model === 'string' ? { model: flags.model } : {}),
      ...(typeof flags.size === 'string' ? { size: flags.size } : {}),
      ...(flags.count === undefined ? {} : { count: Number(flags.count) }),
      ...(typeof flags.out === 'string' ? { output_dir: flags.out } : {}),
      ...(typeof flags.name === 'string' ? { name: flags.name } : {}),
    },
    mode: 'generate',
  })
  console.log(`模型 ${value.model}（档位 ${value.tier}）、画幅 ${value.size}、产出 ${value.saved} 张：`)
  for (const image of value.images) console.log(`  ${image.path}  ${image.mediaType}  ${image.bytes} 字节`)
  console.log(`本次计费 ${value.billedImages} 张，费用 ${value.costText}${value.estimated === true ? '（含未计价部分）' : ''}`)
  if (typeof value.todayCostText === 'string') console.log(`今日累计：${value.todayCostText}`)
  for (const note of value.notes) console.log(`  提示：${note}`)
}

async function commandBalance(config, flags) {
  const view = await buildBalanceView({ config, refresh: flags.refresh === true })
  console.log(renderBalanceView(view))
  if (view.billing.configured !== true) {
    console.log('\n提示：填 AK/SK 才能看到账户真实余额（界面「可用余额」区块，或环境变量 VOLC_ACCESSKEY / VOLC_SECRETKEY）。')
  }
}

async function commandUsage(config, flags, rest = []) {
  const action = rest.find((token) => !token.startsWith('--'))
  if (action === 'recost') {
    const result = await recostLedger({ config, dryRun: flags['dry-run'] === true })
    console.log(`${result.written ? '已重新计价' : '（试算，未写入）'} ${result.entries} 条记录：${result.path}`)
    console.log(`  重新计价前：${formatMoney(result.before.cost, result.currency)}（${result.before.images} 张）`)
    console.log(`  重新计价后：${formatMoney(result.after.cost, result.currency)}（${result.after.images} 张，未计价 ${result.after.unpricedImages} 张）`)
    if (result.written) console.log(`  备份：${result.backup}`)
    if (result.after.unpricedImages > 0) console.log('  仍有未计价张数：说明该模型还没填单价（seedream price set --tier ... --price ...）')
    return
  }
  const view = await buildUsageView({
    config,
    period: typeof flags.period === 'string' ? flags.period : 'today',
    detail: flags.detail === true,
  })
  console.log(renderUsage(view))
  console.log(`\n台账文件：${ledgerPathOf(config)}`)
}

async function commandPrice(config, flags, action) {
  const path = priceFilePathOf(config)
  if (action === 'show') {
    const table = await loadPrices({ config, modelIds: config.models })
    console.log(`币种：${table.currency}；高清档阈值：${table.highPixelThreshold} 像素`)
    console.log(`价格文件：${path}${table.sources.includes(path) ? '（已生效）' : '（尚无此文件）'}`)
    console.log('生效单价：')
    for (const line of describePriceTable(table, config.models)) console.log(`  ${line}`)
    if (typeof table.note === 'string') console.log(`价格来源：${table.note}`)
    if (table.sources.length > 0) console.log(`来源文件/配置：${table.sources.join('、')}`)
    return
  }
  if (action === 'set') {
    const tier = typeof flags.tier === 'string' ? flags.tier : ''
    const price = Number(flags.price)
    if (tier === '' || !Number.isFinite(price) || price <= 0) {
      console.error('用法：price set --tier 5.0-pro --price 0.32 [--high 0.95] [--threshold 2610000] [--currency CNY]')
      process.exitCode = 2
      return
    }
    const { modelId } = resolveTier(tier, config.models, config.defaultModel)
    const document = (await readPriceFile(path)) ?? {}
    const models = document.models !== null && typeof document.models === 'object' ? { ...document.models } : {}
    const entry = models[modelId] !== null && typeof models[modelId] === 'object' ? { ...models[modelId] } : {}
    entry.pricePerImage = price
    const high = Number(flags.high)
    if (Number.isFinite(high) && high > 0) entry.pricePerImageHigh = high
    models[modelId] = entry
    const next = {
      currency: typeof flags.currency === 'string' ? flags.currency : document.currency ?? config.priceCurrency,
      highPixelThreshold: Number.isFinite(Number(flags.threshold)) && Number(flags.threshold) > 0
        ? Number(flags.threshold)
        : document.highPixelThreshold ?? config.priceHighPixelThreshold,
      ...(typeof flags.note === 'string' ? { note: flags.note } : document.note === undefined ? {} : { note: document.note }),
      models,
    }
    await writePriceFile(path, next)
    console.log(`已写入 ${path}`)
    console.log(`  ${tier}（${modelId}）：${next.currency} ${price}/张${entry.pricePerImageHigh === undefined ? '' : `，超过 ${next.highPixelThreshold} 像素 ${entry.pricePerImageHigh}/张`}`)
    console.log('提示：插件每次生成都会重新读价表，改价立即生效；已记录的历史金额不会被改写。')
    return
  }
  if (action === 'clear') {
    const { rm } = await import('node:fs/promises')
    await rm(path, { force: true })
    console.log(`已删除 ${path}，单价回到「未配置」`)
    return
  }
  console.error('用法：price show | price set --tier 5.0-pro --price 0.32 | price clear')
  process.exitCode = 2
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const { flags } = parseArgs(rest)
  if (typeof flags.help === 'boolean' || command === undefined || command === 'help') {
    console.log(USAGE)
    return
  }
  const config = configFrom(flags)
  switch (command) {
    case 'key':
      await commandKey(flags, rest.find((token) => !token.startsWith('--')) ?? 'status')
      return
    case 'models':
      commandModels(config)
      return
    case 'probe':
      await commandProbe(config, flags)
      return
    case 'generate':
      await commandGenerate(config, flags)
      return
    case 'usage':
      await commandUsage(config, flags, rest)
      return
    case 'balance':
      await commandBalance(config, flags)
      return
    case 'price':
      await commandPrice(config, flags, rest.find((token) => !token.startsWith('--')) ?? 'show')
      return
    case 'decrypt-check': {
      const secret = await getSecret({ path: vaultPathOf(config), powershellPath: config.powershellPath })
      // 只报长度与不可逆指纹：连首字符都不打印，命令行回滚/日志里不会留下任何 Key 片段
      console.log(secret === undefined ? '金库未配置' : `解密成功：长度 ${secret.length}，指纹 ${keyHint(secret).hash}（不打印任何 Key 字符）`)
      return
    }
    default:
      console.log(USAGE)
      process.exitCode = 2
  }
}

main().catch((error) => {
  if (error instanceof SeedreamError) {
    console.error(`[${error.code}] ${error.message}`)
    process.exitCode = 1
    return
  }
  console.error(error)
  process.exitCode = 1
})
