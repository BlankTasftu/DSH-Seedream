/**
 * 素材落盘与引用图读取。
 *
 * 落盘位置默认是「会话工作目录 / images/seedream」，路径逃逸默认拒绝：
 * 参考图与输出目录都可能是模型可控输入，越界读写会把工作区之外的文件带进外发请求。
 */

import { readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { SeedreamError } from './errors.js'

/** 参考图单张上限（方舟限制 30MB）。 */
const MAX_REFERENCE_BYTES = 30 * 1024 * 1024

/** 按魔数嗅探图片真实格式；识别不出返回 undefined。 */
export function sniffMediaType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 6) {
    const head = bytes.toString('latin1', 0, 6)
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  }
  return undefined
}

/** 媒体类型 → 方舟 data URL 里的格式名（必须小写）。 */
export function formatNameOf(mediaType) {
  return mediaType.replace(/^image\//, '').toLowerCase()
}

/** 媒体类型 → 落盘扩展名。 */
export function extensionOf(mediaType) {
  if (mediaType === 'image/jpeg') return 'jpg'
  if (mediaType === 'image/webp') return 'webp'
  if (mediaType === 'image/gif') return 'gif'
  return 'png'
}

/** 组装方舟接受的 data URL。 */
export function toDataUrl(bytes, mediaType) {
  return `data:image/${formatNameOf(mediaType)};base64,${bytes.toString('base64')}`
}

function ensureInside(root, target, label) {
  const relativePath = relative(root, target)
  if (relativePath === '') return
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new SeedreamError(
      'INVALID_ARGUMENT',
      `${label} ${target} 逃出会话工作目录 ${root}；如需写在工作区之外，请在配置里显式打开 allowOutsideCwd`,
    )
  }
}

/**
 * 解析一个路径输入：URL / data URL 原样透传，本地路径按 cwd 解析并做逃逸校验。
 * @param {string} reference 模型给出的参考图。
 * @param {{ cwd: string, allowOutsideCwd: boolean, signal?: AbortSignal }} options
 */
export async function resolveReference(reference, options) {
  const value = typeof reference === 'string' ? reference.trim() : ''
  if (value === '') throw new SeedreamError('INVALID_ARGUMENT', '参考图为空字符串')
  if (/^https?:\/\//i.test(value)) return { value, kind: 'url' }
  if (/^data:image\//i.test(value)) return { value, kind: 'data-url' }

  const root = resolve(options.cwd)
  const absolute = isAbsolute(value) ? resolve(value) : resolve(root, value)
  if (!options.allowOutsideCwd) ensureInside(root, absolute, '参考图')
  let info
  try {
    info = await stat(absolute)
  } catch {
    throw new SeedreamError('INVALID_ARGUMENT', `参考图不存在：${absolute}`)
  }
  if (!info.isFile()) throw new SeedreamError('INVALID_ARGUMENT', `参考图不是普通文件：${absolute}`)
  if (info.size > MAX_REFERENCE_BYTES) {
    throw new SeedreamError('INVALID_ARGUMENT', `参考图 ${absolute} 为 ${formatBytes(info.size)}，超过方舟 30MB 上限`)
  }
  const bytes = await readFile(absolute)
  const mediaType = sniffMediaType(bytes)
  if (mediaType === undefined) {
    throw new SeedreamError('INVALID_ARGUMENT', `参考图 ${absolute} 不是受支持的图片（PNG/JPEG/WebP/GIF）`)
  }
  return { value: toDataUrl(bytes, mediaType), kind: 'file', path: absolute, mediaType, bytes: info.size }
}

/** 人类可读的字节数。 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** 文件名 slug：只保留字母数字与连字符，中文等非 ASCII 一律折叠为连字符。 */
export function slugify(text, maxLength = 40) {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '')
  return slug === '' ? 'image' : slug
}

/** 本地时间戳，形如 20261010-115530。 */
export function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * 规划输出文件路径（不写入）。同名时自动追加序号，避免覆盖历史素材。
 * @param {{ cwd: string, outputDir: string, allowOutsideCwd: boolean, slug: string, extensions: string[] }} options
 */
export function planOutputPaths(options) {
  const root = resolve(options.cwd)
  const directory = isAbsolute(options.outputDir) ? resolve(options.outputDir) : resolve(root, options.outputDir)
  if (!options.allowOutsideCwd) ensureInside(root, directory, '输出目录')
  const stamp = timestamp()
  const total = options.extensions.length
  const paths = []
  for (let index = 0; index < total; index += 1) {
    const suffix = total > 1 ? `-${index + 1}` : ''
    const extension = options.extensions[index]
    let candidate = join(directory, `seedream-${stamp}-${options.slug}${suffix}.${extension}`)
    let bump = 2
    while (existsSync(candidate)) {
      candidate = join(directory, `seedream-${stamp}-${options.slug}${suffix}-${bump}.${extension}`)
      bump += 1
    }
    paths.push(candidate)
  }
  return { directory, paths }
}

/**
 * 从图片字节里读出像素尺寸（PNG/JPEG，覆盖方舟两种 output_format）。
 * 附件服务不可用时也能在文本信封里如实报告尺寸；读不出返回 undefined。
 */
export function readDimensions(bytes, mediaType) {
  try {
    if (mediaType === 'image/png' && bytes.length >= 24) {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    }
    if (mediaType === 'image/jpeg') {
      let offset = 2
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1
          continue
        }
        const marker = bytes[offset + 1]
        const length = bytes.readUInt16BE(offset + 2)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) }
        }
        offset += 2 + length
      }
    }
  } catch {
    return undefined
  }
  return undefined
}


/** 写一个文件（自动建目录）。 */
export async function writeFileEnsured(path, bytes) {
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(path, bytes)
  return path
}

/** 会话工作目录：优先工具执行上下文里的 agent cwd，其次进程 cwd。 */
export function sessionCwd(exec) {
  const fromAgent = exec?.agent?.session?.header?.cwd
  if (typeof fromAgent === 'string' && fromAgent.trim() !== '') return fromAgent
  return process.cwd()
}

/** 相对工作目录的展示路径（越界时退回绝对路径）。 */
export function displayPath(cwd, absolute) {
  const relativePath = relative(resolve(cwd), absolute)
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) return absolute
  return relativePath.split(sep).join('/')
}
