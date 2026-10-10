/**
 * 界面档位选择（对话窗口里的「模型选项」）。
 *
 * 存成一个独立小文件，而不是写 profile 配置：这样改档位**不需要重启 DSH**，
 * 与 prices.json / budget.json 是同一套思路。
 *
 * 生效优先级（`resolveEffectiveTier`）：
 *   工具调用显式传入的 model  >  界面选择  >  插件配置 defaultModel/editModel
 * —— 显式传参最高，保证「用户/模型在对话里明确要求某个档位」时不会被界面选择悄悄改掉；
 * 界面选择次之，保证用户点选的档位是**默认**行为。
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { SeedreamError, describeError } from './errors.js'
import { dshHome } from './config.js'
import { TIER_KEYS, normalizeTierName } from './models.js'

/** 档位选择文件路径。 */
export function modelChoicePathOf(config) {
  return config.modelChoicePath !== '' ? config.modelChoicePath : join(dshHome(), 'seedream', 'model.json')
}

/** 读取界面档位选择；未选择或文件损坏时返回 undefined。 */
export async function readModelChoice(config) {
  try {
    const parsed = JSON.parse(await readFile(modelChoicePathOf(config), 'utf8'))
    const tier = normalizeTierName(typeof parsed?.tier === 'string' ? parsed.tier : '')
    if (!TIER_KEYS.includes(tier)) return undefined
    return { tier, updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : undefined }
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined
    // 文件坏了不该阻断生成：当作「未选择」，但要能在日志里看到原因
    throw new SeedreamError('MODEL_CHOICE_ERROR', `读取档位选择失败：${describeError(error)}`, { cause: error })
  }
}

/** 写入界面档位选择。 */
export async function writeModelChoice(config, tier) {
  const value = normalizeTierName(tier)
  if (!TIER_KEYS.includes(value)) {
    throw new SeedreamError('INVALID_ARGUMENT', `未知档位 ${JSON.stringify(tier)}；可用：${TIER_KEYS.join('、')}`)
  }
  const path = modelChoicePathOf(config)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify({ tier: value, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
  return { path, tier: value }
}

/** 清除界面档位选择（回到配置默认）。 */
export async function clearModelChoice(config) {
  await rm(modelChoicePathOf(config), { force: true })
  return { cleared: true }
}

/**
 * 解析最终生效档位。
 * @param {{ config: Record<string, any>, requested?: string, fallback?: string, choice?: { tier: string }|undefined }} options
 * @returns {{ tier: string, source: 'request'|'ui'|'config' }}
 */
export function resolveEffectiveTier(options) {
  const requested = typeof options.requested === 'string' ? options.requested.trim() : ''
  if (requested !== '') return { tier: requested, source: 'request' }
  if (options.choice !== undefined && TIER_KEYS.includes(options.choice.tier)) return { tier: options.choice.tier, source: 'ui' }
  const fallback = typeof options.fallback === 'string' && TIER_KEYS.includes(options.fallback) ? options.fallback : TIER_KEYS[0]
  return { tier: fallback, source: 'config' }
}

/** 组装界面需要的档位选项（含单价文案）。 */
export async function buildModelChoiceView(options) {
  const choice = await readModelChoice(options.config)
  const labels = {
    request: '本次调用显式指定',
    ui: '界面选择',
    config: '插件配置默认',
  }
  const { tier: effective, source } = resolveEffectiveTier({
    config: options.config,
    fallback: options.fallback ?? options.config.defaultModel,
    choice,
  })
  return {
    tier: effective,
    source,
    sourceLabel: labels[source],
    selectedTier: choice?.tier ?? null,
    updatedAt: choice?.updatedAt ?? null,
    file: modelChoicePathOf(options.config),
  }
}
