/**
 * 客户端脚本的 DOM 行为自检（不需要浏览器）。
 *
 * 用一套最小 DOM 桩把 `lib/client.js` 跑起来，验证两件最容易出错、又最难靠肉眼发现的事：
 *   1. 模型选择器**内联进输入框控制行**（`[class*="standardControls"]`，即「模型选择」那一组），
 *      而不是浮在上方；找不到控制行时才回退为浮层。
 *   2. 切换档位会 POST `/dsh-seedream/model`（选中具体档位）或 `{clear:true}`（恢复默认）。
 *
 * 桩刻意做成「结构无关」：只实现 client.js 用到的那部分 DOM API。
 * 运行：node test/client-dom.mjs
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(join(here, '..', 'lib', 'client.js'), 'utf8')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` —— ${detail}`}`)
  }
}

// ---------------------------------------------------------------- 最小 DOM

class ClassList {
  constructor(node) {
    this.node = node
  }
  add(...names) {
    const set = new Set(this.node.className.split(/\s+/).filter(Boolean))
    for (const name of names) set.add(name)
    this.node.className = [...set].join(' ')
  }
  contains(name) {
    return this.node.className.split(/\s+/).includes(name)
  }
  remove(...names) {
    const set = new Set(this.node.className.split(/\s+/).filter(Boolean))
    for (const name of names) set.delete(name)
    this.node.className = [...set].join(' ')
  }
}

class Element {
  constructor(tag, owner) {
    this.tagName = String(tag).toUpperCase()
    this.ownerDocument = owner
    this.children = []
    this.parentElement = null
    this.attributes = {}
    this.dataset = {}
    this._text = ''
    this.style = new Proxy({}, { set: (target, key, value) => ((target[key] = value), true), get: (target, key) => target[key] ?? '' })
    this.classList = new ClassList(this)
    this.value = ''
    this.hidden = false
    this.listeners = {}
    this.rect = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }
    this.id = ''
    this.title = ''
  }
  get isConnected() {
    let node = this
    while (node.parentElement !== null) node = node.parentElement
    return node === this.ownerDocument.body || node === this.ownerDocument.documentElement
  }
  /** className 与 attributes.class 必须同步：选择器是按属性匹配的。 */
  get className() {
    return this.attributes.class ?? ''
  }
  set className(value) {
    this.attributes.class = String(value ?? '')
  }
  /** 桩里没有文本节点：childNodes 等价于 children。 */
  get childNodes() {
    return this.children
  }
  get firstChild() {
    return this.children[0] ?? null
  }
  get textContent() {
    if (this.children.length === 0) return this._text
    return this.children.map((child) => child.textContent).join('')
  }
  set textContent(value) {
    for (const child of [...this.children]) this.removeChild(child)
    this._text = String(value ?? '')
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value)
    if (name === 'class') this.className = String(value)
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value)
  }
  getAttribute(name) {
    return this.attributes[name] ?? null
  }
  removeAttribute(name) {
    delete this.attributes[name]
  }
  toggleAttribute(name, force) {
    const on = force === undefined ? !(name in this.attributes) : force
    if (on) this.setAttribute(name, '')
    else this.removeAttribute(name)
    return on
  }
  appendChild(child) {
    if (child.parentElement !== null) child.parentElement.removeChild(child)
    child.parentElement = this
    this.children.push(child)
    return child
  }
  insertBefore(child, reference) {
    if (child.parentElement !== null) child.parentElement.removeChild(child)
    const index = reference === null ? this.children.length : this.children.indexOf(reference)
    this.children.splice(index < 0 ? this.children.length : index, 0, child)
    child.parentElement = this
    return child
  }
  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentElement = null
    return child
  }
  remove() {
    if (this.parentElement !== null) this.parentElement.removeChild(this)
  }
  contains(node) {
    let current = node
    while (current !== null) {
      if (current === this) return true
      current = current.parentElement
    }
    return false
  }
  addEventListener(type, handler) {
    ;(this.listeners[type] ??= []).push(handler)
  }
  removeEventListener(type, handler) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((item) => item !== handler)
  }
  dispatch(type, event = {}) {
    for (const handler of this.listeners[type] ?? []) handler({ type, target: this, stopPropagation() {}, preventDefault() {}, ...event })
  }
  getBoundingClientRect() {
    return { ...this.rect, x: this.rect.left, y: this.rect.top }
  }
  getClientRects() {
    return this.rect.width > 0 && this.rect.height > 0 && this.hidden !== true ? [this.rect] : []
  }
  get offsetWidth() {
    return this.rect.width
  }
  get offsetParent() {
    return this.parentElement
  }
  /** 极简选择器：支持 tag、.class、#id、[attr]、[attr*="v"]、tag[attr] 与后代空格组合。 */
  matches(selector) {
    for (const part of selector.trim().split(/\s+/)) {
      if (!matchesSimple(this, part)) return false
    }
    return true
  }
  querySelectorAll(selector) {
    const parts = selector.trim().split(/\s+/)
    const last = parts[parts.length - 1]
    const ancestors = parts.slice(0, -1)
    const out = []
    const walk = (node) => {
      for (const child of node.children) {
        if (matchesSimple(child, last)) {
          // 祖先链必须依次匹配（简单实现：只要求祖先中按顺序出现）
          let cursor = child.parentElement
          let index = ancestors.length - 1
          let ok = index < 0
          while (!ok && cursor !== null) {
            if (matchesSimple(cursor, ancestors[index])) {
              index -= 1
              ok = index < 0
            }
            cursor = cursor.parentElement
          }
          if (ok) out.push(child)
        }
        walk(child)
      }
    }
    if (ancestors.length === 0 && matchesSimple(this, last)) out.push(this)
    walk(this)
    return out
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }
}

function matchesSimple(node, simple) {
  if (node === null || node === undefined) return false
  let rest = simple
  const attrs = []
  rest = rest.replace(/\[([^\]]+)\]/g, (_, inner) => {
    attrs.push(inner)
    return ''
  })
  const idMatch = rest.match(/#([\w-]+)/)
  if (idMatch !== null) {
    if (node.id !== idMatch[1]) return false
    rest = rest.replace(idMatch[0], '')
  }
  const classMatches = [...rest.matchAll(/\.([\w-]+)/g)]
  for (const match of classMatches) {
    if (!node.classList.contains(match[1])) return false
  }
  rest = rest.replace(/\.[\w-]+/g, '')
  if (rest !== '' && node.tagName !== rest.toUpperCase()) return false
  for (const attr of attrs) {
    const star = attr.match(/^([\w-]+)\*=("?)(.*?)\2$/)
    if (star !== null) {
      const value = node.getAttribute(star[1])
      if (value === null || !value.includes(star[3])) return false
      continue
    }
    if (node.getAttribute(attr) === null) return false
  }
  return true
}

class Document extends Element {
  constructor() {
    super('#document', null)
    this.ownerDocument = this
    this.head = new Element('head', this)
    this.body = new Element('body', this)
    this.appendChild(this.head)
    this.appendChild(this.body)
    this.documentElement = this
  }
  createElement(tag) {
    return new Element(tag, this)
  }
}

function buildEnvironment({ withComposer }) {
  const document = new Document()
  if (withComposer) {
    const card = document.createElement('div')
    card.className = 'RlGAzG_card'
    card.setAttribute('data-composer-card', '')
    card.rect = { left: 640, top: 760, width: 720, height: 120, right: 1360, bottom: 880 }
    const modes = document.createElement('div')
    modes.className = 'RlGAzG_modes'
    modes.rect = { left: 660, top: 850, width: 200, height: 24, right: 860, bottom: 874 }
    const standard = document.createElement('div')
    standard.className = 'RlGAzG_standardControls'
    standard.rect = { left: 1180, top: 850, width: 160, height: 24, right: 1340, bottom: 874 }
    const editor = document.createElement('div')
    editor.className = 'RlGAzG_input'
    editor.setAttribute('contenteditable', 'true')
    editor.rect = { left: 660, top: 790, width: 680, height: 48, right: 1340, bottom: 838 }
    card.appendChild(editor)
    card.appendChild(modes)
    card.appendChild(standard)
    document.body.appendChild(card)
  }
  const requests = []
  const timers = []
  const window = {
    innerWidth: 1920,
    innerHeight: 1080,
    listeners: {},
    addEventListener(type, handler) {
      ;(this.listeners[type] ??= []).push(handler)
    },
    setTimeout: (handler) => {
      timers.push(handler)
      return timers.length
    },
    clearTimeout() {},
  }
  const storage = {}
  return {
    document,
    window,
    requests,
    timers,
    localStorage: {
      getItem: (key) => storage[key] ?? null,
      setItem: (key, value) => {
        storage[key] = String(value)
      },
      removeItem: (key) => {
        delete storage[key]
      },
    },
    setTimeout: (handler) => {
      timers.push(handler)
      return timers.length
    },
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    fetch: async (url, init) => {
      requests.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, selectedTier: null, tier: '5.0-pro' }),
        text: async () => '{}',
      }
    },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
    requestAnimationFrame: (handler) => {
      timers.push(handler)
      return 1
    },
    console,
  }
}

/** 用桩环境执行 client.js，并吐出内部可观测点。 */
async function loadClient(options) {
  const env = buildEnvironment(options)
  const state = {
    tooltip: options.tooltip,
  }
  const fakeState = {
    ok: true,
    configured: true,
    usage: { today: { images: 3, costText: '¥0.96' }, all: { images: 12 } },
    tiers: [
      { tier: '5.0-pro', alias: 'Seedream 5.0 Pro' },
      { tier: '5.0-flash', alias: 'Seedream 5.0 Flash' },
    ],
    prices: { entries: [{ tier: '5.0-pro', price: 0.32 }, { tier: '5.0-flash', price: 0.21 }] },
    defaultModel: '5.0-pro',
    ui: { badgePosition: 'bottom-left', modelPicker: options.modelPicker !== false },
    modelChoice: { tier: '5.0-pro', source: 'config', sourceLabel: '插件配置默认', selectedTier: options.selectedTier ?? null },
    key: { configured: true, hint: null, hintEnabled: false, source: 'DPAPI 金库' },
    balance: { mode: 'budget', official: null, budget: { total: 50, spent: 4.05, remaining: 45.95, currency: 'CNY', dailyAverage: 1, daysLeft: 40, unpricedImages: 0 }, billing: { configured: false } },
    recent: [],
    ledger: 'x',
    budgetFile: 'y',
  }
  env.fetch = async (url, init) => {
    env.requests.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
    const text = JSON.stringify(fakeState)
    return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text }
  }
  const fn = new Function(
    'window',
    'document',
    'localStorage',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'MutationObserver',
    'fetch',
    'getComputedStyle',
    'requestAnimationFrame',
    'console',
    source,
  )
  fn(
    env.window,
    env.document,
    env.localStorage,
    env.setTimeout,
    env.clearTimeout,
    env.setInterval,
    env.clearInterval,
    env.MutationObserver,
    env.fetch,
    env.getComputedStyle,
    env.requestAnimationFrame,
    env.console,
  )
  // 让 refresh() 的 promise 链跑完
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  // 执行被排队的 150ms 定位回调
  for (const timer of env.timers.splice(0)) {
    try {
      timer()
    } catch {
      /* 桩环境里部分定时器会失败，忽略 */
    }
  }
  return { env, state: fakeState }
}

function findPicker(document) {
  return document.querySelectorAll('.dshsd-picker')[0] ?? null
}

// ---------------------------------------------------------------- 用例

console.log('客户端 DOM 自检（模型选择器嵌入输入框）')

{
  const { env } = await loadClient({ withComposer: true })
  const picker = findPicker(env.document)
  check('创建了选择器元素', picker !== null)
  check('标记为内联模式', picker?.dataset.inline === '1', String(picker?.dataset.inline))
  const standard = env.document.querySelectorAll('[class*="standardControls"]')[0]
  check('嵌入到「模型选择」那一组里', picker?.parentElement === standard, picker?.parentElement?.className)
  check('没有浮在 body 上', picker?.parentElement !== env.document.body)
  const options = picker === null ? [] : picker.children.filter((child) => child.tagName === 'SELECT')[0].children
  check('选项含默认 + 两个档位', options.length === 3, options.map((option) => option.textContent).join(' / '))
  check('选项文案带档位名与新命名', options.map((option) => option.textContent).join('|').includes('5.0-flash'), options.map((option) => option.textContent).join(' / '))
  check('选项文案带单价', options.map((option) => option.textContent).join('|').includes('¥0.32/张'), options.map((option) => option.textContent).join(' / '))
  check('选中项反映 state', picker.children.filter((child) => child.tagName === 'SELECT')[0].value === '__default__')
  // 位置：插在该行**最前面**，也就是「模型选择」左边
  check('插在控制行最前面（模型选择左侧）', standard.firstChild === picker, standard.children.map((child) => child.className).join(' | '))
  const styleText = env.document.head.children.map((child) => child.textContent).join('\n')
  // 不改动 DSH 输入框的布局：不得出现行间距（gap）覆盖规则
  check('没有覆盖 DSH 的行间距（不改输入框布局）', !/standardControls[^{]*\{[^}]*gap/.test(styleText) && !/:has\(> \.dshsd-picker\)/.test(styleText), styleText.slice(0, 160))
  // 箭头贴文字：select 宽度按当前档位名收敛（不是被最长选项撑开）
  const select = picker.children.filter((child) => child.tagName === 'SELECT')[0]
  check('select 宽度被收敛到当前文案', /^\d+px$/.test(select.style.width), String(select.style.width))
  check('收敛后的宽度明显小于最长选项所需（≤110px）', Number.parseInt(select.style.width, 10) <= 110, String(select.style.width))
  check('选择器自身无内边距（贴着邻居）', /\.dshsd-picker\{[^}]*padding:0[;}]/.test(styleText), styleText.match(/\.dshsd-picker\{[^}]*\}/)?.[0])
}

{
  // 没有输入卡片时回退为浮层，并且能定位到输入框上方
  const { env } = await loadClient({ withComposer: false })
  const picker = findPicker(env.document)
  check('无输入框时仍创建元素', picker !== null)
  check('回退为浮层模式', picker?.dataset.inline === '0', String(picker?.dataset.inline))
  // 桩不解析 CSS（.dshsd-picker{display:none} 在浏览器里生效），所以这里判「没有显式显示」
  check('无输入框时不显示', picker?.style.display !== 'flex' && picker?.style.display !== 'inline-flex', String(picker?.style.display))
}

{
  // 切换档位 → POST /model
  const { env } = await loadClient({ withComposer: true })
  const picker = findPicker(env.document)
  const select = picker.children.filter((child) => child.tagName === 'SELECT')[0]
  env.requests.length = 0
  select.value = '5.0-flash'
  select.dispatch('change')
  await new Promise((resolve) => setImmediate(resolve))
  const post = env.requests.find((request) => request.url.includes('/dsh-seedream/model'))
  check('切换档位会 POST /model', post !== undefined, JSON.stringify(env.requests.map((request) => request.url)))
  check('请求体是 {tier:"5.0-flash"}', post?.body === JSON.stringify({ tier: '5.0-flash' }), String(post?.body))

  env.requests.length = 0
  select.value = '__default__'
  select.dispatch('change')
  await new Promise((resolve) => setImmediate(resolve))
  const clearPost = env.requests.find((request) => request.url.includes('/dsh-seedream/model'))
  check('选「默认」会 POST {clear:true}', clearPost?.body === JSON.stringify({ clear: true }), String(clearPost?.body))
}

{
  // 配置关闭时不显示
  const { env } = await loadClient({ withComposer: true, modelPicker: false })
  const picker = findPicker(env.document)
  check('uiModelPicker=false 时隐藏', picker?.style.display === 'none', String(picker?.style.display))
}

{
  // 权限行兜底：只有 .modes 时也能内联进去
  const { env } = await loadClient({ withComposer: true })
  const document = env.document
  const standard = document.querySelectorAll('[class*="standardControls"]')[0]
  standard.hidden = true
  standard.rect = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }
  const picker = findPicker(document)
  picker.parentElement.removeChild(picker)
  picker.dataset.inline = '0'
  // 触发一次重新放置（等同滚动/变更后的重试）
  env.window.listeners.scroll?.[0]?.()
  for (const timer of env.timers.splice(0)) timer()
  const modes = document.querySelectorAll('[class*="modes"]')[0]
  check('模型行不可见时改嵌权限行', picker.parentElement === modes, picker.parentElement?.className)
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
