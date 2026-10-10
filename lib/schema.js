/**
 * schemastery 形式的配置声明：让 DSH 配置面板与 loader 看到字段类型与默认值。
 *
 * 刻意做成**可选**：`link:` 方式安装的插件不会连带安装自身依赖，
 * 若在这里硬 import `@deepseek-ai/schemastery`，插件会整体 import 失败。
 * 因此用动态 import 探测，拿不到就返回 undefined —— DSH 允许插件不声明 Config，
 * 运行时的默认值与校验始终由 `lib/config.js` 的 resolveConfig 负责，行为不变。
 */

import { DEFAULTS } from './config.js'

/** 构建配置 schema；环境里没有 schemastery 时返回 undefined。 */
export async function loadConfigSchema() {
  let z
  try {
    const module = await import('@deepseek-ai/schemastery')
    z = module.default ?? module
  } catch {
    return undefined
  }
  if (z === undefined || typeof z.object !== 'function') return undefined
  try {
    return z.object({
      apiKeyEnv: z.string().default(DEFAULTS.apiKeyEnv).description('凭据引用名（环境变量名），默认 ARK_API_KEY'),
      vaultPath: z.string().default(DEFAULTS.vaultPath).description('DPAPI 金库文件路径；留空用 <DSH_HOME>/seedream/ark-key.vault.json'),
      baseUrl: z.string().default(DEFAULTS.baseUrl).description('方舟网关地址（含 /api/v3）'),
      defaultModel: z.string().default(DEFAULTS.defaultModel).description('默认生成档位：5.0 / 5.0-pro'),
      editModel: z.string().default(DEFAULTS.editModel).description('默认编辑档位'),
      model5: z.string().default(DEFAULTS.model5).description('档位 5.0 的 Model ID'),
      model5Pro: z.string().default(DEFAULTS.model5Pro).description('档位 5.0-pro 的 Model ID'),
      outputDir: z.string().default(DEFAULTS.outputDir).description('生成物落盘目录（相对会话工作目录）'),
      allowOutsideCwd: z.boolean().default(DEFAULTS.allowOutsideCwd).description('允许输出目录与参考图逃出会话工作目录'),
      requestTimeoutMs: z.number().default(DEFAULTS.requestTimeoutMs).description('单次同步生成请求超时（毫秒）'),
      rateLimitRetries: z.number().default(DEFAULTS.rateLimitRetries).description('429 限流重试次数'),
      rateLimitBackoffMs: z.number().default(DEFAULTS.rateLimitBackoffMs).description('429 退避间隔（毫秒）'),
      watermark: z.boolean().default(DEFAULTS.watermark).description('默认是否加方舟水印'),
      maxImagesPerCall: z.number().default(DEFAULTS.maxImagesPerCall).description('单次调用最多产出张数'),
      powershellPath: z.string().default(DEFAULTS.powershellPath).description('PowerShell 可执行文件路径（DPAPI 加解密用），留空自动探测'),
      promptSection: z.boolean().default(DEFAULTS.promptSection).description('是否注册 Seedream 能力提示段'),
      ledgerPath: z.string().default(DEFAULTS.ledgerPath).description('用量台账（JSONL）路径；留空用 <DSH_HOME>/seedream/usage.jsonl'),
      priceFilePath: z.string().default(DEFAULTS.priceFilePath).description('价格文件路径；留空用 <DSH_HOME>/seedream/prices.json'),
      priceCurrency: z.string().default(DEFAULTS.priceCurrency).description('计价币种（仅用于展示）'),
      price5: z.union([z.number(), z.string()]).default(DEFAULTS.price5).description('5.0 档单价（元/张），留空=未配置'),
      price5High: z.union([z.number(), z.string()]).default(DEFAULTS.price5High).description('5.0 档高清单价（元/张）'),
      price5Pro: z.union([z.number(), z.string()]).default(DEFAULTS.price5Pro).description('5.0-pro 档单价（元/张）'),
      price5ProHigh: z.union([z.number(), z.string()]).default(DEFAULTS.price5ProHigh).description('5.0-pro 档高清单价（元/张）'),
      priceHighPixelThreshold: z.number().default(DEFAULTS.priceHighPixelThreshold).description('高清档像素阈值'),
      uiBadgePosition: z.string().default(DEFAULTS.uiBadgePosition).description('客户端计费徽标位置：bottom-left / bottom-right / top-left / top-right'),
      uiKeyHint: z.boolean().default(DEFAULTS.uiKeyHint).description('是否在界面显示 Key 指纹（不可逆，仅用于辨认是哪一把）；设 false 只显示已配置/未配置'),
      billingVaultPath: z.string().default(DEFAULTS.billingVaultPath).description('费用中心 AK/SK 金库路径；留空用 <DSH_HOME>/seedream/billing.vault.json'),
      billingRegion: z.string().default(DEFAULTS.billingRegion).description('费用中心 OpenAPI 地域'),
      billingHost: z.string().default(DEFAULTS.billingHost).description('费用中心 OpenAPI 主机'),
      billingTimeoutMs: z.number().default(DEFAULTS.billingTimeoutMs).description('余额查询超时（毫秒）'),
      billingCacheSeconds: z.number().default(DEFAULTS.billingCacheSeconds).description('余额缓存秒数（界面轮询不会每次都打费用中心）'),
      budgetTotal: z.union([z.number(), z.string()]).default(DEFAULTS.budgetTotal).description('本地预算：已充值总额（元），0 = 未设置'),
      budgetSince: z.string().default(DEFAULTS.budgetSince).description('本地预算起始日期（ISO，留空 = 全部台账）'),
      budgetFilePath: z.string().default(DEFAULTS.budgetFilePath).description('预算文件路径；留空用 <DSH_HOME>/seedream/budget.json'),
    })
  } catch {
    return undefined
  }
}
