/**
 * DPAPI 金库：API Key 只以 Windows DPAPI（当前用户范围）密文落盘，磁盘上永不出现明文。
 *
 * 设计要点：
 * - 明文只在三处短暂存在：调用进程内存、子进程 stdin、子进程 stdout；不落盘、不进日志、不进命令行。
 * - 加解密由 PowerShell 完成（Node 无内置 DPAPI）：`ConvertFrom-SecureString` /
 *   `ConvertTo-SecureString` 默认就是 DPAPI 用户范围，无需额外模块。
 * - stdin/stdout 一律按 UTF-8 原始字节读写，避免控制台代码页把非 ASCII 字符弄坏。
 * - 密文与解释器解耦：任何能以同一 Windows 用户运行的进程都能解开，与 DSH 进程树无关。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SeedreamError, describeError, redactSecrets } from './errors.js'
import { dshHome } from './config.js'

/** 金库文件格式版本。 */
const VAULT_VERSION = 1
const BACKEND = 'dpapi-user'

/** 从 stdin 读取原始字节并按 UTF-8 解码的 PowerShell 前置片段。 */
const READ_STDIN_UTF8 = `$stdin = [Console]::OpenStandardInput()
$memory = [System.IO.MemoryStream]::new()
$stdin.CopyTo($memory)
$text = [System.Text.Encoding]::UTF8.GetString($memory.ToArray())`

const ENCRYPT_SCRIPT = `${READ_STDIN_UTF8}
$secure = ConvertTo-SecureString -String $text -AsPlainText -Force
ConvertFrom-SecureString -SecureString $secure`

const DECRYPT_SCRIPT = `${READ_STDIN_UTF8}
$secure = ConvertTo-SecureString -String $text.Trim()
$plain = ([System.Net.NetworkCredential]::new('', $secure)).Password
$stdout = [Console]::OpenStandardOutput()
$bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)
$stdout.Write($bytes, 0, $bytes.Length)
$stdout.Flush()`

/** 已探测成功的 PowerShell 可执行文件（进程级缓存）。 */
let cachedPowerShell

/**
 * PowerShell 候选路径：显式配置 → PATH 上的 pwsh → DSH 自带 pwsh → 系统安装 → Windows PowerShell。
 * @param {string} configured 配置里的 powershellPath。
 */
export function powerShellCandidates(configured) {
  const candidates = []
  if (typeof configured === 'string' && configured.trim() !== '') candidates.push(configured.trim())
  candidates.push('pwsh')
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir.trim() !== '') {
    candidates.push(join(profileDir.trim(), 'node_modules', '@dsh-ops', 'pwsh-win32-x64', 'bin', 'pwsh.exe'))
  }
  try {
    const profilesRoot = join(dshHome(), 'profiles')
    if (existsSync(profilesRoot)) {
      for (const name of readdirSync(profilesRoot)) {
        candidates.push(join(profilesRoot, name, 'node_modules', '@dsh-ops', 'pwsh-win32-x64', 'bin', 'pwsh.exe'))
      }
    }
  } catch {
    // 目录不可读时静默跳过：后面的候选仍可能可用。
  }
  candidates.push('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
  candidates.push(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  return [...new Set(candidates)]
}

/**
 * 运行一段 PowerShell 脚本，明文经 stdin 进、经 stdout 出。
 * @param {string} script 脚本正文（不含秘密）。
 * @param {string} input 传给 stdin 的文本。
 * @param {string} configuredPath 配置的 PowerShell 路径。
 * @returns {Promise<string>} stdout 文本（UTF-8）。
 */
async function runPowerShell(script, input, configuredPath) {
  const candidates = cachedPowerShell === undefined
    ? powerShellCandidates(configuredPath)
    : [cachedPowerShell, ...powerShellCandidates(configuredPath)]
  const failures = []
  for (const executable of candidates) {
    const result = await spawnOnce(executable, script, input)
    if (result.ok) {
      cachedPowerShell = executable
      return result.stdout
    }
    failures.push(`${executable}: ${result.detail}`)
    // 只有「找不到可执行文件」才继续换下一个候选；脚本本身失败说明解释器可用，直接暴露原因。
    if (!result.missing) break
  }
  throw new SeedreamError(
    'POWERSHELL_MISSING',
    `无法通过 PowerShell 完成 DPAPI 加解密。请确认已安装 PowerShell 7（pwsh），或在配置中指定 powershellPath。尝试记录：\n${redactSecrets(failures.join('\n'))}`,
  )
}

function spawnOnce(executable, script, input) {
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolvePromise({ ok: false, missing: true, detail: describeError(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      const missing = /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT'
      resolvePromise({ ok: false, missing, detail: describeError(error) })
    })
    child.on('close', (code) => {
      if (code === 0) resolvePromise({ ok: true, stdout })
      else resolvePromise({ ok: false, missing: false, detail: `exit ${code}: ${stderr.trim().slice(0, 400)}` })
    })
    child.stdin.end(input)
  })
}

/** 读取金库文件；不存在或格式不符时返回 undefined。 */
export async function readVault(path) {
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return undefined
    if (parsed.v !== VAULT_VERSION || parsed.backend !== BACKEND) return undefined
    if (typeof parsed.payload !== 'string' || parsed.payload.trim() === '') return undefined
    return parsed
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined
    throw new SeedreamError('VAULT_ERROR', `读取金库 ${path} 失败：${describeError(error)}`, { cause: error })
  }
}

/** 金库状态（不含任何秘密，指纹本身就是为展示而生的不可逆信息）。 */
export async function vaultStatus(path) {
  const record = await readVault(path)
  return {
    configured: record !== undefined,
    path,
    backend: record === undefined ? undefined : BACKEND,
    updatedAt: record === undefined ? undefined : record.updatedAt,
    hint: record === undefined ? undefined : record.hint,
    bytes: record === undefined ? undefined : String(record.payload ?? '').length,
  }
}

/**
 * 可展示的 Key 指纹：**只在写入时**由明文算出，落盘的是不可逆哈希 + 首尾各 4 字符。
 * 目的是让界面能显示「当前配的是哪一把」，而不是把明文暴露出去。
 * @param {string} secret 明文秘密。
 */
export function keyHint(secret) {
  const text = String(secret)
  return {
    prefix: text.slice(0, 4),
    suffix: text.length > 8 ? text.slice(-4) : '',
    length: text.length,
    hash: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8),
  }
}

/** 原子写入金库文档（内部共用）。 */
async function writeVaultDocument(path, document) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
  await hardenFile(path)
}

/**
 * 写入秘密：DPAPI 加密后原子替换金库文件（同时记录指纹，供界面显示）。
 * @param {string} secret 明文秘密（只在这里短暂存在）。
 * @param {{ path: string, powershellPath?: string }} options
 */
export async function setSecret(secret, options) {
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new SeedreamError('VAULT_ERROR', '拒绝写入空的 API Key')
  }
  const value = secret.trim()
  const payload = (await runPowerShell(ENCRYPT_SCRIPT, value, options.powershellPath ?? '')).trim()
  if (!/^[0-9a-fA-F]+$/.test(payload)) {
    throw new SeedreamError('VAULT_ERROR', 'DPAPI 加密结果不是预期的十六进制密文，已中止写入')
  }
  const path = options.path
  const updatedAt = new Date().toISOString()
  const hint = keyHint(value)
  await writeVaultDocument(path, {
    v: VAULT_VERSION,
    backend: BACKEND,
    scope: 'current-user',
    updatedAt,
    hint,
    payload,
  })
  return { path, backend: BACKEND, updatedAt, hint }
}

/**
 * 补写指纹：早期版本写的金库没有 hint 字段。这里解密一次算出指纹并落盘（每个进程只做一次），
 * 让界面在旧金库上也能显示「当前是哪一把」。
 * @param {{ path: string, powershellPath?: string }} options
 */
export async function ensureKeyHint(options) {
  const record = await readVault(options.path)
  if (record === undefined) return undefined
  if (record.hint !== undefined && typeof record.hint === 'object') return record.hint
  const secret = await getSecret({ path: options.path, powershellPath: options.powershellPath })
  if (secret === undefined) return undefined
  const hint = keyHint(secret)
  await writeVaultDocument(options.path, { ...record, hint })
  return hint
}

/** 解密金库中的秘密；未配置返回 undefined。 */
export async function getSecret(options) {
  const record = await readVault(options.path)
  if (record === undefined) return undefined
  const plain = await runPowerShell(DECRYPT_SCRIPT, record.payload, options.powershellPath ?? '')
  if (plain === '') {
    throw new SeedreamError('VAULT_ERROR', `金库 ${options.path} 解密结果为空；请用 seedream key set 重新写入`)
  }
  return plain
}

/** 删除金库文件。 */
export async function clearVault(path) {
  await rm(path, { force: true })
  return { path, removed: true }
}

/** 尽力收紧文件权限（DPAPI 已绑定当前用户，这里只是纵深防御）。 */
async function hardenFile(path) {
  try {
    await chmod(path, 0o600)
  } catch {
    // Windows 上 chmod 语义有限，失败不影响安全模型。
  }
  const user = process.env.USERNAME
  if (typeof user !== 'string' || user.trim() === '') return
  await new Promise((resolvePromise) => {
    const child = spawn('icacls', [path, '/inheritance:r', '/grant:r', `${user.trim()}:F`], {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', () => resolvePromise(undefined))
    child.on('close', () => resolvePromise(undefined))
  })
}
