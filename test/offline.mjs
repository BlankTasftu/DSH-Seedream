#!/usr/bin/env node
/**
 * 离线自检：不联网、不花钱，覆盖配置、档位能力、画幅归一、素材路径、
 * 图片嗅探/尺寸、工具 schema 与渲染、DPAPI 金库往返。
 *
 * 运行：node test/offline.mjs
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS, resolveConfig } from '../lib/config.js'
import { TIER_KEYS, normalizeSize, normalizeTierName, resolveTier } from '../lib/models.js'
import { readDimensions, planOutputPaths, resolveReference, slugify, sniffMediaType, toDataUrl } from '../lib/assets.js'
import { clearVault, ensureKeyHint, getSecret, keyHint, setSecret, vaultStatus } from '../lib/vault.js'
import { registerTools } from '../lib/tools.js'
import { SeedreamError, redactSecrets } from '../lib/errors.js'
import { estimateCost, loadPrices, priceForImage } from '../lib/pricing.js'
import { appendUsage, ledgerPathOf, readUsage, summarizeUsage } from '../lib/ledger.js'
import { buildUsageView, recostLedger, renderUsage } from '../lib/usage.js'
import { buildUiState, registerClientUi, registerIndexInjection, ROUTE_PREFIX } from '../lib/ui.js'
import { canonicalQueryString, extractBalance, formatXDate, signRequest } from '../lib/billing.js'
import { computeBudget, resetBalanceCache } from '../lib/balance.js'
import { readModelChoice, resolveEffectiveTier, writeModelChoice } from '../lib/model-choice.js'
import { billingStatus, billingVaultPathOf, clearBillingCredentials, queryBalance, resolveBillingCredentials, setBillingCredentials } from '../lib/billing.js'
import { setSecret as setSecretForHintTest } from '../lib/vault.js'

let passed = 0
let failed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  failures.push(`${label}${detail === undefined ? '' : ` —— ${detail}`}`)
}

function checkThrows(label, fn, expectedCode) {
  try {
    fn()
  } catch (error) {
    check(label, error instanceof SeedreamError && (expectedCode === undefined || error.code === expectedCode), `code=${error.code} message=${error.message}`)
    return
  }
  check(label, false, '未抛出异常')
}

async function checkRejects(label, fn, expectedCode) {
  try {
    await fn()
  } catch (error) {
    check(label, error instanceof SeedreamError && (expectedCode === undefined || error.code === expectedCode), `code=${error.code} message=${error.message}`)
    return
  }
  check(label, false, '未抛出异常')
}

/** 伪造一个 IncomingMessage：足够 readBody 与栅栏使用。 */
function fakeRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const emitter = new EventEmitter()
  emitter.method = method
  emitter.url = url
  emitter.headers = headers
  emitter.destroy = () => {}
  setImmediate(() => {
    if (body !== undefined) emitter.emit('data', Buffer.from(body, 'utf8'))
    emitter.emit('end')
  })
  return emitter
}

/** 伪造一个 ServerResponse：记录状态码、响应头与正文。 */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    headersSent: false,
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers ?? null
      this.headersSent = true
    },
    end(text) {
      if (text !== undefined) this.body += String(text)
    },
  }
}

// —— 极简 JSON Schema 子集校验器：对齐 DSH 工具注册表的受支持子集 ——
function validate(schema, value, path = '') {
  const problems = []
  const at = path === '' ? 'value' : path
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [`${at} 不是对象`]
    for (const key of schema.required ?? []) {
      if (!(key in value)) problems.push(`${at}.${key} 缺失`)
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (!(key in value) || value[key] === undefined) continue
      problems.push(...validate(child, value[key], path === '' ? key : `${path}.${key}`))
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (schema.properties ?? {}))) problems.push(`${at}.${key} 不在 schema 中`)
      }
    }
    return problems
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${at} 不是数组`]
    value.forEach((entry, index) => problems.push(...validate(schema.items ?? {}, entry, `${path}[${index}]`)))
    return problems
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return [`${at} 不是字符串`]
    if (schema.enum !== undefined && !schema.enum.includes(value)) return [`${at}=${value} 不在枚举内`]
    return []
  }
  if (schema.type === 'number') return typeof value === 'number' ? [] : [`${at} 不是数字`]
  if (schema.type === 'integer') return Number.isInteger(value) ? [] : [`${at} 不是整数`]
  if (schema.type === 'boolean') return typeof value === 'boolean' ? [] : [`${at} 不是布尔`]
  return []
}

// —— 1x1 PNG（含合法 IHDR）—— 用于嗅探与尺寸读取 ——
function onePixelPng() {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'latin1')
  ihdr.writeUInt32BE(1, 8)
  ihdr.writeUInt32BE(1, 12)
  ihdr[16] = 8
  ihdr[17] = 6
  return Buffer.concat([signature, ihdr])
}

async function main() {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-seedream-test-'))

  // —— 配置 ——
  const config = resolveConfig(undefined)
  check('默认配置：默认档位', config.defaultModel === DEFAULTS.defaultModel)
  check('默认配置：产出目录', config.outputDir === 'images/seedream')
  check('默认配置：模型 ID 映射齐全', TIER_KEYS.every((key) => typeof config.models[key] === 'string' && config.models[key] !== ''))
  check('配置覆盖：baseUrl 去尾斜杠', resolveConfig({ baseUrl: 'https://example.com/api/v3/' }).baseUrl === 'https://example.com/api/v3')
  checkThrows('配置非法：baseUrl', () => resolveConfig({ baseUrl: 'ftp://x' }), 'INVALID_ARGUMENT')
  checkThrows('配置非法：defaultModel', () => resolveConfig({ defaultModel: '4.0' }), 'INVALID_ARGUMENT')
  checkThrows('配置非法：requestTimeoutMs', () => resolveConfig({ requestTimeoutMs: -1 }), 'INVALID_ARGUMENT')
  check('配置覆盖：模型 ID', resolveConfig({ model5Pro: 'ep-demo-123' }).models['5.0-pro'] === 'ep-demo-123')

  // —— 档位与画幅 ——
  const pro = resolveTier('5.0-pro', config.models, '5.0-pro')
  const lite = resolveTier('5.0-flash', config.models, '5.0-pro')
  check('档位解析：默认 ID', pro.modelId === 'doubao-seedream-5-0-pro-260628', pro.modelId)
  check('档位解析：覆盖 ID', resolveTier('5.0-flash', { '5.0-flash': 'ep-abc' }, '5.0-pro').modelId === 'ep-abc')
  checkThrows('档位解析：未知档位', () => resolveTier('4.5', config.models, '5.0-pro'), 'INVALID_ARGUMENT')
  // 历史别名：早期版本把 flash 档叫 `5.0`，台账 / 配置 / 选择文件里可能还留着
  check('档位解析：历史别名 5.0 → 5.0-flash', normalizeTierName('5.0') === '5.0-flash', normalizeTierName('5.0'))
  check('档位解析：别名能解析出同一 Model ID', resolveTier('5.0', config.models, '5.0-pro').modelId === config.models['5.0-flash'])
  check('档位解析：现行名称原样返回', normalizeTierName('5.0-pro') === '5.0-pro' && normalizeTierName('5.0-flash') === '5.0-flash')
  check('档位：枚举顺序 pro 在前', TIER_KEYS.join(',') === '5.0-pro,5.0-flash', TIER_KEYS.join(','))
  check('画幅：缺省 2K', normalizeSize(undefined, pro.tier).value === '2K')
  check('画幅：小写档位归一', normalizeSize('4k', lite.tier).value === '4K')
  checkThrows('画幅：lite 不支持 1K', () => normalizeSize('1K', lite.tier), 'INVALID_ARGUMENT')
  checkThrows('画幅：pro 不支持 4K', () => normalizeSize('4K', pro.tier), 'INVALID_ARGUMENT')
  checkThrows('画幅：格式非法', () => normalizeSize('宽屏', pro.tier), 'INVALID_ARGUMENT')
  const upscaled = normalizeSize('1024x1024', lite.tier)
  const upscaledPixels = upscaled.value.split('x').map(Number)
  check('画幅：低于下限等比放大', upscaledPixels[0] * upscaledPixels[1] >= lite.tier.minPixels, upscaled.value)
  const downscaled = normalizeSize('8000x8000', lite.tier)
  const downscaledPixels = downscaled.value.split('x').map(Number)
  check('画幅：超出上界等比缩小', downscaledPixels[0] * downscaledPixels[1] <= lite.tier.maxPixels, downscaled.value)
  const proExplicit = normalizeSize('100x100', pro.tier)
  const proPixels = proExplicit.value.split('x').map(Number)
  check('画幅：pro 显式值进入合法域', proPixels[0] * proPixels[1] >= pro.tier.minPixels && proPixels[0] * proPixels[1] <= pro.tier.maxPixels, proExplicit.value)
  check('画幅：pro 边长 16 对齐', proPixels[0] % 16 === 0 && proPixels[1] % 16 === 0, proExplicit.value)
  checkThrows('画幅：极端宽高比被拒', () => normalizeSize('4000x100', lite.tier), 'INVALID_ARGUMENT')

  // —— 素材 ——
  const png = onePixelPng()
  check('嗅探：PNG', sniffMediaType(png) === 'image/png')
  check('嗅探：JPEG', sniffMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])) === 'image/jpeg')
  check('嗅探：GIF', sniffMediaType(Buffer.from('GIF89a', 'latin1')) === 'image/gif')
  check('嗅探：未知', sniffMediaType(Buffer.from('not-an-image')) === undefined)
  const dimensions = readDimensions(png, 'image/png')
  check('尺寸：PNG IHDR', dimensions?.width === 1 && dimensions?.height === 1, JSON.stringify(dimensions))
  check('slug：非 ASCII 折叠', slugify('一只赛博朋克猫 Cat #1') === 'cat-1', slugify('一只赛博朋克猫 Cat #1'))
  check('slug：空值兜底', slugify('') === 'image')
  check('data URL：格式名小写', toDataUrl(png, 'image/png').startsWith('data:image/png;base64,'))

  const planned = planOutputPaths({ cwd: workspace, outputDir: 'images/seedream', allowOutsideCwd: false, slug: 'demo', extensions: ['png', 'jpg'] })
  check('输出路径：数量与扩展名', planned.paths.length === 2 && planned.paths[0].endsWith('-1.png') && planned.paths[1].endsWith('-2.jpg'), planned.paths.join(','))
  checkThrows('输出路径：逃逸被拒', () => planOutputPaths({ cwd: workspace, outputDir: '..\\escape', allowOutsideCwd: false, slug: 'x', extensions: ['png'] }), 'INVALID_ARGUMENT')

  await writeFile(join(workspace, 'ref.png'), png)
  const fileReference = await resolveReference('ref.png', { cwd: workspace, allowOutsideCwd: false })
  check('参考图：本地文件转 data URL', fileReference.kind === 'file' && fileReference.value.startsWith('data:image/png;base64,'))
  check('参考图：HTTP URL 透传', (await resolveReference('https://example.com/a.png', { cwd: workspace, allowOutsideCwd: false })).kind === 'url')
  await checkRejects('参考图：不存在', () => resolveReference('missing.png', { cwd: workspace, allowOutsideCwd: false }), 'INVALID_ARGUMENT')
  await checkRejects('参考图：逃逸被拒', () => resolveReference('..\\..\\windows\\win.ini', { cwd: workspace, allowOutsideCwd: false }), 'INVALID_ARGUMENT')

  // —— 工具注册与 schema ——
  const definitions = []
  const ctx = { get: () => undefined, tools: { register: (definition) => { definitions.push(definition); return () => {} } }, effect: () => {} }
  registerTools(ctx, config, () => {})
  check('工具：注册五个', definitions.length === 5, definitions.map((d) => d.name).join(','))
  const byName = Object.fromEntries(definitions.map((definition) => [definition.name, definition]))
  check('工具：generate 存在', byName.seedream_generate !== undefined)
  check('工具：edit 存在', byName.seedream_edit !== undefined)
  check('工具：status 存在', byName.seedream_status !== undefined)
  check('工具：usage 存在', byName.seedream_usage !== undefined)
  check('工具：balance 存在', byName.seedream_balance !== undefined)
  for (const definition of definitions) {
    check(`工具 ${definition.name}：有输出 schema 与同步 render`, typeof definition.output?.render === 'function')
    check(`工具 ${definition.name}：params 是对象根`, definition.parameters?.type === 'object' && typeof definition.parameters.properties === 'object')
    check(`工具 ${definition.name}：timeoutMs 合法`, definition.timeoutMs === undefined || definition.timeoutMs > 0)
  }
  check('工具参数：generate 必填 prompt', (byName.seedream_generate.parameters.required ?? []).includes('prompt'))
  check('工具参数：edit 必填 images', (byName.seedream_edit.parameters.required ?? []).includes('images'))
  check('工具参数：model 枚举为三档', JSON.stringify(byName.seedream_generate.parameters.properties.model.enum) === JSON.stringify([...TIER_KEYS]))

  const synthetic = {
    tier: '5.0-pro',
    model: 'doubao-seedream-5-0-pro-260628',
    size: '2K',
    prompt: '一只猫',
    saved: 1,
    billedImages: 1,
    costText: '¥0.32',
    credentialSource: 'DPAPI 金库（demo）',
    directory: 'images/seedream',
    images: [
      { path: 'images/seedream/a.png', display: 'images/seedream/a.png', mediaType: 'image/png', bytes: 1234, width: 2048, height: 2048, attachmentId: 'att-1', attachmentName: 'a.png' },
    ],
    failures: [],
    notes: ['测试'],
  }
  const outputProblems = validate(byName.seedream_generate.output.schema, synthetic)
  check('输出 schema：合成 value 通过校验', outputProblems.length === 0, outputProblems.join('; '))
  const blocks = byName.seedream_generate.output.render({}, synthetic)
  check('渲染：文本 + 真图内容块', blocks[0].type === 'text' && blocks[1]?.type === 'image' && blocks[1].attachment.attachmentId === 'att-1', JSON.stringify(blocks.map((b) => b.type)))
  const withoutSaved = { ...synthetic }
  delete withoutSaved.saved
  const missing = validate(byName.seedream_generate.output.schema, withoutSaved)
  check('输出 schema：缺字段会被发现', missing.length > 0, missing.join('; '))

  const statusValue = {
    configured: true,
    effectiveSource: 'vault',
    reference: 'ARK_API_KEY',
    vaultPath: 'C:/demo/vault.json',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: '5.0-pro',
    editModel: '5.0-pro',
    outputDir: 'images/seedream',
    allowOutsideCwd: false,
    usage: '今天 2 张 / ¥0.64；累计 9 张 / ¥2.88',
    balance: '本地预算剩余 45.95 CNY（已花 4.05/50）',
    priceTable: ['5.0-pro: ¥0.32/张，超过 2610000 像素 ¥0.95/张'],
    tiers: [
      {
        tier: '5.0-flash',
        alias: 'Seedream 5.0',
        modelId: 'doubao-seedream-5-0-260128',
        presets: ['2K', '3K', '4K'],
        pixelRange: [3686400, 16777216],
        multipleOf: 1,
        maxReferences: 14,
        sequential: true,
        outputFormat: true,
        webSearch: true,
      },
    ],
  }
  const statusProblems = validate(byName.seedream_status.output.schema, statusValue)
  check('输出 schema：status 合成 value 通过校验', statusProblems.length === 0, statusProblems.join('; '))
  const statusBlocks = byName.seedream_status.output.render({}, statusValue)
  check('渲染：status 文本块', statusBlocks[0].type === 'text' && statusBlocks[0].text.includes('<configured>true</configured>'), '')

  // —— 计价与台账 ——
  const pricedConfig = resolveConfig({
    ledgerPath: join(workspace, 'usage.jsonl'),
    priceFilePath: join(workspace, 'prices.json'),
    price5: 0.18,
    price5Pro: 0.32,
    price5ProHigh: 0.95,
  })
  const table = await loadPrices({ config: pricedConfig, modelIds: pricedConfig.models })
  check('价表：配置单价生效', table.models['doubao-seedream-5-0-pro-260628'].pricePerImage === 0.32, JSON.stringify(table.models))
  check('价表：高清档阈值默认', table.highPixelThreshold === 2610000)
  const lowBand = priceForImage(table, 'doubao-seedream-5-0-pro-260628', 1024 * 1024)
  check('计价：1K 走基准档', lowBand.price === 0.32 && lowBand.band === 'base', JSON.stringify(lowBand))
  const highBand = priceForImage(table, 'doubao-seedream-5-0-pro-260628', 2048 * 2048)
  check('计价：2K 走高價档', highBand.price === 0.95 && highBand.band === 'high', JSON.stringify(highBand))
  const twoImages = estimateCost(table, 'doubao-seedream-5-0-pro-260628', [{ width: 1024, height: 1024 }, { width: 1024, height: 1024 }], 2)
  check('计价：两张合计', twoImages.cost === 0.64 && twoImages.priced === 2, JSON.stringify(twoImages))
  const unpriced = estimateCost({ currency: 'CNY', highPixelThreshold: 1, models: {} }, 'unknown-model', [{ width: 10, height: 10 }], 1)
  check('计价：未知模型 → 未计价', unpriced.cost === null && unpriced.unpriced === 1, JSON.stringify(unpriced))
  const mixed = estimateCost({ currency: 'CNY', highPixelThreshold: 4_000_000, models: { m: { pricePerImage: 1, pricePerImageHigh: null } } }, 'm', [{ width: 1024, height: 1024 }, { width: 2048, height: 2048 }], 2)
  check('计价：高价档回退基准档', mixed.cost === 2 && mixed.priced === 2, JSON.stringify(mixed))

  const ledgerPath = ledgerPathOf(pricedConfig)
  // 模拟「填价之前」记录的两条：金额为空、unpriced=1，正是 recost 要补齐的形态。
  const proModelId = pricedConfig.models['5.0-pro']
  const flashModelId = pricedConfig.models['5.0-flash']
  await appendUsage({ ts: new Date().toISOString(), mode: 'generate', tier: '5.0-pro', model: proModelId, size: '1024x1024', images: [{ width: 1024, height: 1024, bytes: 1 }], billed: 1, outputTokens: 4096, currency: 'CNY', cost: null, unitPrices: [null], priced: 0, unpriced: 1 }, ledgerPath)
  await appendUsage({ ts: new Date(Date.now() - 8 * 86_400_000).toISOString(), mode: 'generate', tier: '5.0-flash', model: flashModelId, size: '2048x2048', images: [{ width: 2048, height: 2048, bytes: 1 }], billed: 1, outputTokens: 4096, currency: 'CNY', cost: null, unitPrices: [null], priced: 0, unpriced: 1 }, ledgerPath)
  const ledger = await readUsage(ledgerPath)
  check('台账：读到两条', ledger.entries.length === 2 && ledger.skipped === 0, JSON.stringify(ledger.skipped))
  const todaySummary = summarizeUsage(ledger.entries, 'today')
  check('台账：今天只算 1 条（未计价）', todaySummary.calls === 1 && todaySummary.images === 1 && todaySummary.hasCost === false && todaySummary.unpricedImages === 1, JSON.stringify(todaySummary))
  const allSummary = summarizeUsage(ledger.entries, 'all')
  check('台账：全部累计', allSummary.calls === 2 && allSummary.images === 2 && allSummary.unpricedImages === 2, JSON.stringify(allSummary))
  check('台账：近 7 天排除 8 天前', summarizeUsage(ledger.entries, 'week').calls === 1)
  check('台账：按档位分解', allSummary.byTier.length === 2, JSON.stringify(allSummary.byTier))
  checkThrows('台账：未知周期', () => summarizeUsage(ledger.entries, 'quarter'), 'INVALID_ARGUMENT')

  const usageView = await buildUsageView({ config: pricedConfig, period: 'all', detail: true })
  const usageProblems = validate(byName.seedream_usage.output.schema, usageView)
  check('用量视图：通过自身 schema 校验', usageProblems.length === 0, usageProblems.join('; '))
  const usageText = renderUsage(usageView)
  check('用量视图：未计价时如实标注', usageView.costText === '单价未配置' && usageText.includes('<unpriced-images>2</unpriced-images>'), usageView.costText)
  check('用量视图：含按档位分解与免责声明', usageText.includes('<by-tier>') && usageText.includes('不是官方账单'))
  check('用量视图：明细条数', usageView.recent.length === 2, JSON.stringify(usageView.recent.length))
  const emptyView = await buildUsageView({ config: resolveConfig({ ledgerPath: join(workspace, 'empty.jsonl'), priceFilePath: join(workspace, 'none.json') }), period: 'today' })
  check('用量视图：空台账金额为 0 且标明未配置', emptyView.calls === 0 && emptyView.costText === '¥0.0000', `${emptyView.calls} ${emptyView.costText}`)
  check('用量视图：未配置单价时给出未计价提示', JSON.stringify(emptyView.priceTable).includes('单价未配置'), JSON.stringify(emptyView.priceTable))

  // 历史条目在填价前记录 → 报告要给出「用 recost 补齐」的引导，而不是让人以为坏了
  check('用量视图：给出补齐历史的引导', typeof usageView.hint === 'string' && usageView.hint.includes('recost'), usageView.hint)
  const recostDry = await recostLedger({ config: pricedConfig, dryRun: true })
  check('重新计价：试算不改写文件', recostDry.written === false && recostDry.after.cost > recostDry.before.cost, `${recostDry.before.cost} → ${recostDry.after.cost}`)
  check('重新计价：按价表算准金额（1K 基准档 + 2K 高清档）', Math.abs(recostDry.after.cost - (0.32 + 0.18)) < 1e-9, JSON.stringify(recostDry.after.cost))
  const recostReal = await recostLedger({ config: pricedConfig })
  check('重新计价：正式写入并留备份', recostReal.written === true && recostReal.after.unpricedImages === 0)
  const afterRecost = await buildUsageView({ config: pricedConfig, period: 'all' })
  check('重新计价后：金额出现在报告里', afterRecost.costText === '¥0.50', afterRecost.costText)
  check('重新计价后：不再有未计价提示', afterRecost.hint === undefined, afterRecost.hint)

  // —— 客户端界面（宿主侧）：注入行、路由、信任栅栏、状态与写操作 ——
  const uiConfig = resolveConfig({
    ledgerPath: join(workspace, 'ui-usage.jsonl'),
    priceFilePath: join(workspace, 'ui-prices.json'),
    vaultPath: join(workspace, 'ui-vault', 'ark-key.vault.json'),
    // 余额相关也必须落在临时目录：否则测试会写进用户的真实 DSH_HOME
    billingVaultPath: join(workspace, 'ui-vault', 'billing.vault.json'),
    budgetFilePath: join(workspace, 'ui-budget.json'),
    modelChoicePath: join(workspace, 'ui-model.json'),
    budgetTotal: 200,
    price5Pro: 0.4,
  })
  const registered = []
  const unsetCalls = []
  const fakeCredentials = {
    resolve: async () => undefined,
    describe: async () => ({ configured: false, writable: true }),
    set: async () => {},
    unset: async (ref) => { unsetCalls.push(ref) },
  }
  const uiCtx = {
    webServer: { register: (definition) => { registered.push(definition); return () => {} } },
    get: (name) => (name === 'credentials' ? fakeCredentials : undefined),
    logger: { info() {}, warn() {} },
  }
  registerClientUi(uiCtx, uiConfig, () => {})
  check('界面：注册 9 条路由', registered.length === 9, registered.map((definition) => definition.path).join(','))
  check('界面：路由都在插件前缀下', registered.every((definition) => definition.path.startsWith(ROUTE_PREFIX) && definition.kind === 'exact'))
  check('界面：路由不含契约外的 method 字段', registered.every((definition) => definition.method === undefined), JSON.stringify(Object.keys(registered[0] ?? {})))

  const injectTable = []
  const captureInjection = { on: (_event, handler) => { handler(injectTable); return () => {} } }
  const injectionDisposer = registerIndexInjection(captureInjection)
  check('界面：推入 script 注入行', injectTable.length === 1 && injectTable[0].kind === 'script' && injectTable[0].placement === 'body' && injectTable[0].text.includes(`${ROUTE_PREFIX}/client.js`), JSON.stringify(injectTable))
  registerIndexInjection(captureInjection)
  check('界面：注入行去重', injectTable.length === 1, String(injectTable.length))
  check('界面注入行：是可调用的卸载函数', typeof injectionDisposer === 'function')

  const loopbackHeaders = { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' }
  const call = async (path, options = {}) => {
    const definition = registered.find((item) => item.path === path)
    const req = fakeRequest({
      method: options.method ?? 'GET',
      url: path,
      headers: options.headers ?? loopbackHeaders,
      body: options.body,
    })
    const res = fakeResponse()
    await definition.handler(req, res)
    return res
  }

  const scriptResponse = await call(`${ROUTE_PREFIX}/client.js`)
  check('界面：下发客户端脚本', scriptResponse.statusCode === 200 && String(scriptResponse.headers['Content-Type']).includes('javascript') && scriptResponse.body.includes('__DSH_SEEDREAM_UI__'), String(scriptResponse.statusCode))

  const stateResponse = await call(`${ROUTE_PREFIX}/state`)
  const state = JSON.parse(stateResponse.body)
  check('界面：状态接口可用', stateResponse.statusCode === 200 && state.ok === true, String(stateResponse.statusCode))
  check('界面：状态含用量与价表', typeof state.usage.today.images === 'number' && Array.isArray(state.prices.entries) && state.tiers.length === TIER_KEYS.length)
  // 断言方式刻意做成「通用形态」：不写任何真实 Key 片段，只匹配 ark- 开头的疑似令牌
  check('界面：状态不回传 Key 明文', !/ark-[0-9a-f]{8}/i.test(stateResponse.body) && state.key.source !== undefined)

  const crossSite = await call(`${ROUTE_PREFIX}/state`, { headers: { ...loopbackHeaders, 'sec-fetch-site': 'cross-site' } })
  check('栅栏：跨站请求被拒', crossSite.statusCode === 403, String(crossSite.statusCode))
  const crossOrigin = await call(`${ROUTE_PREFIX}/state`, { headers: { host: '127.0.0.1:19387', origin: 'http://evil.example' } })
  check('栅栏：Origin 不同源被拒', crossOrigin.statusCode === 403, String(crossOrigin.statusCode))
  const remoteWrite = await call(`${ROUTE_PREFIX}/key`, { method: 'POST', headers: { host: 'evil.example', origin: 'http://evil.example' }, body: JSON.stringify({ value: 'x' }) })
  check('栅栏：非本机写请求被拒', remoteWrite.statusCode === 403, String(remoteWrite.statusCode))
  const emptyKey = await call(`${ROUTE_PREFIX}/key`, { method: 'POST', body: JSON.stringify({ value: '   ' }) })
  check('界面：空 Key 被拒', emptyKey.statusCode === 400 && JSON.parse(emptyKey.body).code === 'INVALID_ARGUMENT', emptyKey.body.slice(0, 80))

  const priceWrite = await call(`${ROUTE_PREFIX}/price`, { method: 'POST', body: JSON.stringify({ tier: '5.0-flash', price: 0.18, note: '界面写入测试' }) })
  check('界面：写入单价', priceWrite.statusCode === 200 && JSON.parse(priceWrite.body).ok === true, priceWrite.body.slice(0, 120))
  const pricedState = JSON.parse((await call(`${ROUTE_PREFIX}/state`)).body)
  const flashEntry = pricedState.prices.entries.find((entry) => entry.tier === '5.0-flash')
  check('界面：单价写入后状态同步', flashEntry.price === 0.18 && pricedState.prices.note === '界面写入测试', JSON.stringify(flashEntry))
  const badPrice = await call(`${ROUTE_PREFIX}/price`, { method: 'POST', body: JSON.stringify({ tier: '5.0-flash', price: -1 }) })
  check('界面：非法单价被拒', badPrice.statusCode === 400, String(badPrice.statusCode))

  const recostResponse = await call(`${ROUTE_PREFIX}/recost`, { method: 'POST', body: '{}' })
  check('界面：重新计价接口可用', recostResponse.statusCode === 200 && JSON.parse(recostResponse.body).ok === true, recostResponse.body.slice(0, 120))

  try {
    const secret = `ark-ui-test-${Date.now()}`
    const keyWrite = await call(`${ROUTE_PREFIX}/key`, { method: 'POST', body: JSON.stringify({ value: secret }) })
    const vaultText = await readFile(uiConfig.vaultPath, 'utf8')
    const keyState = JSON.parse((await call(`${ROUTE_PREFIX}/state`)).body)
    check('界面：写入 Key 到 DPAPI 金库', keyWrite.statusCode === 200 && JSON.parse(keyWrite.body).configured === true, keyWrite.body.slice(0, 120))
    check('界面：金库文件无明文', !vaultText.includes(secret), vaultText.slice(0, 60))
    check('界面：状态显示 key 已配置且来源为金库', keyState.key.configured === true && keyState.key.source === 'vault', JSON.stringify(keyState.key))
    check('界面：状态接口不回显 Key', !JSON.stringify(keyState).includes(secret))
    check('界面：首次写入 replaced=false', JSON.parse(keyWrite.body).replaced === false, keyWrite.body.slice(0, 120))
    check('界面：写入即返回指纹', typeof JSON.parse(keyWrite.body).hint?.hash === 'string' && JSON.parse(keyWrite.body).hint.length === secret.length, JSON.stringify(JSON.parse(keyWrite.body).hint))

    // 修改（替换）已配置的 Key
    const replacedSecret = 'ark-synthetic-0002-wxyz'
    const replaceWrite = await call(`${ROUTE_PREFIX}/key`, { method: 'POST', body: JSON.stringify({ value: replacedSecret }) })
    const replacePayload = JSON.parse(replaceWrite.body)
    check('界面：替换已配置的 Key', replaceWrite.statusCode === 200 && replacePayload.replaced === true, replaceWrite.body.slice(0, 140))
    check('界面：替换后指纹更新', replacePayload.hint.suffix === 'wxyz' && replacePayload.previousHint !== null, JSON.stringify(replacePayload.hint))
    const replacedVaultText = await readFile(uiConfig.vaultPath, 'utf8')
    check('界面：替换后金库内仍是密文', !replacedVaultText.includes(replacedSecret))
    const stateAfterReplace = JSON.parse((await call(`${ROUTE_PREFIX}/state`)).body)
    check('界面：状态显示替换后的指纹', stateAfterReplace.key.hint?.suffix === 'wxyz', JSON.stringify(stateAfterReplace.key.hint))
    check('界面：状态含来源明细与可删标记', typeof stateAfterReplace.key.sources === 'object' && stateAfterReplace.key.canClearCredentials === true, JSON.stringify(stateAfterReplace.key.sources))

    // 旧格式金库：补写指纹（不改动密文，仍可解密）
    const legacyDoc = JSON.parse(await readFile(uiConfig.vaultPath, 'utf8'))
    delete legacyDoc.hint
    await writeFile(uiConfig.vaultPath, `${JSON.stringify(legacyDoc, null, 2)}\n`, 'utf8')
    const backfilled = await ensureKeyHint({ path: uiConfig.vaultPath })
    const afterBackfill = JSON.parse(await readFile(uiConfig.vaultPath, 'utf8'))
    check('金库：旧记录可补写指纹', backfilled?.suffix === 'wxyz', JSON.stringify(backfilled))
    check('金库：补写只加指纹不动密文', afterBackfill.payload === legacyDoc.payload && afterBackfill.hint.suffix === 'wxyz')
    check('金库：补写后仍可解密', (await getSecret({ path: uiConfig.vaultPath })) === replacedSecret)

    const keyClear = await call(`${ROUTE_PREFIX}/key`, { method: 'POST', body: JSON.stringify({ clear: true }) })
    check('界面：清除 Key', keyClear.statusCode === 200 && JSON.parse(keyClear.body).cleared === true)
    const stateAfterClear = JSON.parse((await call(`${ROUTE_PREFIX}/state`)).body)
    check('界面：清除后状态回到未配置', stateAfterClear.key.configured === false && stateAfterClear.key.hint === null, JSON.stringify(stateAfterClear.key))
  } catch (error) {
    if (error instanceof SeedreamError && error.code === 'POWERSHELL_MISSING') {
      console.log('跳过界面 Key 写入测试：本机没有可用的 PowerShell（见 lib/vault.js）')
    } else {
      check('界面：Key 写入往返', false, error instanceof Error ? error.message : String(error))
    }
  }

  // 指纹是纯函数，不依赖 PowerShell
  const pureHint = keyHint('ark-1234-5678-abcd')
  check('指纹：首尾与长度', pureHint.prefix === 'ark-' && pureHint.suffix === 'abcd' && pureHint.length === 18, JSON.stringify(pureHint))
  check('指纹：8 位十六进制哈希', /^[0-9a-f]{8}$/.test(pureHint.hash))

  // —— 泄露面兜底：任何出口文本都要先擦除疑似凭据 ——
  const redacted = redactSecrets('fetch failed: Invalid header "Bearer ark-PLACEHOLDER-NOT-A-REAL-KEY"')
  check('擦除：疑似凭据被替换', !/ark-PLACEHOLDER/.test(redacted) && redacted.includes('REDACTED'), redacted)
  check('擦除：不误伤普通文本', redactSecrets('ark- 与 normal text').includes('normal text') && redactSecrets('dark-mode').includes('dark-mode'))

  // —— 指纹可整体关闭（uiKeyHint=false 时既不返回也不解密）——
  const hintOffConfig = resolveConfig({
    ledgerPath: join(workspace, 'ui-usage.jsonl'),
    priceFilePath: join(workspace, 'ui-prices.json'),
    vaultPath: join(workspace, 'ui-vault', 'ark-key.vault.json'),
    uiKeyHint: false,
  })
  const hintOffState = await buildUiState({ config: hintOffConfig, ctx: uiCtx })
  check('界面：uiKeyHint=false 时不返回指纹', hintOffState.key.hint === null && hintOffState.key.hintEnabled === false, JSON.stringify(hintOffState.key.hint))

  // ================= 对话窗口的模型选择器 =================

  // —— 1. 优先级：工具显式传参 > 界面选择 > 配置默认 ——
  check('档位：未选择时用配置默认', resolveEffectiveTier({ config: uiConfig, requested: '', fallback: '5.0-pro' }).tier === '5.0-pro')
  check(
    '档位：界面选择优先于配置默认',
    resolveEffectiveTier({ config: uiConfig, requested: '', fallback: '5.0-pro', choice: { tier: '5.0-flash' } }).source === 'ui' &&
      resolveEffectiveTier({ config: uiConfig, requested: '', fallback: '5.0-pro', choice: { tier: '5.0-flash' } }).tier === '5.0-flash',
  )
  check(
    '档位：显式传参优先于界面选择',
    resolveEffectiveTier({ config: uiConfig, requested: '5.0-pro', fallback: '5.0-pro', choice: { tier: '5.0-flash' } }).source === 'request',
  )

  // —— 2. 选择文件的读写与清除 ——
  await writeModelChoice(uiConfig, '5.0-flash')
  check('档位：写入后读回一致', (await readModelChoice(uiConfig))?.tier === '5.0-flash')
  await checkRejects('档位：拒绝未知档位', () => writeModelChoice(uiConfig, '4.5'), 'INVALID_ARGUMENT')
  const modelState = JSON.parse((await call(`${ROUTE_PREFIX}/state`)).body)
  check('档位：状态里带选择与来源', modelState.modelChoice.tier === '5.0-flash' && modelState.modelChoice.source === 'ui', JSON.stringify(modelState.modelChoice))
  check('档位：状态带选择器开关', modelState.ui.modelPicker === true, JSON.stringify(modelState.ui))
  const modelRoute = await call(`${ROUTE_PREFIX}/model`, { method: 'POST', body: JSON.stringify({ tier: '5.0-pro' }) })
  check('档位路由：可切换档位', modelRoute.statusCode === 200 && JSON.parse(modelRoute.body).tier === '5.0-pro', modelRoute.body.slice(0, 120))
  const badModelRoute = await call(`${ROUTE_PREFIX}/model`, { method: 'POST', body: JSON.stringify({ tier: '4.0' }) })
  check('档位路由：非法档位被拒', badModelRoute.statusCode === 400, String(badModelRoute.statusCode))
  const modelClearRoute = await call(`${ROUTE_PREFIX}/model`, { method: 'POST', body: JSON.stringify({ clear: true }) })
  check('档位路由：可恢复默认', modelClearRoute.statusCode === 200 && JSON.parse(modelClearRoute.body).selectedTier === null, modelClearRoute.body.slice(0, 120))

  // —— 3. 界面文案与选项（客户端按 state 组装，这里验证 state 提供的原料）——
  const pickerTiers = modelState.tiers.map((tier) => tier.tier)
  check('档位：state.tiers 提供选择项', pickerTiers.length === TIER_KEYS.length && pickerTiers.every((tier) => TIER_KEYS.includes(tier)), JSON.stringify(pickerTiers))
  check(
    '档位：state.prices 提供单价（用于选项文案）',
    Array.isArray(modelState.prices.entries) && modelState.prices.entries.some((entry) => typeof entry.price === 'number'),
    JSON.stringify(modelState.prices.entries),
  )

  // —— 4. 生成的 note 会说明档位来自界面 ——（用 runSeedream 的解析路径单独验证，避免联网）
  const resolvedFromUi = resolveEffectiveTier({ config: uiConfig, requested: '', fallback: '5.0-pro', choice: { tier: '5.0-flash' } })
  check('档位：来自界面时会被标注', resolvedFromUi.source === 'ui')

  // —— 5. 历史档位名的归一（台账 / 选择文件）——
  const legacySummary = summarizeUsage(
    [
      { ts: new Date().toISOString(), tier: '5.0', cost: 1, billed: 1, unpriced: 0 },
      { ts: new Date().toISOString(), tier: '5.0-flash', cost: 2, billed: 1, unpriced: 0 },
    ],
    'all',
  )
  check(
    '台账：历史档位名归一到 5.0-flash',
    legacySummary.byTier.length === 1 && legacySummary.byTier[0].tier === '5.0-flash' && legacySummary.byTier[0].images === 2,
    JSON.stringify(legacySummary.byTier.map((bucket) => ({ tier: bucket.tier, images: bucket.images }))),
  )
  await writeFile(join(workspace, 'legacy-model.json'), JSON.stringify({ tier: '5.0' }), 'utf8')
  const legacyChoiceConfig = resolveConfig({ modelChoicePath: join(workspace, 'legacy-model.json') })
  check('档位文件：历史档位名读取时归一', (await readModelChoice(legacyChoiceConfig))?.tier === '5.0-flash')
  await writeModelChoice(legacyChoiceConfig, '5.0')
  check('档位文件：写入历史别名也归一', (await readModelChoice(legacyChoiceConfig))?.tier === '5.0-flash')

  // ================= 可用余额 =================

  // —— 1. 签名：与官方 Python 实现（test/signv4_reference.py）交叉验证过的固定向量 ——
  const signed = signRequest({
    accessKey: 'AKTESTACCESSKEY0001',
    secretKey: 'SKTESTSECRETKEY0001',
    host: 'billing.volcengineapi.com',
    path: '/',
    method: 'POST',
    query: { Action: 'QueryBalanceAcct', Version: '2022-01-01' },
    body: '{}',
    region: 'cn-north-1',
    service: 'billing',
    xDate: '20261010T080000Z',
  })
  const OFFICIAL_SIGNATURE = '7d0a5891cf672ab8283721fbbaa21944a31ce6496e846f9f992e5ca34344715c'
  check('签名：与官方实现一致（固定向量）', signed.Authorization.includes(`Signature=${OFFICIAL_SIGNATURE}`), signed.Authorization)
  check('签名：Credential 作用域正确', signed.Authorization.includes('Credential=AKTESTACCESSKEY0001/20261010/cn-north-1/billing/request'), signed.Authorization)
  check('签名：参与头与官方一致', signed.Authorization.includes('SignedHeaders=content-type;host;x-content-sha256;x-date'), signed.Authorization)
  check('签名：body 哈希正确', signed['X-Content-Sha256'] === '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', signed['X-Content-Sha256'])
  check('签名：X-Date 透传', signed['X-Date'] === '20261010T080000Z', signed['X-Date'])
  check('签名：查询串按 key 排序', canonicalQueryString({ Version: '2022-01-01', Action: 'QueryBalanceAcct' }) === 'Action=QueryBalanceAcct&Version=2022-01-01')
  check('签名：X-Date 格式为 UTC 紧凑写法', formatXDate(new Date('2026-10-10T08:00:00Z')) === '20261010T080000Z', formatXDate(new Date('2026-10-10T08:00:00Z')))

  // —— 2. 响应解析 ——
  const parsedBalance = extractBalance({ Result: { AvailableBalance: '12.34', CashBalance: '10.00', CreditLimit: '0' } })
  check('余额解析：取到字段', parsedBalance.balance.AvailableBalance === '12.34' && parsedBalance.balance.CreditLimit === '0' && parsedBalance.error === undefined, JSON.stringify(parsedBalance))
  const parsedError = extractBalance({ ResponseMetadata: { Error: { Code: 'AccessDenied', Message: 'no permission' } } })
  check('余额解析：识别错误体', parsedError.error?.code === 'AccessDenied', JSON.stringify(parsedError.error))

  // —— 3. 本地预算数学 ——
  const budgetNow = new Date()
  const budgetEntries = [
    { ts: budgetNow.toISOString(), cost: 2, unpriced: 0 },
    { ts: new Date(budgetNow.getTime() - 3 * 86_400_000).toISOString(), cost: 4, unpriced: 1 },
    { ts: new Date(budgetNow.getTime() - 30 * 86_400_000).toISOString(), cost: 10, unpriced: 0 },
  ]
  const budgetCalc = computeBudget({ total: 100, currency: 'CNY', entries: budgetEntries, now: budgetNow })
  check('预算：已花与剩余', budgetCalc.spent === 16 && budgetCalc.remaining === 84, JSON.stringify(budgetCalc))
  check('预算：日均与可用天数', budgetCalc.dailyAverage > 0 && budgetCalc.daysLeft > 0, `${budgetCalc.dailyAverage} / ${budgetCalc.daysLeft}`)
  check('预算：未计价张数累计', budgetCalc.unpricedImages === 1, String(budgetCalc.unpricedImages))
  const budgetSince = computeBudget({
    total: 100,
    currency: 'CNY',
    since: new Date(budgetNow.getTime() - 7 * 86_400_000).toISOString(),
    entries: budgetEntries,
    now: budgetNow,
  })
  check('预算：起始日期过滤掉更早的记录', budgetSince.spent === 6, JSON.stringify(budgetSince))
  const budgetOverspent = computeBudget({ total: 3, currency: 'CNY', entries: budgetEntries, now: budgetNow })
  check('预算：超额时剩余不为负', budgetOverspent.remaining === 0, String(budgetOverspent.remaining))

  // —— 4. AK/SK 金库（需要 pwsh）——
  const billingConfig = resolveConfig({
    ledgerPath: join(workspace, 'ui-usage.jsonl'),
    priceFilePath: join(workspace, 'ui-prices.json'),
    billingVaultPath: join(workspace, 'billing-vault', 'billing.vault.json'),
    budgetFilePath: join(workspace, 'billing-budget.json'),
  })
  try {
    await setBillingCredentials('AKTESTOFFLINE0001', 'SKTESTOFFLINE0001', { config: billingConfig })
    const billingRaw = await readFile(billingVaultPathOf(billingConfig), 'utf8')
    check('费用中心凭据：金库内无 AK/SK 明文', !billingRaw.includes('AKTESTOFFLINE0001') && !billingRaw.includes('SKTESTOFFLINE0001'), billingRaw.slice(0, 60))
    const resolved = await resolveBillingCredentials({ config: billingConfig })
    check('费用中心凭据：可解密还原', resolved?.accessKey === 'AKTESTOFFLINE0001' && resolved?.secretKey === 'SKTESTOFFLINE0001')
    check('费用中心凭据：指纹只露 AK 首尾、SK 仅长度', resolved?.hint.secretKeyLength === 17 && !JSON.stringify(resolved.hint).includes('SKTESTOFFLINE0001'), JSON.stringify(resolved?.hint))
    const billingState = await billingStatus({ config: billingConfig })
    check('费用中心凭据：状态为已配置', billingState.configured === true && billingState.hint !== null)
    await clearBillingCredentials({ config: billingConfig })
    check('费用中心凭据：清除后回到未配置', (await billingStatus({ config: billingConfig })).configured === false)

    // 旧指纹（对整段 JSON 取哈希，显示成 `{"ac…=="}`）会被修正为「AK 掩码 + SK 长度」
    const legacyConfig = resolveConfig({ billingVaultPath: join(workspace, 'legacy-vault', 'billing.vault.json') })
    await setSecretForHintTest(JSON.stringify({ accessKey: 'AKLEGACY0001', secretKey: 'SKLEGACY0001' }), { path: billingVaultPathOf(legacyConfig) })
    const legacyHint = (await billingStatus({ config: legacyConfig })).hint
    check('费用中心凭据：旧指纹被修正为 AK 掩码', legacyHint?.kind === 'billing-ak-sk' && legacyHint.accessKey === 'AKLE…0001', JSON.stringify(legacyHint))
    check('费用中心凭据：修正指纹后仍可解密', (await resolveBillingCredentials({ config: legacyConfig }))?.accessKey === 'AKLEGACY0001')

    // setSecret 支持自定义指纹（避免把 JSON 结构写进指纹）
    const customVault = join(workspace, 'custom-vault', 'v.json')
    await setSecretForHintTest('{"a":1}', { path: customVault, hint: { kind: 'custom', label: 'x' } })
    check('金库：支持自定义指纹', JSON.parse(await readFile(customVault, 'utf8')).hint.kind === 'custom')
  } catch (error) {
    if (error instanceof SeedreamError && error.code === 'POWERSHELL_MISSING') {
      console.log('跳过费用中心凭据测试：本机没有可用的 PowerShell（见 lib/vault.js）')
    } else {
      check('费用中心凭据：往返', false, error instanceof Error ? error.message : String(error))
    }
  }

  // —— 5. 界面路由：用 stub fetch 离线验证「保存 AK/SK → 验证 → 官方余额进状态」 ——
  const realFetch = globalThis.fetch
  const capturedRequests = []
  try {
    globalThis.fetch = async (url, init) => {
      capturedRequests.push({ url: String(url), init })
      return new Response(JSON.stringify({ ResponseMetadata: {}, Result: { AvailableBalance: '77.77', CashBalance: '70.00' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    resetBalanceCache()
    const billingSave = await call(`${ROUTE_PREFIX}/billing`, {
      method: 'POST',
      body: JSON.stringify({ accessKey: 'AKTESTOFFLINE0001', secretKey: 'SKTESTOFFLINE0001' }),
    })
    const billingSavePayload = JSON.parse(billingSave.body)
    check('余额路由：保存 AK/SK 并验证通过', billingSave.statusCode === 200 && billingSavePayload.verified === true, billingSave.body.slice(0, 160))
    check('余额路由：打到费用中心正确端点', capturedRequests[0]?.url === 'https://billing.volcengineapi.com/?Action=QueryBalanceAcct&Version=2022-01-01', capturedRequests[0]?.url)
    check('余额路由：请求方法与签名头正确', capturedRequests[0]?.init.method === 'POST' && String(capturedRequests[0]?.init.headers.Authorization).startsWith('HMAC-SHA256 Credential=AKTESTOFFLINE0001/'), JSON.stringify(Object.keys(capturedRequests[0]?.init.headers ?? {})))
    const stateWithBalance = JSON.parse((await call(`${ROUTE_PREFIX}/state`)).body)
    check('余额路由：官方余额进入状态', stateWithBalance.balance.mode === 'official' && stateWithBalance.balance.official.available === '77.77', JSON.stringify(stateWithBalance.balance.mode))
    check('余额路由：本地预算同时可用', stateWithBalance.balance.budget !== null, JSON.stringify(stateWithBalance.balance.budget?.remaining))

    // 失败路径：403 → 不应把失败当成 0，而是保留错误信息
    globalThis.fetch = async () => new Response(JSON.stringify({ ResponseMetadata: { Error: { Code: 'AccessDenied', Message: 'no permission' } } }), { status: 403 })
    resetBalanceCache()
    const failedView = JSON.parse((await call(`${ROUTE_PREFIX}/balance`, { method: 'POST', body: JSON.stringify({ refresh: true }) })).body)
    check('余额路由：403 归类为鉴权失败', failedView.mode === 'official-error' && String(failedView.official.error).includes('AUTH_FAILED'), JSON.stringify(failedView.official.error))
    check('余额路由：失败时不返回假的 0 余额', failedView.official.available === null, String(failedView.official.available))

    const billingClear = await call(`${ROUTE_PREFIX}/billing`, { method: 'POST', body: JSON.stringify({ clear: true }) })
    check('余额路由：可删除 AK/SK', billingClear.statusCode === 200 && JSON.parse(billingClear.body).cleared === true)

    // 精确擦除：上游异常若夹带 AK/SK，错误消息里也不能出现它们
    const akFixture = 'AKTESTOFFLINE0001'
    const skFixture = 'SKTESTOFFLINE0001'
    globalThis.fetch = async () => { throw new TypeError(`connection failed while sending ${akFixture} / ${skFixture}`) }
    try {
      await queryBalance({ accessKey: akFixture, secretKey: skFixture, timeoutMs: 5_000 })
      check('费用中心：异常擦除', false, '本应抛出异常')
    } catch (error) {
      check('费用中心：异常里的 AK/SK 被抹掉', !String(error.message).includes(akFixture) && !String(error.message).includes(skFixture), error.message)
    }
  } catch (error) {
    if (error instanceof SeedreamError && error.code === 'POWERSHELL_MISSING') {
      console.log('跳过余额路由测试：本机没有可用的 PowerShell（见 lib/vault.js）')
    } else {
      check('余额路由：端到端', false, error instanceof Error ? error.message : String(error))
    }
  } finally {
    globalThis.fetch = realFetch
    resetBalanceCache()
  }

  // 按来源删除：凭据服务里的 Key（明文来源）也能一键删掉
  const credsDelete = await call(`${ROUTE_PREFIX}/key`, { method: 'POST', body: JSON.stringify({ clear: true, source: 'credentials' }) })
  check('界面：可删除凭据服务里的 Key', credsDelete.statusCode === 200 && unsetCalls[0] === uiConfig.apiKeyEnv, `${credsDelete.statusCode} ${JSON.stringify(unsetCalls)}`)

  // —— DPAPI 金库往返（无 pwsh 时跳过）——
  const vaultPath = join(workspace, 'vault', 'ark-key.vault.json')
  const secret = `ark-offline-test-${Date.now()}-Ø中文`
  try {
    await setSecret(secret, { path: vaultPath })
    const status = await vaultStatus(vaultPath)
    const restored = await getSecret({ path: vaultPath })
    const raw = await readFile(vaultPath, 'utf8')
    check('金库：状态为已配置', status.configured === true)
    check('金库：解密还原原文', restored === secret, `got=${String(restored).slice(0, 12)}…`)
    check('金库：文件内无明文', !raw.includes(secret) && !raw.includes('ark-offline-test'), raw.slice(0, 60))
    check('金库：声明 DPAPI 后端', JSON.parse(raw).backend === 'dpapi-user')
    await clearVault(vaultPath)
    check('金库：清除后未配置', (await vaultStatus(vaultPath)).configured === false)
  } catch (error) {
    if (error instanceof SeedreamError && error.code === 'POWERSHELL_MISSING') {
      console.log('跳过 DPAPI 金库往返：本机没有可用的 PowerShell（见 lib/vault.js）')
    } else {
      check('金库：往返', false, error instanceof Error ? error.message : String(error))
    }
  }

  await rm(workspace, { recursive: true, force: true })

  console.log(`\n通过 ${passed}，失败 ${failed}`)
  if (failed > 0) {
    for (const failure of failures) console.log(`  ✗ ${failure}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
