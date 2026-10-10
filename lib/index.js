/**
 * dsh-seedream：把 Seedream（火山方舟）接入为 DSH 的图片与图像素材生成能力。
 *
 * Host facet 入口。做四件事：
 * 1. 归一化配置（`lib/config.js`）；
 * 2. 在 tools seam 上注册 seedream_generate / seedream_edit / seedream_status / seedream_usage；
 * 3. 注册一段能力提示，让模型知道何时该用它们；
 * 4. 注册客户端界面：实时计费徽标 + API/单价管理面板（`lib/ui.js` + `lib/client.js`）。
 *
 * API Key 一律通过 `lib/vault.js`（Windows DPAPI 密文）或 DSH 凭据 seam 解析，
 * 插件代码与配置里不出现任何明文。插件本体零运行时依赖：
 * 配置 schema 通过动态 import 可选加载（见 lib/schema.js）。
 */

import { loadConfigSchema } from './schema.js'
import { resolveConfig } from './config.js'
import { registerTools } from './tools.js'
import { registerClientUi, registerIndexInjection } from './ui.js'

/** 配置 schema；环境里没有 schemastery 时为 undefined（不影响功能）。 */
const Config = await loadConfigSchema()

export const name = 'dsh-seedream'
export { Config }

/** 系统提示段顺序：跟在 dsh-ops 的工具策略段（3250）之后。 */
const PROMPT_SECTION_ORDER = 3300

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const log = (level, message) => {
    const logger = ctx.logger
    if (typeof logger?.[level] === 'function') logger[level](message)
    else if (level === 'warn') console.warn(message)
    else console.error(message)
  }

  // ① 界面注入行必须**最先**注册：桌面壳在宿主启动时一次性收集这张表，
  //    晚于那次收集的订阅永远进不了表，界面就不会出现。
  const injection = registerIndexInjection(ctx)
  ctx.effect(
    () => () => {
      try {
        injection()
      } catch (error) {
        log('warn', `dsh-seedream: 卸载界面注入失败：${error instanceof Error ? error.message : String(error)}`)
      }
    },
    'dsh-seedream: index injection',
  )

  // ② 客户端界面路由：等 webServer（以及可选的 connection 信任栅栏）就绪。
  ctx.inject(['webServer'], (scope) => {
    const routes = registerClientUi(scope, config, log)
    scope.effect(
      () => () => {
        for (const dispose of routes) {
          try {
            dispose()
          } catch (error) {
            log('warn', `dsh-seedream: 卸载界面路由失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }
      },
      'dsh-seedream: client routes',
    )
  })

  ctx.inject(['tools'], (scope) => {
    const disposers = registerTools(scope, config, log)
    scope.effect(
      () => () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch (error) {
            log('warn', `dsh-seedream: 卸载工具失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }
      },
      'dsh-seedream: tools',
    )
    log('info', `dsh-seedream: 已注册 ${disposers.length} 个工具（默认档位 ${config.defaultModel}，产出目录 ${config.outputDir}）`)
  })

  if (config.promptSection) {
    ctx.inject(['systemPrompt'], (scope) => {
      scope.effect(
        () => scope.systemPrompt.section({
          name: 'dsh-seedream:image-generation',
          order: PROMPT_SECTION_ORDER,
          interpolate: false,
          text: () => [
            '## 图片与图像素材生成（Seedream / 火山方舟）',
            '',
            `需要产出图片素材时，用 \`seedream_generate\`；需要按已有图改造时用 \`seedream_edit\`（基准图放 \`images\`，用「图一/图二」指代）。两者都会把图落盘（默认 ${config.outputDir}/）并直接回显图片本身。`,
            `可用档位：5.0-pro（1K–2K，单张最精细，默认 ${config.defaultModel}）/ 5.0-flash（2K–4K，出图快、画幅大）。两个档位都不支持一次请求出多张，count>1 会串行多次调用。`,
            '每次生成的结果里带本次计费张数与费用（今日累计），要按周期看总账就用 `seedream_usage`。金额是按本地价表的估算——方舟按返回张数计费，单价只在控制台可见；未配置单价时如实标注，不要编造金额。',
            'Key 或配额异常时先调用 `seedream_status` 确认配置，再决定是否重试；不要为了绕过失败而改用其它图像服务。',
            '用户在对话窗口的模型选项里选定的档位会成为**默认档位**：省略 `model` 参数时就用它；除非用户明确要求换档位，否则不要传 `model`。',
            'DSH 界面左下角有实时计费徽标，点开即可管理 API Key、单价与余额：需要用户改配置时，直接告诉他去点那个徽标，不必让他敲命令行。',
          ].join('\n'),
        }),
        'dsh-seedream: prompt section',
      )
    })
  }
}
