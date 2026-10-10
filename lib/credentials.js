/**
 * API Key 解析：按「金库 → DSH 凭据 seam → 进程环境」的顺序取第一个可用值。
 *
 * 顺序刻意把 DPAPI 金库放在最前：它是本项目唯一满足「禁止明文存储」的来源，
 * 而 seam/env 可能残留旧的明文值；若让后者优先，用户会看到「明明换过 Key 却仍旧失败」
 * 这类难以归因的现象。三者的实际取值来源都会回传，供状态查询如实呈现。
 */

import { SeedreamError } from './errors.js'
import { getSecret, vaultStatus } from './vault.js'
import { vaultPathOf } from './config.js'

/**
 * @param {object} options
 * @param {import('./config.js').DEFAULTS & Record<string, any>} options.config 归一化配置。
 * @param {{ get?: (name: string) => any }|undefined} [options.ctx] Cordis 上下文（用于 credentials seam）。
 * @returns {Promise<{ value: string, source: string }>}
 */
export async function resolveApiKey(options) {
  const { config } = options
  const ref = config.apiKeyEnv
  const path = vaultPathOf(config)

  const vaulted = await getSecret({ path, powershellPath: config.powershellPath })
  if (typeof vaulted === 'string' && vaulted.trim() !== '') {
    return { value: vaulted, source: `DPAPI 金库（${path}）` }
  }

  const credentials = options.ctx?.get?.('credentials')
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined && typeof hit.value === 'string' && hit.value !== '') {
        return { value: hit.value, source: `凭据服务 ${ref}（source=${hit.source ?? 'unknown'}）` }
      }
    } catch (error) {
      // 凭据服务异常不应掩盖「未配置」这一结论，但要把原因带出来。
      throw new SeedreamError(
        'MISSING_CREDENTIAL',
        `读取凭据 ${ref} 失败：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }

  const fromProcess = process.env[ref]
  if (typeof fromProcess === 'string' && fromProcess.trim() !== '') {
    return { value: fromProcess, source: `进程环境变量 ${ref}` }
  }

  throw new SeedreamError(
    'MISSING_CREDENTIAL',
    [
      `未找到 Seedream（火山方舟）API Key：金库、凭据 ${ref} 与进程环境都没有值。`,
      `推荐做法：在插件目录运行 seedream CLI 的 key set（node bin/seedream.mjs key set），把 Key 用 Windows DPAPI 加密写入 ${path}（磁盘上只有密文）。`,
      `也可以把 ${ref} 放进进程环境或 DSH 凭据库，但那样是明文存储。`,
    ].join('\n'),
  )
}

/** 状态查询：报告每个来源是否配置（不返回任何秘密、也不解密）。 */
export async function describeApiKey(options) {
  const { config } = options
  const ref = config.apiKeyEnv
  const path = vaultPathOf(config)
  const status = await vaultStatus(path)
  const credentials = options.ctx?.get?.('credentials')
  let seamConfigured
  if (credentials !== undefined && typeof credentials.describe === 'function') {
    try {
      const info = await credentials.describe(ref)
      seamConfigured = info?.configured === true
    } catch {
      seamConfigured = undefined
    }
  }
  const fromProcess = typeof process.env[ref] === 'string' && process.env[ref].trim() !== ''
  return {
    reference: ref,
    vault: status,
    credentialsServiceConfigured: seamConfigured,
    processEnvironmentConfigured: fromProcess,
    configured: status.configured || seamConfigured === true || fromProcess,
    effectiveSource: status.configured
      ? 'vault'
      : seamConfigured === true
        ? 'credentials'
        : fromProcess
          ? 'environment'
          : undefined,
  }
}
