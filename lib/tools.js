/**
 * 面向模型的三个工具：seedream_generate / seedream_edit / seedream_status。
 *
 * 工具定义直接交给 `ctx.tools.register()`：DSH 的注册表要求 `parameters` 已是
 * 原始 JSON Schema 子集（type/properties/required/additionalProperties/items/enum/const
 * + description 注解），`output` 必须是 `{ schema, render }`，其中 render 是同步函数，
 * 把返回值投影成模型可见的内容块（这里就是文本信封 + 真图）。
 */

import { basename } from 'node:path'
import { SeedreamError, describeError } from './errors.js'
import { TIERS, TIER_KEYS, resolveTier, normalizeSize, describeTiers } from './models.js'
import { ArkClient } from './ark.js'
import { resolveApiKey, describeApiKey } from './credentials.js'
import { vaultPathOf } from './config.js'
import {
  displayPath,
  extensionOf,
  formatBytes,
  planOutputPaths,
  readDimensions,
  resolveReference,
  sessionCwd,
  slugify,
  sniffMediaType,
  writeFileEnsured,
} from './assets.js'
import { describePriceTable, estimateCost, formatMoney, loadPrices } from './pricing.js'
import { appendUsage, ledgerPathOf } from './ledger.js'
import { USAGE_PERIODS, buildUsageLine, buildUsageView, renderUsage } from './usage.js'

/** 单次调用最长生成时间（方舟是同步接口，4K 组图可能很久）。 */
const TOOL_TIMEOUT_MS = 900_000

/** 参数 schema：输出目录与文件名。 */
const OUTPUT_PARAMETERS = {
  output_dir: {
    type: 'string',
    description: '生成物落盘目录（相对会话工作目录；默认取插件配置 images/seedream）。',
  },
  name: {
    type: 'string',
    description: '文件名提示词，建议用简短英文/数字，例如 hero-banner。省略时取 prompt 的可读片段。',
  },
}

/** 参数 schema：画幅与通用开关。 */
const COMMON_PARAMETERS = {
  size: {
    type: 'string',
    description:
      '画幅：档位或显式「宽x高」。5.0 支持 2K/3K/4K，显式像素 2560x1440–4096x4096；5.0-pro 支持 1K/2K，显式像素 1280x720–2048x2048 且边长为 16 的倍数。省略时用 2K。',
  },
  count: {
    type: 'integer',
    description: '产出张数 1–4。当前两个档位都不支持一次请求出多张，count>1 会串行多次调用（分别计费）。',
  },
  output_format: {
    type: 'string',
    enum: ['png', 'jpeg'],
    description: '输出格式，默认 png。',
  },
  watermark: {
    type: 'boolean',
    description: '是否加方舟「AI 生成」水印，默认 false（素材保持干净）。',
  },
}

/** 生成结果 value 的 JSON Schema（与 buildValue 严格对应）。 */
const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'mediaType', 'bytes'],
  properties: {
    path: { type: 'string' },
    display: { type: 'string' },
    mediaType: { type: 'string' },
    bytes: { type: 'number' },
    width: { type: 'number' },
    height: { type: 'number' },
    attachmentId: { type: 'string' },
    attachmentName: { type: 'string' },
    sourceUrl: { type: 'string' },
  },
}

const RESULT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tier', 'model', 'size', 'saved', 'billedImages', 'costText', 'credentialSource', 'images', 'failures', 'notes'],
  properties: {
    tier: { type: 'string' },
    model: { type: 'string' },
    size: { type: 'string' },
    prompt: { type: 'string' },
    saved: { type: 'number' },
    billedImages: { type: 'number' },
    costText: { type: 'string' },
    currency: { type: 'string' },
    todayCostText: { type: 'string' },
    estimated: { type: 'boolean' },
    credentialSource: { type: 'string' },
    usageText: { type: 'string' },
    directory: { type: 'string' },
    images: { type: 'array', items: IMAGE_VALUE_SCHEMA },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'message'],
        properties: { code: { type: 'string' }, message: { type: 'string' } },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

function clampCount(requested, max) {
  if (requested === undefined || requested === null) return 1
  const value = Math.trunc(Number(requested))
  if (!Number.isFinite(value) || value < 1) {
    throw new SeedreamError('INVALID_ARGUMENT', `count 必须是 1–${max} 的整数，收到 ${JSON.stringify(requested)}`)
  }
  return Math.min(max, value)
}

function normalizeOutputFormat(requested, tier) {
  const value = (requested ?? 'png').trim().toLowerCase()
  if (value !== 'png' && value !== 'jpeg') {
    throw new SeedreamError('INVALID_ARGUMENT', `output_format 只支持 png 或 jpeg，收到 ${JSON.stringify(requested)}`)
  }
  return tier.outputFormat ? value : 'png'
}

/** 把生成结果写成模型可见的文本信封 + 真图内容块。 */
function resultContent(value) {
  const notes = Array.isArray(value?.notes) ? value.notes : []
  const failures = Array.isArray(value?.failures) ? value.failures : []
  const images = Array.isArray(value?.images) ? value.images : []
  const lines = [
    '<seedream>',
    `<tier>${value.tier}</tier>`,
    `<model>${value.model}</model>`,
    `<size>${value.size}</size>`,
    `<saved>${value.saved}</saved>`,
    `<billed-images>${value.billedImages ?? value.saved}</billed-images>`,
    `<cost>${value.costText ?? '未知'}${value.estimated === true ? '（含未计价部分）' : ''}</cost>`,
  ]
  if (value.directory !== undefined) lines.push(`<directory>${value.directory}</directory>`)
  if (value.todayCostText !== undefined) lines.push(`<today-total>${value.todayCostText}</today-total>`)
  for (const note of notes) lines.push(`<note>${note}</note>`)
  for (const failure of failures) lines.push(`<partial-failure code="${failure.code}">${failure.message}</partial-failure>`)
  if (value.usageText !== undefined) lines.push(`<usage>${value.usageText}</usage>`)
  if (images.length > 0) {
    lines.push('<images>')
    for (const image of images) {
      const dimension = image.width === undefined || image.height === undefined ? '' : `, ${image.width}x${image.height}px`
      lines.push(`- ${image.path} (${image.mediaType}${dimension}, ${formatBytes(image.bytes)})`)
    }
    lines.push('</images>')
  }
  lines.push('</seedream>')
  const blocks = [{ type: 'text', text: lines.join('\n') }]
  for (const image of images) {
    if (image.attachmentId === undefined) continue
    blocks.push({
      type: 'image',
      attachment: {
        attachmentId: image.attachmentId,
        mediaType: image.mediaType,
        bytes: image.bytes,
        width: image.width ?? 0,
        height: image.height ?? 0,
        ...(image.attachmentName === undefined ? {} : { name: image.attachmentName }),
      },
    })
  }
  return blocks
}

/** 尽力把图片写进附件库，让 GUI 与后续对话都能直接看到它。 */
async function saveAttachment(ctx, bytes, mediaType, name, log) {
  const attachments = ctx.get?.('attachments')
  if (attachments === undefined || typeof attachments.saveImage !== 'function') return undefined
  try {
    return await attachments.saveImage({ data: bytes, mediaType, name })
  } catch (error) {
    log('warn', `dsh-seedream: 图片已落盘，但写入附件库失败（不影响文件）：${describeError(error)}`)
    return undefined
  }
}

function usageTextOf(usages) {
  let images = 0
  let tokens = 0
  let seen = false
  for (const usage of usages) {
    if (usage === null || typeof usage !== 'object') continue
    seen = true
    if (typeof usage.generated_images === 'number') images += usage.generated_images
    if (typeof usage.output_tokens === 'number') tokens += usage.output_tokens
  }
  if (!seen) return undefined
  return `${images} 张已计费图片${tokens > 0 ? `, ${tokens} output tokens` : ''}`
}

/**
 * 生成/编辑共用的执行管线。
 * @param {object} options
 * @param {any} options.ctx 注册作用域（含 tools/attachments 等 seam）。
 * @param {ReturnType<import('./config.js').resolveConfig>} options.config
 * @param {(level: string, message: string) => void} options.log
 * @param {any} options.exec 工具执行上下文。
 * @param {Record<string, any>} options.args 工具参数。
 * @param {'generate'|'edit'} options.mode
 */
export async function runSeedream(options) {
  const { ctx, config, log, exec, args, mode } = options
  const cwd = sessionCwd(exec)
  const requestedModel = args.model ?? (mode === 'edit' ? config.editModel : config.defaultModel)
  const { tier, modelId } = resolveTier(requestedModel, config.models, mode === 'edit' ? config.editModel : config.defaultModel)
  const size = normalizeSize(args.size, tier)
  const count = clampCount(args.count, config.maxImagesPerCall)
  const outputFormat = normalizeOutputFormat(args.output_format, tier)
  const watermark = typeof args.watermark === 'boolean' ? args.watermark : config.watermark

  const notes = []
  const referenceInputs = mode === 'edit' ? (Array.isArray(args.images) ? args.images : []) : (Array.isArray(args.references) ? args.references : [])
  if (mode === 'edit' && referenceInputs.length === 0) {
    throw new SeedreamError('INVALID_ARGUMENT', 'seedream_edit 需要至少一张基准图（images）')
  }
  if (referenceInputs.length > tier.maxReferences) {
    throw new SeedreamError(
      'INVALID_ARGUMENT',
      `${tier.alias} 最多接受 ${tier.maxReferences} 张参考图，收到 ${referenceInputs.length} 张`,
    )
  }
  const references = []
  for (const reference of referenceInputs) {
    references.push(await resolveReference(String(reference), { cwd, allowOutsideCwd: config.allowOutsideCwd, signal: exec.signal }))
  }
  if (references.length + count > 15) {
    notes.push(`参考图 ${references.length} 张 + 产出 ${count} 张超过方舟「参考图 + 生成图 ≤ 15」的限制，可能被网关拒绝`)
  }

  const credential = await resolveApiKey({ config, ctx })
  const client = new ArkClient({
    baseUrl: config.baseUrl,
    timeoutMs: config.requestTimeoutMs,
    rateLimitRetries: config.rateLimitRetries,
    rateLimitBackoffMs: config.rateLimitBackoffMs,
    log,
  })

  const body = {
    model: modelId,
    prompt: String(args.prompt),
    response_format: 'url',
    size: size.value,
    watermark,
  }
  if (tier.outputFormat) body.output_format = outputFormat
  if (references.length > 0) body.image = references.map((reference) => reference.value)

  const produced = []
  const failures = []
  const usages = []
  let usedModel = modelId
  if (tier.sequential && count > 1) {
    const result = await client.request(
      { ...body, sequential_image_generation: 'auto', sequential_image_generation_options: { max_images: count } },
      credential.value,
      exec.signal,
    )
    produced.push(...result.images)
    failures.push(...result.failures)
    if (result.usage !== undefined) usages.push(result.usage)
    usedModel = result.model
  } else {
    if (count > 1 && !tier.sequential) {
      notes.push(`${tier.alias} 不支持一次请求出多张，已串行调用 ${count} 次（分别计费）`)
    }
    for (let index = 0; index < count; index += 1) {
      const result = await client.request(body, credential.value, exec.signal)
      produced.push(...result.images)
      failures.push(...result.failures)
      if (result.usage !== undefined) usages.push(result.usage)
      usedModel = result.model
    }
  }
  if (produced.length === 0) {
    throw new SeedreamError('BAD_RESPONSE', '方舟没有返回任何图片，且未给出可判定的错误')
  }

  // 先取回字节再定文件名：实际编码格式决定扩展名，不盲信请求参数。
  const fetched = []
  for (const image of produced) {
    if (typeof image.base64 === 'string') {
      const bytes = Buffer.from(image.base64, 'base64')
      fetched.push({ bytes, sourceUrl: undefined })
      continue
    }
    const download = await client.download(image.url, exec.signal)
    fetched.push({ bytes: download.bytes, sourceUrl: image.url })
  }
  const mediaTypes = fetched.map((entry) => sniffMediaType(entry.bytes) ?? (outputFormat === 'jpeg' ? 'image/jpeg' : 'image/png'))
  const { directory, paths } = planOutputPaths({
    cwd,
    outputDir: typeof args.output_dir === 'string' && args.output_dir.trim() !== '' ? args.output_dir.trim() : config.outputDir,
    allowOutsideCwd: config.allowOutsideCwd,
    slug: slugify(typeof args.name === 'string' && args.name.trim() !== '' ? args.name : String(args.prompt)),
    extensions: mediaTypes.map((mediaType) => extensionOf(mediaType)),
  })

  const images = []
  for (let index = 0; index < fetched.length; index += 1) {
    const bytes = fetched[index].bytes
    const mediaType = mediaTypes[index]
    const path = paths[index]
    await writeFileEnsured(path, bytes)
    const attachment = await saveAttachment(ctx, bytes, mediaType, basename(path), log)
    const dimensions = readDimensions(bytes, mediaType)
    images.push({
      path,
      display: displayPath(cwd, path),
      mediaType,
      bytes: bytes.byteLength,
      ...(attachment === undefined
        ? (dimensions === undefined ? {} : { width: dimensions.width, height: dimensions.height })
        : {
            width: attachment.width,
            height: attachment.height,
            attachmentId: attachment.attachmentId,
            attachmentName: attachment.name ?? basename(path),
          }),
      ...(fetched[index].sourceUrl === undefined ? {} : { sourceUrl: fetched[index].sourceUrl }),
    })
  }

  if (size.adjusted) notes.push(`请求画幅被归一为 ${size.value}（该档位的合法域约束）`)
  if (mode === 'edit') notes.push('方舟没有 mask 局部重绘：编辑是整图按指令重绘，请在 prompt 里说明要保留的部分')

  // —— 计费与台账 ——
  // 张数取方舟回报的 usage.generated_images（权威计费口径），缺失时退回实际落盘张数。
  const billedImages = usages.reduce(
    (total, usage) => total + (usage !== null && typeof usage === 'object' && typeof usage.generated_images === 'number' ? usage.generated_images : 0),
    0,
  ) || produced.length
  const totalOutputTokens = usages.reduce(
    (total, usage) => total + (usage !== null && typeof usage === 'object' && typeof usage.output_tokens === 'number' ? usage.output_tokens : 0),
    0,
  )
  const prices = await loadPrices({ config, modelIds: config.models })
  const cost = estimateCost(prices, usedModel, images, billedImages)
  const costText = cost.cost === null ? '单价未配置' : formatMoney(cost.cost, cost.currency)
  let todayCostText
  try {
    await appendUsage(
      {
        ts: new Date().toISOString(),
        mode,
        tier: tier.key,
        model: usedModel,
        size: size.value,
        images: images.map((image) => ({ width: image.width, height: image.height, bytes: image.bytes })),
        billed: billedImages,
        outputTokens: totalOutputTokens,
        currency: cost.currency,
        cost: cost.cost,
        unitPrices: cost.unitPrices,
        priced: cost.priced,
        unpriced: cost.unpriced,
      },
      ledgerPathOf(config),
    )
    const today = await buildUsageView({ config, period: 'today' })
    todayCostText = `今天 ${today.images} 张 / ${today.costText}`
  } catch (error) {
    log('warn', `dsh-seedream: 写入用量台账失败（不影响本次出图）：${describeError(error)}`)
  }

  const usageText = usageTextOf(usages)
  return {
    tier: tier.key,
    model: usedModel,
    size: size.value,
    prompt: String(args.prompt),
    saved: images.length,
    billedImages,
    costText,
    currency: cost.currency,
    ...(todayCostText === undefined ? {} : { todayCostText }),
    ...(cost.unpriced > 0 ? { estimated: true } : {}),
    credentialSource: credential.source,
    ...(usageText === undefined ? {} : { usageText }),
    directory,
    images,
    failures,
    notes,
  }
}

/** 注册全部工具，返回 disposer 列表。 */
export function registerTools(ctx, config, log) {
  const disposers = []

  const generateDescription = [
    '用 Seedream（火山方舟）按文本生成图片素材，落盘到会话工作目录并直接回显图片。',
    `可用档位：${TIER_KEYS.join(' / ')}（默认 ${config.defaultModel}）。`,
    '适合：插画、海报、产品图、UI 草图、图标与成套素材。需要「按参考图/基准图改造」时改用 seedream_edit。',
  ].join(' ')

  disposers.push(
    ctx.tools.register({
      name: 'seedream_generate',
      description: generateDescription,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['prompt'],
        properties: {
          prompt: {
            type: 'string',
            description: '画面描述。建议中文 ≤300 字或英文 ≤600 词；写清主体、动作、环境、风格、光线、构图与用途。',
          },
          model: { type: 'string', enum: [...TIER_KEYS], description: `模型档位，默认 ${config.defaultModel}。` },
          references: {
            type: 'array',
            items: { type: 'string' },
            description: '参考图：工作目录内的文件路径，或公网 URL。5.0 最多 14 张，5.0-pro 最多 10 张。',
          },
          ...COMMON_PARAMETERS,
          ...OUTPUT_PARAMETERS,
        },
      },
      output: { schema: RESULT_VALUE_SCHEMA, render: (_args, value) => resultContent(value) },
      timeoutMs: TOOL_TIMEOUT_MS,
      async execute(args, exec) {
        return runSeedream({ ctx, config, log, exec, args, mode: 'generate' })
      },
      presentCall(args) {
        return { card: 'generic', title: `Seedream 生成：${String(args.prompt).slice(0, 60)}`, kind: 'other' }
      },
      presentResult(_args, result) {
        return { card: 'generic', title: 'Seedream 生成结果', content: result.content }
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'seedream_edit',
      description: [
        '用 Seedream（火山方舟）按指令改造已有图片：基准图 + 编辑指令 → 新图，落盘并回显。',
        '方舟没有掩码局部重绘，编辑是整图重绘，请在 prompt 里写明「要改什么」和「必须保留什么」，多张基准图用「图一/图二」指代。',
        `默认档位 ${config.editModel}。`,
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['prompt', 'images'],
        properties: {
          prompt: { type: 'string', description: '编辑指令：目标对象、要做的改动、必须保持不变的部分。' },
          images: {
            type: 'array',
            items: { type: 'string' },
            description: '基准图（1 张起，按顺序即「图一/图二」）：工作目录内路径或公网 URL。',
          },
          model: { type: 'string', enum: [...TIER_KEYS], description: `模型档位，默认 ${config.editModel}。` },
          ...COMMON_PARAMETERS,
          ...OUTPUT_PARAMETERS,
        },
      },
      output: { schema: RESULT_VALUE_SCHEMA, render: (_args, value) => resultContent(value) },
      timeoutMs: TOOL_TIMEOUT_MS,
      async execute(args, exec) {
        return runSeedream({ ctx, config, log, exec, args, mode: 'edit' })
      },
      presentCall(args) {
        return { card: 'generic', title: `Seedream 编辑：${String(args.prompt).slice(0, 60)}`, kind: 'edit' }
      },
      presentResult(_args, result) {
        return { card: 'generic', title: 'Seedream 编辑结果', content: result.content }
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'seedream_status',
      description:
        '查看 Seedream（火山方舟）接入状态：API Key 是否已配置（不显示 Key 本身）、生效来源、金库路径、可用档位与各档位的画幅/参考图上限、产出目录，以及用量与费用摘要。生成失败、想确认配置或想看花了多少钱时先调用它；只要明细就调用 seedream_usage。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['configured', 'reference', 'tiers', 'baseUrl', 'defaultModel', 'outputDir', 'vaultPath', 'usage'],
          properties: {
            configured: { type: 'boolean' },
            effectiveSource: { type: 'string' },
            reference: { type: 'string' },
            vaultPath: { type: 'string' },
            baseUrl: { type: 'string' },
            defaultModel: { type: 'string' },
            editModel: { type: 'string' },
            outputDir: { type: 'string' },
            allowOutsideCwd: { type: 'boolean' },
            usage: { type: 'string' },
            priceTable: { type: 'array', items: { type: 'string' } },
            tiers: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['tier', 'alias', 'modelId'],
                properties: {
                  tier: { type: 'string' },
                  alias: { type: 'string' },
                  modelId: { type: 'string' },
                  presets: { type: 'array', items: { type: 'string' } },
                  pixelRange: { type: 'array', items: { type: 'number' } },
                  multipleOf: { type: 'number' },
                  maxReferences: { type: 'number' },
                  sequential: { type: 'boolean' },
                  outputFormat: { type: 'boolean' },
                  webSearch: { type: 'boolean' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const tiers = Array.isArray(value?.tiers) ? value.tiers : []
          const lines = [
            '<seedream-status>',
            `<configured>${value.configured}</configured>`,
            ...(value.effectiveSource === undefined ? {} : [`<effective-source>${value.effectiveSource}</effective-source>`]),
            `<credential-ref>${value.reference}</credential-ref>`,
            `<vault>${value.vaultPath}</vault>`,
            `<base-url>${value.baseUrl}</base-url>`,
            `<default-model>${value.defaultModel}</default-model>`,
            `<edit-model>${value.editModel}</edit-model>`,
            `<output-dir>${value.outputDir}</output-dir>`,
            '<tiers>',
            ...tiers.map(
              (tier) =>
                `- ${tier.tier} (${tier.alias}) → ${tier.modelId}；档位 ${tier.presets.join('/')}；显式像素 ${tier.pixelRange[0]}–${tier.pixelRange[1]}；参考图 ≤${tier.maxReferences}；组图 ${tier.sequential ? '支持' : '不支持'}`,
            ),
            '</tiers>',
            `<usage>${value.usage}</usage>`,
            ...(Array.isArray(value.priceTable) && value.priceTable.length > 0
              ? ['<price-table>', ...value.priceTable.map((line) => `- ${line}`), '</price-table>']
              : []),
            value.configured
              ? '<hint>生成前无需再确认 Key；直接调用 seedream_generate / seedream_edit。要看费用明细用 seedream_usage。</hint>'
              : '<hint>尚未配置 API Key：请在插件目录运行 seedream CLI 的 key set，或用 DSH 凭据库写入该引用。</hint>',
            '</seedream-status>',
          ]
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute() {
        const status = await describeApiKey({ config, ctx })
        const usage = await buildUsageLine(config)
        const prices = await loadPrices({ config, modelIds: config.models })
        const priceTable = describePriceTable(prices, config.models)
        return {
          configured: status.configured,
          ...(status.effectiveSource === undefined ? {} : { effectiveSource: status.effectiveSource }),
          reference: status.reference,
          vaultPath: vaultPathOf(config),
          baseUrl: config.baseUrl,
          defaultModel: config.defaultModel,
          editModel: config.editModel,
          outputDir: config.outputDir,
          allowOutsideCwd: config.allowOutsideCwd,
          tiers: describeTiers(config.models),
          usage: usage.text,
          priceTable,
        }
      },
      presentCall() {
        return { card: 'generic', title: 'Seedream 接入状态', kind: 'read' }
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'seedream_usage',
      description: [
        '查看 Seedream（火山方舟）的用量与费用：按周期统计调用次数、计费张数、output tokens 与估算金额（元），并可按档位分解。',
        '金额是按本地价表的估算：方舟按「返回张数」计费，单价只在控制台可见、API 不返回；未配置单价的张数会单独标注。',
        `周期可选 ${USAGE_PERIODS.join(' / ')}（默认 today）。`,
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          period: { type: 'string', enum: [...USAGE_PERIODS], description: '统计周期：today（今天）/ week（近 7 天）/ month（本月）/ all（全部），默认 today。' },
          detail: { type: 'boolean', description: '是否附上最近若干次生成明细，默认 false。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['period', 'calls', 'images', 'outputTokens', 'costText', 'currency', 'ledger', 'byTier', 'priceTable', 'recent'],
          properties: {
            period: { type: 'string' },
            calls: { type: 'number' },
            images: { type: 'number' },
            outputTokens: { type: 'number' },
            costText: { type: 'string' },
            unpricedImages: { type: 'number' },
            currency: { type: 'string' },
            ledger: { type: 'string' },
            hint: { type: 'string' },
            priceNote: { type: 'string' },
            since: { type: 'string' },
            lastTs: { type: 'string' },
            skipped: { type: 'number' },
            byTier: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['tier', 'images', 'calls', 'costText'],
                properties: {
                  tier: { type: 'string' },
                  model: { type: 'string' },
                  images: { type: 'number' },
                  calls: { type: 'number' },
                  costText: { type: 'string' },
                },
              },
            },
            priceTable: { type: 'array', items: { type: 'string' } },
            recent: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['ts', 'summary'],
                properties: { ts: { type: 'string' }, summary: { type: 'string' } },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderUsage(value) }],
      },
      async execute(args) {
        return buildUsageView({
          config,
          period: typeof args.period === 'string' ? args.period : 'today',
          detail: args.detail === true,
        })
      },
      presentCall(args) {
        return { card: 'generic', title: `Seedream 用量（${typeof args.period === 'string' ? args.period : 'today'}）`, kind: 'read' }
      },
    }),
  )

  return disposers
}

export { TOOL_TIMEOUT_MS, TIERS }
