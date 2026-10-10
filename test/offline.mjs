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
import { TIER_KEYS, normalizeSize, resolveTier } from '../lib/models.js'
import { readDimensions, planOutputPaths, resolveReference, slugify, sniffMediaType, toDataUrl } from '../lib/assets.js'
import { clearVault, ensureKeyHint, getSecret, keyHint, setSecret, vaultStatus } from '../lib/vault.js'
import { registerTools } from '../lib/tools.js'
import { SeedreamError, redactSecrets } from '../lib/errors.js'
import { estimateCost, loadPrices, priceForImage } from '../lib/pricing.js'
import { appendUsage, ledgerPathOf, readUsage, summarizeUsage } from '../lib/ledger.js'
import { buildUsageView, recostLedger, renderUsage } from '../lib/usage.js'
import { buildUiState, registerClientUi, registerIndexInjection, ROUTE_PREFIX } from '../lib/ui.js'

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
  const lite = resolveTier('5.0', config.models, '5.0-pro')
  check('档位解析：默认 ID', pro.modelId === 'doubao-seedream-5-0-pro-260628', pro.modelId)
  check('档位解析：覆盖 ID', resolveTier('5.0', { '5.0': 'ep-abc' }, '5.0-pro').modelId === 'ep-abc')
  checkThrows('档位解析：未知档位', () => resolveTier('4.5', config.models, '5.0-pro'), 'INVALID_ARGUMENT')
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
  check('工具：注册四个', definitions.length === 4, definitions.map((d) => d.name).join(','))
  const byName = Object.fromEntries(definitions.map((definition) => [definition.name, definition]))
  check('工具：generate 存在', byName.seedream_generate !== undefined)
  check('工具：edit 存在', byName.seedream_edit !== undefined)
  check('工具：status 存在', byName.seedream_status !== undefined)
  check('工具：usage 存在', byName.seedream_usage !== undefined)
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
    priceTable: ['5.0-pro: ¥0.32/张，超过 2610000 像素 ¥0.95/张'],
    tiers: [
      {
        tier: '5.0',
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
  const flashModelId = pricedConfig.models['5.0']
  await appendUsage({ ts: new Date().toISOString(), mode: 'generate', tier: '5.0-pro', model: proModelId, size: '1024x1024', images: [{ width: 1024, height: 1024, bytes: 1 }], billed: 1, outputTokens: 4096, currency: 'CNY', cost: null, unitPrices: [null], priced: 0, unpriced: 1 }, ledgerPath)
  await appendUsage({ ts: new Date(Date.now() - 8 * 86_400_000).toISOString(), mode: 'generate', tier: '5.0', model: flashModelId, size: '2048x2048', images: [{ width: 2048, height: 2048, bytes: 1 }], billed: 1, outputTokens: 4096, currency: 'CNY', cost: null, unitPrices: [null], priced: 0, unpriced: 1 }, ledgerPath)
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
  check('界面：注册 5 条路由', registered.length === 5, registered.map((definition) => definition.path).join(','))
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

  const priceWrite = await call(`${ROUTE_PREFIX}/price`, { method: 'POST', body: JSON.stringify({ tier: '5.0', price: 0.18, note: '界面写入测试' }) })
  check('界面：写入单价', priceWrite.statusCode === 200 && JSON.parse(priceWrite.body).ok === true, priceWrite.body.slice(0, 120))
  const pricedState = JSON.parse((await call(`${ROUTE_PREFIX}/state`)).body)
  const flashEntry = pricedState.prices.entries.find((entry) => entry.tier === '5.0')
  check('界面：单价写入后状态同步', flashEntry.price === 0.18 && pricedState.prices.note === '界面写入测试', JSON.stringify(flashEntry))
  const badPrice = await call(`${ROUTE_PREFIX}/price`, { method: 'POST', body: JSON.stringify({ tier: '5.0', price: -1 }) })
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
