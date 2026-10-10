/**
 * dsh-seedream 客户端挂件（浏览器侧，原生 JS，无需构建）。
 *
 * 由宿主注入行加载：`/dsh-seedream/client.js`。
 * - 左下角常驻徽标：实时显示今日张数与金额（5s 轮询 + 窗口回焦时立即刷新）；
 * - 点击展开管理面板：查看用量、写入/清除 API Key（服务端 DPAPI 加密）、编辑单价、按新价重算历史。
 *
 * 约定：本文件不缓存任何状态到 localStorage；Key 只经 POST 送到宿主，从不回显。
 */
;(function () {
  'use strict'
  if (window.__DSH_SEEDREAM_UI__ === true) return
  window.__DSH_SEEDREAM_UI__ = true

  var BASE = '/dsh-seedream'
  var POLL_MS = 5000
  /**
   * 左下角徽标距底部的偏移（像素）。
   * 侧栏底部是 DSH 的账户/用户按钮，贴底会挡住它，所以默认抬起 76px；
   * 想再高一点或更低一点，只改这个数字然后硬刷新页面即可（无需重启 DSH）。
   */
  var BOTTOM_LEFT_OFFSET_PX = 76
  var data = null
  var panelOpen = false
  var message = null
  var busy = false

  // ---------------- 样式（优先用 DSH 主题 token，缺省值保证独立可用） ----------------
  var STYLE = [
    // 左下角默认抬到 BOTTOM_LEFT_OFFSET_PX 并躲到侧栏右侧（见 applyPosition）
    '.dshsd-badge{position:fixed;left:16px;bottom:' + BOTTOM_LEFT_OFFSET_PX + 'px;z-index:2147483000;display:flex;align-items:center;gap:6px;',
    'padding:6px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));',
    'background:var(--dsw-alias-bg-overlay,#ffffff);color:var(--dsw-alias-label-primary,#111827);',
    'font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:grab;box-shadow:0 4px 16px rgba(0,0,0,.14);',
    'opacity:0;transition:opacity .16s ease,transform .12s ease}',
    '.dshsd-badge[data-ready="1"]{opacity:1}',
    // 有浮层（账户上拉菜单等）与本徽标相交时临时让位，绝不挡住点击
    '.dshsd-badge[data-blocked="1"]{visibility:hidden;pointer-events:none}',
    '.dshsd-badge:active{cursor:grabbing}',
    '.dshsd-badge:hover{transform:translateY(-1px)}',
    '.dshsd-badge[data-warn="1"]{border-color:var(--dsw-alias-state-warn-primary,#d97706)}',
    '.dshsd-badge b{font-weight:600}',
    '.dshsd-mask{position:fixed;inset:0;z-index:2147483001;background:rgba(15,23,42,.42);display:flex;',
    'align-items:center;justify-content:center;padding:24px}',
    '.dshsd-panel{width:100%;max-width:620px;max-height:82vh;overflow:auto;border-radius:14px;',
    'border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));background:var(--dsw-alias-bg-layer-1,#ffffff);',
    'color:var(--dsw-alias-label-primary,#111827);font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;',
    'box-shadow:0 18px 48px rgba(0,0,0,.28)}',
    '.dshsd-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;',
    'border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));position:sticky;top:0;',
    'background:var(--dsw-alias-bg-layer-1,#ffffff)}',
    '.dshsd-head h3{margin:0;font-size:14px;font-weight:600}',
    '.dshsd-body{padding:14px 18px 18px}',
    '.dshsd-sec{margin-bottom:18px}',
    '.dshsd-sec>h4{margin:0 0 8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280);',
    'text-transform:uppercase;letter-spacing:.04em}',
    '.dshsd-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
    '.dshsd-grid{display:grid;grid-template-columns:auto 1fr;gap:4px 12px}',
    '.dshsd-kv{color:var(--dsw-alias-label-secondary,#6b7280)}',
    '.dshsd-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;word-break:break-all}',
    'table.dshsd-t{width:100%;border-collapse:collapse;font-size:12px}',
    'table.dshsd-t th,table.dshsd-t td{padding:5px 8px;text-align:left;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}',
    'table.dshsd-t th{color:var(--dsw-alias-label-secondary,#6b7280);font-weight:500}',
    'input.dshsd-i{flex:1;min-width:120px;padding:6px 9px;border-radius:8px;font:12px/1.4 inherit;',
    'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:var(--dsw-alias-bg-base,#fff);',
    'color:var(--dsw-alias-label-primary,#111827)}',
    'input.dshsd-num{width:84px;flex:none}',
    'button.dshsd-b{padding:6px 12px;border-radius:8px;cursor:pointer;font:12px/1.4 inherit;',
    'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:var(--dsw-alias-bg-layer-2,#f9fafb);',
    'color:var(--dsw-alias-label-primary,#111827)}',
    'button.dshsd-b:hover{filter:brightness(.97)}',
    'button.dshsd-b:disabled{opacity:.5;cursor:default}',
    'button.dshsd-primary{background:var(--dsw-alias-brand-primary,#2563eb);border-color:transparent;color:#fff}',
    'button.dshsd-danger{color:var(--dsw-alias-state-error-primary,#dc2626)}',
    '.dshsd-msg{margin:8px 0 0;padding:7px 10px;border-radius:8px;font-size:12px;white-space:pre-wrap;',
    'background:var(--dsw-alias-bg-layer-2,#f3f4f6);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))}',
    '.dshsd-box{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));border-radius:10px;',
    'padding:10px 12px;background:var(--dsw-alias-bg-layer-2,#f9fafb)}',
    '.dshsd-rows{display:grid;grid-template-columns:88px 1fr;gap:3px 10px;align-items:baseline;margin-top:4px}',
    '.dshsd-sub{margin:12px 0 4px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280)}',
    '.dshsd-srcrow{justify-content:flex-start;padding:3px 0}',
    '.dshsd-tiny{padding:3px 9px;font-size:11px}',
    '.dshsd-msg[data-kind="ok"]{border-color:var(--dsw-alias-state-success-primary,#16a34a)}',
    '.dshsd-msg[data-kind="err"]{border-color:var(--dsw-alias-state-error-primary,#dc2626)}',
    '.dshsd-hint{color:var(--dsw-alias-label-secondary,#6b7280);font-size:11px;margin-top:6px}',
    '.dshsd-close{border:none;background:none;font-size:18px;line-height:1;cursor:pointer;color:var(--dsw-alias-label-secondary,#6b7280)}',
    // 对话窗口的模型选择器：优先内联进输入框控制行；data-inline=0 时退化为浮层
    '.dshsd-picker{display:none;align-items:center;gap:3px;padding:0;',
    'color:var(--dsw-alias-label-secondary,#6b7280);font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}',
    '.dshsd-picker[data-inline="0"]{position:fixed;z-index:2147482999;gap:6px;padding:4px 10px;border-radius:999px;',
    'border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));background:var(--dsw-alias-bg-overlay,#ffffff);',
    'color:var(--dsw-alias-label-primary,#111827);box-shadow:0 2px 10px rgba(0,0,0,.10)}',
    // 让本插件所在的控制行更紧凑：不再改动 DSH 的 gap（那会改变输入框原有布局），
    // 只把自己这一块收窄 —— 见 renderPicker 里按当前档位名计算 select 宽度。
    '.dshsd-picker-label{white-space:nowrap;opacity:.85}',
    '.dshsd-picker-select{border:none;background:transparent;color:inherit;font:inherit;cursor:pointer;',
    'outline:none;padding:1px 0;border-radius:6px;box-sizing:border-box}',
    '.dshsd-picker-measure{position:absolute;visibility:hidden;white-space:pre;pointer-events:none}',
    '.dshsd-picker-select:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}',
    '.dshsd-picker-hint{color:var(--dsw-alias-state-business-primary,#2563eb);font-size:11px;white-space:nowrap}',
    '@media (prefers-color-scheme:dark){.dshsd-mask{background:rgba(0,0,0,.55)}}',
  ].join('')

  function h(tag, attrs, children) {
    var el = document.createElement(tag)
    if (attrs) {
      for (var key in attrs) {
        if (key === 'text') el.textContent = attrs[key]
        else if (key === 'html') el.innerHTML = attrs[key]
        else if (key === 'onclick') el.onclick = attrs[key]
        else if (attrs[key] !== null && attrs[key] !== undefined) el.setAttribute(key, attrs[key])
      }
    }
    if (children) for (var i = 0; i < children.length; i++) if (children[i]) el.appendChild(children[i])
    return el
  }

  // ---------------- 与宿主通信 ----------------
  function request(path, options) {
    return fetch(BASE + path, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options || {})).then(function (response) {
      return response.json().catch(function () {
        return { ok: false, code: 'BAD_RESPONSE', message: 'HTTP ' + response.status }
      }).then(function (payload) {
        if (!response.ok || payload.ok === false) {
          var err = new Error(payload.message || 'HTTP ' + response.status)
          err.code = payload.code
          throw err
        }
        return payload
      })
    })
  }

  /**
   * 数据指纹：只有它变了才重绘 DOM。
   * 早期实现每 5 秒无脑重建一次节点，会把页面/面板的滚动位置顶回顶部，也会打断正在输入的表单。
   */
  function signatureOf(payload) {
    if (!payload || payload.ok === false) return 'error:' + ((payload && payload.error) || '')
    var key = payload.key || {}
    var prices = payload.prices || {}
    var usage = payload.usage || {}
    var today = usage.today || {}
    var all = usage.all || {}
    var recent = payload.recent || []
    var sources = key.sources || {}
    return [
      key.configured, key.source, key.hint ? key.hint.hash : '', key.updatedAt,
      [sources.vault === true, sources.credentials === true, sources.environment === true].join(''),
      key.canClearCredentials === true,
      today.images, today.costText, all.images, all.costText,
      prices.note || '',
      (prices.entries || []).map(function (entry) { return entry.price + '/' + entry.high }).join(','),
      recent.length, recent.length > 0 ? recent[0].ts : '',
      (payload.ui || {}).badgePosition || '',
      (payload.tiers || []).length,
    ].join('|')
  }

  var lastSignature = null

  function refresh() {
    return request('/state')
      .then(function (payload) {
        var signature = signatureOf(payload)
        data = payload
        if (signature === lastSignature) return
        lastSignature = signature
        renderAll(false)
      })
      .catch(function (error) {
        var failure = { ok: false, error: String(error && error.message) }
        var signature = signatureOf(failure)
        data = failure
        if (signature === lastSignature) return
        lastSignature = signature
        renderAll(false)
      })
  }

  function mutate(path, body, okText) {
    if (busy) return
    busy = true
    message = { kind: 'ok', text: '处理中…' }
    renderAll(true)
    request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (payload) {
        busy = false
        message = { kind: 'ok', text: typeof okText === 'function' ? okText(payload) : okText }
        lastSignature = null // 强制下一次 refresh 重绘，好把结果消息显示出来
        return refresh()
      })
      .catch(function (error) {
        busy = false
        message = { kind: 'err', text: (error.code ? '[' + error.code + '] ' : '') + String(error && error.message) }
        renderAll(true)
      })
  }

  // ---------------- 对话窗口的模型选择器 ----------------

  var picker = null
  var pickerSelect = null
  var pickerHint = null
  var pickerMeasure = null
  var pickerVisible = false
  var pickerEnabled = true
  var repositionScheduled = false

  /**
   * 原生 `<select>` 的宽度由**最长选项**决定，所以即使当前选的是短档位名，
   * 箭头也会被推到很右边。这里按「当前显示的文本」实测宽度，把 select 收到刚好放下它，
   * 箭头就会紧贴文字。无浏览器环境（测试桩）量不到宽度时退回按字数估算。
   */
  function measurePickerText(text) {
    if (pickerMeasure === null) {
      pickerMeasure = h('span', { class: 'dshsd-picker-measure', 'aria-hidden': 'true' })
      picker.appendChild(pickerMeasure)
    }
    setText(pickerMeasure, text)
    var width = pickerMeasure.offsetWidth || 0
    if (width > 0) return width
    var estimate = 0
    for (var index = 0; index < text.length; index++) {
      estimate += text.charCodeAt(index) > 0x2e80 ? 12 : 6.6
    }
    return estimate
  }

  /**
   * 找"对话输入框"：下半屏里面积最大的可见 textarea / contenteditable。
   * 不依赖任何 DSH 内部类名，换版也不会失联；找不到就整块隐藏。
   */
  function findComposer() {
    var nodes
    try {
      nodes = document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]')
    } catch (error) {
      return null
    }
    var best = null
    var bestArea = 0
    var bestRect = null
    for (var index = 0; index < nodes.length; index++) {
      var node = nodes[index]
      if (picker && (node === picker || picker.contains(node))) continue
      if (badge && badge.contains(node)) continue
      var rect
      try {
        rect = node.getBoundingClientRect()
      } catch (error) {
        continue
      }
      if (rect.width < 120 || rect.height < 16) continue
      // 只看视口下半屏：聊天输入框一定在下面，上半屏的搜索框等排除掉
      if (rect.top < window.innerHeight * 0.45) continue
      if (rect.bottom > window.innerHeight + 8) continue
      var style = window.getComputedStyle(node)
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue
      var area = rect.width * rect.height
      if (area > bestArea) {
        bestArea = area
        best = node
        bestRect = rect
      }
    }
    return best === null ? null : { node: best, rect: bestRect }
  }

  /**
   * 找输入框里的“控制行”，把选择器**嵌进去**（而不是浮在上方）：
   *   1. `[class*="standardControls"]` —— 模型选择所在的那一组（首选，语义最贴）
   *   2. `[class*="modes"]` —— 权限 / 计划所在的那一行（次选）
   *   3. `[class*="dock"]` —— 输入卡片底部的控制行（兜底）
   * 类名前缀是 CSS Module 的哈希（随构建变化），所以按**后缀**匹配；
   * 全找不到时返回 null，调用方回退到「浮在输入框上方」。
   */
  function findComposerToolbar() {
    var card = document.querySelector('[data-composer-card]')
    var scopes = card === null ? [document] : [card, document]
    var selectors = ['[class*="standardControls"]', '[class*="modes"]', '[class*="dock"]']
    for (var s = 0; s < selectors.length; s++) {
      for (var i = 0; i < scopes.length; i++) {
        var node = null
        try {
          node = scopes[i].querySelector(selectors[s])
        } catch (error) {
          continue
        }
        if (node === null || node === picker || (picker && picker.contains(node))) continue
        // 只看真正可见的行（活动态时 standardControls 会被 hidden）
        if (node.hidden || node.getClientRects().length === 0) continue
        return node
      }
    }
    return null
  }

  /** 尝试内联嵌入输入框控制行；返回是否成功（失败则由调用方回退到浮层）。 */
  function attachPickerInline() {
    if (!picker) return false
    var target = findComposerToolbar()
    if (target === null) {
      if (picker.dataset.inline === '1') {
        picker.dataset.inline = '0'
        picker.style.display = 'none'
      }
      return false
    }
    if (picker.dataset.inline === '1' && picker.parentElement === target && target.firstChild === picker) return true
    picker.dataset.inline = '1'
    picker.style.left = ''
    picker.style.top = ''
    picker.style.bottom = ''
    picker.style.right = ''
    try {
      // 插到该行**最前面**：位于「模型选择」左侧（同一排，不追加到末尾）
      target.insertBefore(picker, target.firstChild === undefined ? null : target.firstChild)
    } catch (error) {
      picker.dataset.inline = '0'
      return false
    }
    if (picker.style.display !== 'inline-flex') picker.style.display = 'inline-flex'
    pickerVisible = true
    return true
  }

  function ensurePicker() {
    if (picker) return
    picker = h('div', { class: 'dshsd-picker' })
    pickerSelect = h('select', {
      class: 'dshsd-picker-select',
      title: '选择 Seedream 出图档位：对话里未显式指定档位时就用它',
    })
    pickerSelect.addEventListener('change', function () {
      var value = pickerSelect.value
      if (value === '__default__') mutate('/model', { clear: true }, '已恢复为配置默认档位')
      else mutate('/model', { tier: value }, '出图档位已切到 ' + value)
    })
    pickerHint = h('span', { class: 'dshsd-picker-hint' })
    picker.appendChild(h('span', { class: 'dshsd-picker-label', text: '🎨' }))
    picker.appendChild(pickerSelect)
    picker.appendChild(pickerHint)
    // 卡片本身可能是「点击进入工作区」的触发器：别让交互冒泡出去
    var stop = function (event) { event.stopPropagation() }
    picker.addEventListener('pointerdown', stop)
    picker.addEventListener('mousedown', stop)
    picker.addEventListener('click', stop)
    ;(document.body || document.documentElement).appendChild(picker)
  }

  /** 档位选项：档位名 + 单价（价表已配置时显示）。 */
  function pickerOptions() {
    var defaultTier = (data && data.defaultModel) || '5.0-pro'
    var priceByTier = {}
    var entries = (data && data.prices && data.prices.entries) || []
    for (var index = 0; index < entries.length; index++) {
      if (entries[index].price !== null && entries[index].price !== undefined) priceByTier[entries[index].tier] = entries[index].price
    }
    var options = [{ value: '__default__', label: '默认' + defaultTier }]
    var tiers = (data && data.tiers) || []
    for (var tierIndex = 0; tierIndex < tiers.length; tierIndex++) {
      var tier = tiers[tierIndex]
      var price = priceByTier[tier.tier]
      options.push({ value: tier.tier, label: tier.tier + (price === undefined ? '' : ' ¥' + price) })
    }
    return options
  }

  function renderPicker() {
    if (!picker) return
    var enabled = data && data.ok !== false && data.ui ? data.ui.modelPicker !== false : true
    pickerEnabled = enabled
    if (!enabled) {
      picker.style.display = 'none'
      pickerVisible = false
      return
    }
    var options = pickerOptions()
    var selected = (data && data.modelChoice && data.modelChoice.selectedTier) || '__default__'
    // 只在选项内容或选中值变化时重建，避免轮询期间无谓的 DOM 变更
    var signature = options.map(function (option) { return option.value + '=' + option.label }).join('|') + '#' + selected
    if (signature !== picker.dataset.signature) {
      picker.dataset.signature = signature
      pickerSelect.textContent = ''
      for (var index = 0; index < options.length; index++) {
        var option = document.createElement('option')
        option.value = options[index].value
        option.textContent = options[index].label
        if (options[index].label.indexOf('¥') >= 0) option.textContent = options[index].label + '/张'
        pickerSelect.appendChild(option)
      }
      pickerSelect.value = selected
      if (pickerSelect.value !== selected) pickerSelect.value = '__default__'
    }
    // 把 select 收到「刚好放下当前档位名 + 原生箭头」，箭头才不会被最长选项推远
    var currentOption = null
    for (var optionIndex = 0; optionIndex < options.length; optionIndex++) {
      if (options[optionIndex].value === pickerSelect.value) currentOption = options[optionIndex]
    }
    var currentText = currentOption === null
      ? ''
      : currentOption.label + (currentOption.label.indexOf('¥') >= 0 ? '/张' : '')
    var width = Math.ceil(measurePickerText(currentText) + 22) + 'px'
    if (pickerSelect.style.width !== width) pickerSelect.style.width = width
    var choice = (data && data.modelChoice) || null
    setText(pickerHint, choice && choice.source === 'ui' ? '已选定' : '')
    setTitle(
      picker,
      choice
        ? 'Seedream 出图档位：当前生效 ' + choice.tier + '（' + choice.sourceLabel + '）\n改动立即生效，无需重启'
        : 'Seedream 出图档位',
    )
    placePicker()
  }

  /** 先尝试嵌进输入框控制行；只有当嵌入失败时才回退为浮层。 */
  function placePicker() {
    if (!picker || pickerEnabled !== true) return
    if (attachPickerInline()) return
    positionPicker()
  }

  /** 回退方案：把选择器浮在输入框正上方。 */
  function positionPicker() {
    if (!picker || pickerEnabled !== true) return
    if (picker.dataset.inline === '1') return
    picker.dataset.inline = '0'
    var found = findComposer()
    if (found === null) {
      if (pickerVisible) {
        picker.style.display = 'none'
        pickerVisible = false
      }
      return
    }
    if (picker.style.display !== 'flex') picker.style.display = 'flex'
    pickerVisible = true
    var rect = found.rect
    var width = picker.offsetWidth || 220
    var left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left))
    picker.style.left = Math.round(left) + 'px'
    picker.style.bottom = Math.round(window.innerHeight - rect.top + 6) + 'px'
    picker.style.top = 'auto'
    picker.style.right = 'auto'
  }

  function schedulePosition() {
    if (repositionScheduled) return
    repositionScheduled = true
    window.setTimeout(function () {
      repositionScheduled = false
      placePicker()
    }, 150)
  }

  // ---------------- 视图 ----------------
  var badge
  var badgeIcon
  var badgeMain
  var badgeTotal
  var mask
  var panelHost

  /**
   * 角落位置。左下角**刻意不贴侧栏**：先探测侧栏右边缘，把徽标放到侧栏右侧，
   * 这样侧栏里的账户按钮和它向上弹出的菜单都不可能被盖住。
   */
  var POSITIONS = {
    'bottom-left': { bottom: BOTTOM_LEFT_OFFSET_PX + 'px', top: 'auto', right: 'auto' },
    'bottom-right': { right: '16px', bottom: '16px', left: 'auto', top: 'auto' },
    'top-left': { left: '16px', top: '16px', right: 'auto', bottom: 'auto' },
    'top-right': { right: '16px', top: '16px', left: 'auto', bottom: 'auto' },
  }

  /** 拖动后的手动位置（localStorage 持久化，双击徽标复位）。 */
  var MANUAL_KEY = 'dsh-seedream:badge-position'
  var manualPosition = loadManualPosition()

  function loadManualPosition() {
    try {
      var raw = window.localStorage.getItem(MANUAL_KEY)
      if (!raw) return null
      var parsed = JSON.parse(raw)
      if (parsed && typeof parsed.left === 'number' && typeof parsed.top === 'number') return parsed
      return null
    } catch (error) {
      return null
    }
  }

  function saveManualPosition(position) {
    try {
      window.localStorage.setItem(MANUAL_KEY, JSON.stringify(position))
    } catch (error) {
      /* 存不了就只在本次会话内生效 */
    }
  }

  function clearManualPosition() {
    try {
      window.localStorage.removeItem(MANUAL_KEY)
    } catch (error) {
      /* 忽略 */
    }
  }

  /**
   * 探测左侧栏的右边缘：从视口左下角往上找「高度占满大半屏、宽度较窄、贴左边」的容器。
   * 找不到就返回 0（此时退回贴左 16px）。
   */
  function sidebarRightEdge() {
    try {
      var probes = [
        [24, window.innerHeight - 36],
        [24, window.innerHeight - 90],
        [24, Math.round(window.innerHeight * 0.75)],
      ]
      for (var index = 0; index < probes.length; index++) {
        var hit = document.elementFromPoint(probes[index][0], probes[index][1])
        if (!hit || hit === badge || (badge && badge.contains(hit))) continue
        var node = hit
        for (var depth = 0; node && node !== document.body && depth < 12; depth++) {
          var rect = node.getBoundingClientRect()
          if (
            rect.height > window.innerHeight * 0.5 &&
            rect.width > 80 &&
            rect.width < window.innerWidth * 0.6 &&
            rect.left < 40
          ) {
            return Math.round(rect.right)
          }
          node = node.parentElement
        }
      }
    } catch (error) {
      /* 探测失败就退回默认位置 */
    }
    return 0
  }

  function applyManualPosition() {
    if (manualPosition === null || !badge) return false
    var maxLeft = Math.max(4, window.innerWidth - badge.offsetWidth - 4)
    var maxTop = Math.max(4, window.innerHeight - badge.offsetHeight - 4)
    badge.style.left = Math.max(4, Math.min(maxLeft, manualPosition.left)) + 'px'
    badge.style.top = Math.max(4, Math.min(maxTop, manualPosition.top)) + 'px'
    badge.style.right = 'auto'
    badge.style.bottom = 'auto'
    return true
  }

  /** 把徽标放到指定角落；左下角额外躲开整个侧栏列（账户按钮与上拉菜单都在侧栏里）。 */
  function cornerStyle(wanted) {
    var style = POSITIONS[wanted] || POSITIONS['bottom-left']
    badge.style.left = 'auto'
    for (var key in style) badge.style[key] = style[key]
    if (wanted === 'bottom-left') {
      var edge = sidebarRightEdge()
      badge.style.left = (edge > 0 ? edge + 20 : 16) + 'px'
    }
  }

  function applyPosition(force) {
    if (!badge) return
    if (applyManualPosition()) {
      setAttr(badge, 'data-ready', '1')
      return
    }
    // 拿不到状态时也要显示（否则出错就完全看不见了），用默认角落呈现错误文案
    var failed = !data || data.ok === false
    var wanted = failed ? 'bottom-left' : (data.ui && data.ui.badgePosition) || 'bottom-left'
    var signature = wanted + '@' + window.innerWidth + 'x' + window.innerHeight + (failed ? '@err' : '@ok')
    if (force !== true && signature === appliedPosition) return
    appliedPosition = signature
    cornerStyle(wanted)
    setAttr(badge, 'data-ready', '1')
  }

  var appliedPosition = null

  /** 拖动定位：按住徽标拖动即可换位置，双击复位到自动位置。 */
  function enableDrag() {
    var drag = null
    var suppressClick = false
    badge.addEventListener('pointerdown', function (event) {
      if (event.button !== 0) return
      var rect = badge.getBoundingClientRect()
      drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false }
      try {
        badge.setPointerCapture(event.pointerId)
      } catch (error) {
        /* 不支持指针捕获也能拖 */
      }
    })
    badge.addEventListener('pointermove', function (event) {
      if (!drag) return
      var dx = event.clientX - drag.x
      var dy = event.clientY - drag.y
      if (drag.moved !== true && Math.abs(dx) + Math.abs(dy) < 6) return
      drag.moved = true
      manualPosition = { left: Math.round(drag.left + dx), top: Math.round(drag.top + dy) }
      applyManualPosition()
    })
    badge.addEventListener('pointerup', function () {
      if (!drag) return
      var moved = drag.moved
      drag = null
      if (moved) {
        saveManualPosition(manualPosition)
        suppressClick = true
        window.setTimeout(function () { suppressClick = false }, 250)
      }
    })
    badge.addEventListener('click', function (event) {
      if (suppressClick) {
        event.stopPropagation()
        event.preventDefault()
      }
    }, true)
    badge.addEventListener('dblclick', function (event) {
      event.preventDefault()
      manualPosition = null
      clearManualPosition()
      appliedPosition = null
      applyPosition(true)
    })
  }

  /**
   * 浮层避让：DSH 的弹出菜单/气泡是后加入 DOM 的浮层。只要新加入的浮层与徽标相交，
   * 就把徽标临时藏起来（不挡点击），浮层消失后自动恢复。
   * 用 MutationObserver 只看新增节点，代价可控，且不依赖任何 DSH 内部类名。
   */
  var overlayBlockers = new Set()

  function overlayIntersectsBadge(node) {
    if (!badge || !node || node.nodeType !== 1) return false
    if (node === badge || badge.contains(node)) return false
    var rect
    try {
      rect = node.getBoundingClientRect()
    } catch (error) {
      return false
    }
    if (!rect || rect.width < 8 || rect.height < 8) return false
    var badgeRect = badge.getBoundingClientRect()
    if (badgeRect.width === 0) return false
    var overlaps =
      rect.left < badgeRect.right && rect.right > badgeRect.left &&
      rect.top < badgeRect.bottom && rect.bottom > badgeRect.top
    if (!overlaps) return false
    try {
      var position = window.getComputedStyle(node).position
      if (position !== 'fixed' && position !== 'absolute') return false
    } catch (error) {
      return false
    }
    return true
  }

  function refreshBadgeVisibility() {
    if (!badge) return
    var blocked = false
    overlayBlockers.forEach(function (node) {
      if (!node.isConnected) {
        overlayBlockers.delete(node)
        return
      }
      if (overlayIntersectsBadge(node)) blocked = true
    })
    setAttr(badge, 'data-blocked', blocked ? '1' : '0')
  }

  function watchOverlays() {
    var scheduled = false
    function schedule() {
      if (scheduled) return
      scheduled = true
      window.setTimeout(function () {
        scheduled = false
        refreshBadgeVisibility()
      }, 120)
    }
    try {
      var observer = new MutationObserver(function (records) {
        for (var index = 0; index < records.length; index++) {
          var added = records[index].addedNodes
          for (var inner = 0; inner < added.length; inner++) {
            var node = added[inner]
            if (node && node.nodeType === 1 && node !== mask) overlayBlockers.add(node)
          }
        }
        schedule()
        // 输入框（React 重渲染/切换会话）也可能刚被替换：顺带重贴模型选择器
        schedulePosition()
      })
      observer.observe(document.body, { childList: true, subtree: true })
    } catch (error) {
      /* 没有 MutationObserver 就只靠位置策略 */
    }
    window.addEventListener('resize', schedule)
  }

  function moneyText(usage, period) {
    var entry = usage && usage[period]
    if (!entry) return '—'
    return entry.costText
  }

  /** 只在真正变化时写文本/属性：稳定节点 + 差异更新，轮询期间基本零 DOM 变更。 */
  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text
  }

  function setAttr(node, name, value) {
    if (node && node.getAttribute(name) !== value) node.setAttribute(name, value)
  }

  function setTitle(node, text) {
    if (node && node.title !== text) node.title = text
  }

  function ensureBadge() {
    if (badge) return
    badge = h('button', { class: 'dshsd-badge', type: 'button', onclick: openPanel })
    badgeIcon = h('span')
    badgeMain = h('b')
    badgeTotal = h('span')
    badge.appendChild(badgeIcon)
    badge.appendChild(badgeMain)
    badge.appendChild(badgeTotal)
    document.body.appendChild(badge)
  }

  function renderBadge() {
    if (!badge) return
    applyPosition()
    if (!data || data.ok === false) {
      setText(badgeIcon, '🎨')
      setText(badgeMain, 'Seedream 状态不可用')
      setText(badgeTotal, '')
      setAttr(badge, 'data-warn', '1')
      setTitle(badge, (data && data.error) || '无法连接本机 /dsh-seedream/state')
      return
    }
    var today = data.usage.today
    var warn = data.key.configured !== true
    setAttr(badge, 'data-warn', warn ? '1' : '0')
    setText(badgeIcon, warn ? '⚠️' : '🎨')
    setText(badgeMain, '今天 ' + today.images + ' 张 · ' + today.costText)
    // 有官方余额就在徽标上直接显示余额，否则显示累计张数
    var available = data.balance && data.balance.official ? data.balance.official.available : null
    setText(badgeTotal, available === null || available === undefined ? '共 ' + data.usage.all.images + ' 张' : '余额 ' + available)
    setTitle(badge, 'Seedream 计费与配置' +
      (warn ? '\n尚未配置 API Key' : '') +
      (available === null || available === undefined ? '' : `\n可用余额 ${available} ${data.balance.official.currency}`) +
      '\n单击打开管理面板 · 拖动可移动位置 · 双击复位')
  }

  /** 把指纹渲染成人类可读的一行（永不显示完整明文；可按配置整体隐藏）。 */
  function hintText(hint, enabled) {
    if (enabled === false) return '已按配置隐藏（uiKeyHint: false）'
    if (!hint || typeof hint !== 'object') return '未知（重新保存一次即可显示）'
    var masked = (hint.prefix || '') + '…' + (hint.suffix || '')
    return masked + '　·　' + hint.length + ' 字符　·　指纹 ' + hint.hash
  }

  function localTime(value) {
    if (!value) return '—'
    var date = new Date(value)
    if (isNaN(date.getTime())) return String(value)
    function pad(n) { return String(n).length < 2 ? '0' + n : String(n) }
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' +
      pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
  }

  function readonlyRow(label, value, mono) {
    return h('div', { class: 'dshsd-rows' }, [
      h('span', { class: 'dshsd-kv', text: label }),
      h('span', { class: mono ? 'dshsd-mono' : '', text: value }),
    ])
  }

  function sourceRow(label, configured, note, actionLabel, onAction) {
    var children = [
      h('span', {
        text: configured ? '✅' : '—',
        style: configured ? 'color:var(--dsw-alias-state-success-primary,#16a34a)' : 'color:var(--dsw-alias-label-secondary,#6b7280)',
      }),
      h('span', { text: label, style: 'font-weight:500' }),
      h('span', { class: 'dshsd-kv', text: configured ? note : '未配置' }),
    ]
    if (onAction) {
      children.push(h('button', {
        class: 'dshsd-b dshsd-danger dshsd-tiny',
        text: actionLabel,
        disabled: configured ? null : 'disabled',
        onclick: onAction,
      }))
    }
    return h('div', { class: 'dshsd-row dshsd-srcrow' }, children)
  }

  function sectionKey() {
    var key = data.key
    // 兼容旧宿主：老版本 /state 不返回 sources，按生效来源推断，界面不至于空掉
    var sources = key.sources || {
      vault: key.source === 'vault',
      credentials: key.source === 'credentials',
      environment: key.source === 'environment',
    }

    var currentBox = h('div', { class: 'dshsd-box' }, [
      h('div', { class: 'dshsd-row' }, [
        h('span', {
          text: key.configured ? '✅ 已配置' : '⚠️ 尚未配置',
          style: 'font-weight:600;color:' + (key.configured ? 'var(--dsw-alias-state-success-primary,#16a34a)' : 'var(--dsw-alias-state-warn-primary,#d97706)'),
        }),
        h('span', { class: 'dshsd-kv', text: '生效来源：' + (key.source || '—') }),
      ]),
      readonlyRow('当前 Key', hintText(key.hint, key.hintEnabled), true),
      readonlyRow('写入时间', localTime(key.updatedAt)),
      readonlyRow('引用名', key.reference, true),
      readonlyRow('金库文件', key.vaultPath, true),
    ])

    var input = h('input', {
      class: 'dshsd-i',
      type: 'password',
      placeholder: '粘贴新的 API Key（ark-…），保存后覆盖金库中的现有 Key',
      autocomplete: 'off',
      spellcheck: 'false',
    })
    var save = h('button', {
      class: 'dshsd-b dshsd-primary',
      text: key.configured ? '替换为这个 Key' : '保存到金库',
      onclick: function () {
        var value = input.value.trim()
        if (value === '') {
          message = { kind: 'err', text: '请先粘贴 API Key' }
          renderAll(true)
          return
        }
        input.value = ''
        mutate('/key', { value: value }, function (payload) {
          return (payload.replaced ? '已替换金库中的 API Key' : '已写入金库') +
            '（Windows DPAPI 加密，磁盘上只有密文）\n新指纹：' + hintText(payload.hint, key.hintEnabled)
        })
      },
    })

    var vaultDelete = function () {
      if (!window.confirm('删除金库里的 API Key？\n删除后若没有其它来源（凭据服务 / 环境变量），生成会报 MISSING_CREDENTIAL。')) return
      mutate('/key', { clear: true, source: 'vault' }, '已删除金库文件')
    }
    var credentialsDelete = function () {
      if (!window.confirm('从 DSH 凭据库删除 ' + key.reference + '？\n（该来源是明文存储，删除更安全；若金库已有 Key，生成会继续用金库的。）')) return
      mutate('/key', { clear: true, source: 'credentials' }, '已从 DSH 凭据库删除 ' + key.reference)
    }

    return h('div', { class: 'dshsd-sec' }, [
      h('h4', { text: 'API Key 管理' }),
      currentBox,
      h('div', { class: 'dshsd-sub', text: '来源明细（可单独删除）' }),
      sourceRow('DPAPI 金库', sources.vault === true, '已配置（密文）', '删除', vaultDelete),
      sourceRow('DSH 凭据服务', sources.credentials === true, '已配置（明文）', key.canClearCredentials ? '删除' : null, key.canClearCredentials ? credentialsDelete : null),
      sourceRow('进程环境变量', sources.environment === true, '已设置', null, null),
      h('div', { class: 'dshsd-row', style: 'margin-top:10px' }, [input, save]),
      h('div', { class: 'dshsd-hint', text: '解析顺序：DPAPI 金库 → DSH 凭据服务 → 进程环境变量。' + (inputs_hint()) }),
    ])
  }

  /** 当前输入框的说明文案（按状态变化）。 */
  function inputs_hint() {
    var sources = data.key.sources || {}
    if (sources.vault === true) return '上面的输入框即「修改」：粘贴新 Key 后点替换，旧 Key 会被覆盖。'
    if (sources.credentials === true || sources.environment === true) return '当前生效来源不是金库：保存到金库后会优先使用金库的 Key。'
    return '尚无任何来源，请粘贴 API Key 保存。'
  }

  /** 可用余额：官方（费用中心）优先，本地预算兜底。 */
  function sectionBalance() {
    var balance = data.balance || { mode: 'none', official: null, budget: null, billing: { configured: false } }
    var official = balance.official
    var budget = balance.budget
    var children = [h('h4', { text: '可用余额' })]

    var hasOfficial = official && official.available !== null && official.available !== undefined
    var headline = hasOfficial
      ? official.available + ' ' + (official.currency || '')
      : budget
        ? String(budget.remaining) + ' ' + (budget.currency || '')
        : '未配置'
    var headlineNote = hasOfficial
      ? '官方可用余额（费用中心）' + (official.stale ? ' · 缓存值' : '') + (official.fetchedAt ? ' · ' + localTime(official.fetchedAt) : '')
      : budget
        ? '本地预算剩余（已充值 ' + budget.total + ' − 已花 ' + budget.spent + '）'
        : '填 AK/SK 显示官方余额，或设置本地预算'

    children.push(h('div', { class: 'dshsd-box' }, [
      h('div', { style: 'font-size:22px;font-weight:600', text: headline }),
      h('div', { class: 'dshsd-kv', text: headlineNote }),
      h('div', { class: 'dshsd-row', style: 'margin-top:8px' }, [
        h('button', {
          class: 'dshsd-b',
          text: '刷新余额',
          onclick: function () { mutate('/balance', { refresh: true }, '已刷新余额') },
        }),
        hasOfficial && budget ? h('span', { class: 'dshsd-kv', text: '本地预算剩余 ' + budget.remaining }) : null,
      ]),
    ]))

    if (official && official.fields) {
      var fieldLabels = {
        AvailableBalance: '可用余额',
        CashBalance: '现金余额',
        CreditLimit: '信控额度',
        FreezeAmount: '冻结金额',
        ArrearsBalance: '欠费金额',
      }
      var rows = h('div', { class: 'dshsd-rows' })
      Object.keys(official.fields).forEach(function (key) {
        rows.appendChild(h('span', { class: 'dshsd-kv', text: fieldLabels[key] || key }))
        rows.appendChild(h('span', { text: String(official.fields[key]) }))
      })
      children.push(h('div', { class: 'dshsd-sub', text: '官方余额明细' }))
      children.push(rows)
      children.push(h('div', { class: 'dshsd-hint', text: '来源：' + official.source }))
    }
    if (official && official.error) {
      children.push(h('div', { class: 'dshsd-msg', 'data-kind': 'err', text: '官方余额查询失败：' + official.error }))
    }

    var akInput = h('input', { class: 'dshsd-i', placeholder: 'Access Key（建议用子账号，只授予费用中心只读）', autocomplete: 'off', spellcheck: 'false' })
    var skInput = h('input', { class: 'dshsd-i', type: 'password', placeholder: 'Secret Key', autocomplete: 'off', spellcheck: 'false' })
    var billing = balance.billing || {}
    var savedHint = billing.hint
      ? '已保存：' + billing.hint.accessKey + '　·　SK ' + billing.hint.secretKeyLength + ' 字符　·　' + localTime(billing.updatedAt)
      : billing.environmentConfigured
        ? '当前使用环境变量 VOLC_ACCESSKEY / VOLC_SECRETKEY'
        : '未保存 AK/SK（未配置时只能看本地预算）'
    children.push(h('div', { class: 'dshsd-sub', text: '费用中心 AK/SK（仅用于查询余额）' }))
    children.push(h('div', { class: 'dshsd-row' }, [akInput]))
    children.push(h('div', { class: 'dshsd-row', style: 'margin-top:6px' }, [skInput]))
    children.push(h('div', { class: 'dshsd-row', style: 'margin-top:6px' }, [
      h('button', {
        class: 'dshsd-b dshsd-primary',
        text: '保存并验证',
        onclick: function () {
          var ak = akInput.value.trim()
          var sk = skInput.value.trim()
          if (ak === '' || sk === '') {
            message = { kind: 'err', text: 'Access Key 与 Secret Key 都要填' }
            renderAll(true)
            return
          }
          akInput.value = ''
          skInput.value = ''
          mutate('/billing', { accessKey: ak, secretKey: sk }, function (payload) {
            return payload.verified
              ? 'AK/SK 已保存（DPAPI 加密）并验证通过，已取到官方余额'
              : 'AK/SK 已保存，但查询失败：' + (payload.verifyError || '未知原因') + '\n（常见原因：未授予「费用中心只读」权限）'
          })
        },
      }),
      billing.configured
        ? h('button', {
            class: 'dshsd-b dshsd-danger',
            text: '删除 AK/SK',
            onclick: function () {
              if (!window.confirm('删除已保存的费用中心 AK/SK？\n删除后将回退到本地预算，不再显示官方余额。')) return
              mutate('/billing', { clear: true }, '已删除 AK/SK')
            },
          })
        : null,
    ]))
    children.push(h('div', { class: 'dshsd-hint', text: savedHint + '　存储：' + (data.billingVaultPath || '—') }))

    var totalInput = h('input', {
      class: 'dshsd-i dshsd-num',
      type: 'number',
      step: '1',
      min: '0',
      placeholder: '已充值',
      value: budget ? String(budget.total) : '',
    })
    var sinceInput = h('input', {
      class: 'dshsd-i',
      placeholder: '起始日期（可选，如 2026-10-01）',
      value: budget && budget.since ? String(budget.since).slice(0, 10) : '',
    })
    children.push(h('div', { class: 'dshsd-sub', text: '本地预算（零凭据，可作对照）' }))
    children.push(h('div', { class: 'dshsd-row' }, [
      totalInput,
      sinceInput,
      h('button', {
        class: 'dshsd-b',
        text: '保存预算',
        onclick: function () { mutate('/budget', { total: Number(totalInput.value), since: sinceInput.value }, '已保存本地预算') },
      }),
    ]))
    if (budget) {
      children.push(h('div', {
        class: 'dshsd-hint',
        text: '已花 ' + budget.spent + '　日均 ' + budget.dailyAverage +
          (budget.daysLeft === null ? '' : '　预计可用 ' + budget.daysLeft + ' 天') +
          (budget.unpricedImages > 0 ? '（有 ' + budget.unpricedImages + ' 张未计价）' : '') +
          '　文件：' + (data.budgetFile || '—'),
      }))
      if (budget.fromConfig === true) {
        children.push(h('div', { class: 'dshsd-msg', 'data-kind': 'err', text: '注意：profile 配置里写了 budgetTotal，优先级高于本界面设置；要让界面生效请删掉该配置项。' }))
      }
    }
    return h('div', { class: 'dshsd-sec' }, children)
  }

  function sectionUsage() {    var body = [h('h4', { text: '用量与费用（估算）' })]
    var table = h('table', { class: 'dshsd-t' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', { text: '周期' }), h('th', { text: '次数' }), h('th', { text: '张数' }),
        h('th', { text: 'output tokens' }), h('th', { text: '估算金额' }),
      ])]),
    ])
    var labels = { today: '今天', week: '近 7 天', month: '本月', all: '全部' }
    var tbody = h('tbody')
    ;['today', 'week', 'month', 'all'].forEach(function (period) {
      var entry = data.usage[period]
      tbody.appendChild(h('tr', {}, [
        h('td', { text: labels[period] }),
        h('td', { text: String(entry.calls) }),
        h('td', { text: String(entry.images) }),
        h('td', { text: String(entry.outputTokens) }),
        h('td', { text: entry.costText + (entry.unpricedImages > 0 ? '（' + entry.unpricedImages + ' 张未计价）' : '') }),
      ]))
    })
    table.appendChild(tbody)
    body.push(table)
    body.push(h('div', { class: 'dshsd-hint', text: data.disclaimer + '　台账：' + data.ledger }))
    return h('div', { class: 'dshsd-sec' }, body)
  }

  function sectionPrices() {
    var prices = data.prices
    var noteInput = h('input', { class: 'dshsd-i', placeholder: '价格来源备注（会显示在报告里）', value: prices.note || '' })
    var table = h('table', { class: 'dshsd-t' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', { text: '档位' }), h('th', { text: '基准价（元/张）' }), h('th', { text: '高清单价（元/张）' }), h('th', { text: '' }),
      ])]),
    ])
    var tbody = h('tbody')
    prices.entries.forEach(function (entry) {
      var base = h('input', { class: 'dshsd-i dshsd-num', type: 'number', step: '0.01', min: '0', value: entry.price === null ? '' : String(entry.price) })
      var high = h('input', { class: 'dshsd-i dshsd-num', type: 'number', step: '0.01', min: '0', value: entry.high === null ? '' : String(entry.high) })
      var save = h('button', {
        class: 'dshsd-b',
        text: '保存',
        onclick: function () {
          mutate('/price', { tier: entry.tier, price: Number(base.value), high: high.value === '' ? undefined : Number(high.value), note: noteInput.value }, '已保存 ' + entry.tier + ' 单价（新价立即对后续生成生效）')
        },
      })
      tbody.appendChild(h('tr', {}, [
        h('td', {}, [h('div', { text: entry.tier }), h('div', { class: 'dshsd-mono dshsd-kv', text: entry.modelId })]),
        h('td', {}, [base]),
        h('td', {}, [high]),
        h('td', {}, [save]),
      ]))
    })
    table.appendChild(tbody)
    var recost = h('button', {
      class: 'dshsd-b',
      text: '按当前价重算历史',
      onclick: function () {
        mutate('/recost', {}, function (payload) {
          return '已重算 ' + payload.entries + ' 条记录：' + payload.before + ' → ' + payload.after + ' 元' + (payload.unpriced > 0 ? '（仍有 ' + payload.unpriced + ' 张未计价）' : '') + (payload.backup ? '\n备份：' + payload.backup : '')
        })
      },
    })
    var clear = h('button', {
      class: 'dshsd-b dshsd-danger',
      text: '清除价表',
      onclick: function () {
        if (!window.confirm('确定清除价格文件？费用列会回到「单价未配置」。')) return
        mutate('/price', { clear: true }, '已清除价格文件')
      },
    })
    return h('div', { class: 'dshsd-sec' }, [
      h('h4', { text: '单价与重新计价' }),
      table,
      h('div', { class: 'dshsd-row', style: 'margin-top:8px' }, [noteInput]),
      h('div', { class: 'dshsd-row', style: 'margin-top:8px' }, [recost, clear]),
      h('div', { class: 'dshsd-hint', text: '方舟按返回张数计费；单张像素超过 ' + prices.highPixelThreshold + ' 时走高清单价。价格为本地价表，非官方账单。' }),
    ])
  }

  function sectionRecent() {
    if (!data.recent || data.recent.length === 0) return null
    var list = h('div', { class: 'dshsd-mono' })
    data.recent.slice(0, 10).forEach(function (item) {
      list.appendChild(h('div', { text: '· ' + item.summary }))
    })
    return h('div', { class: 'dshsd-sec' }, [h('h4', { text: '最近生成明细' }), list])
  }

  /** 面板里是否正有输入框/下拉框获得焦点：有就跳过自动重绘，别打断用户输入。 */
  function userIsTyping() {
    try {
      var active = document.activeElement
      if (!active || !panelHost || !panelHost.contains(active)) return false
      return active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT'
    } catch (error) {
      return false
    }
  }

  function renderPanel(force) {
    if (!panelHost) return
    mask.style.display = panelOpen ? 'flex' : 'none'
    if (!panelOpen) {
      if (panelHost.childNodes.length > 0) panelHost.textContent = ''
      return
    }
    if (force !== true && userIsTyping()) return // 打字期间不重绘

    var previousScroll = 0
    var previousPanel = panelHost.querySelector('.dshsd-panel')
    if (previousPanel) previousScroll = previousPanel.scrollTop
    panelHost.textContent = ''

    var body = h('div', { class: 'dshsd-body' })
    if (!data || data.ok === false) {
      body.appendChild(h('div', { class: 'dshsd-msg', 'data-kind': 'err', text: '无法读取宿主状态：' + ((data && data.error) || '未知错误') + '\n（若刚装好插件，请重启 DSH 让界面注入生效。）' }))
    } else {
      body.appendChild(sectionKey())
      body.appendChild(sectionBalance())
      body.appendChild(sectionUsage())
      body.appendChild(sectionPrices())
      var recent = sectionRecent()
      if (recent) body.appendChild(recent)
      if (message) body.appendChild(h('div', { class: 'dshsd-msg', 'data-kind': message.kind, text: message.text }))
    }
    var head = h('div', { class: 'dshsd-head' }, [
      h('h3', { text: 'Seedream 计费与 API 管理' }),
      h('div', { class: 'dshsd-row' }, [
        h('span', { class: 'dshsd-kv', text: busy ? '处理中…' : '每 5 秒检查 · 无变化不重绘' }),
        h('button', { class: 'dshsd-close', text: '✕', title: '关闭', onclick: closePanel }),
      ]),
    ])
    var panel = h('div', { class: 'dshsd-panel' }, [head, body])
    panelHost.appendChild(panel)
    if (previousScroll > 0) panel.scrollTop = previousScroll // 重绘后保住原来的滚动位置
  }

  /** 统一的重绘入口：徽标走差异更新，面板按需重建。 */
  function renderAll(forcePanel) {
    renderBadge()
    renderPicker()
    renderPanel(forcePanel)
  }

  function openPanel() {
    panelOpen = true
    message = null
    renderAll(true)
    refresh()
  }

  function closePanel() {
    panelOpen = false
    renderAll(true)
  }

  function mount() {
    if (!document.body) {
      setTimeout(mount, 200)
      return
    }
    var style = document.createElement('style')
    style.textContent = STYLE
    document.head.appendChild(style)

    ensureBadge()
    mask = h('div', { class: 'dshsd-mask', style: 'display:none' })
    mask.addEventListener('click', function (event) {
      if (event.target === mask) closePanel()
    })
    panelHost = h('div')
    mask.appendChild(panelHost)
    document.body.appendChild(mask)

    badgedelegate()
    enableDrag()
    watchOverlays()
    ensurePicker()
    refresh()
    setInterval(refresh, POLL_MS)
    window.addEventListener('focus', refresh)
    window.addEventListener('resize', function () {
      appliedPosition = null
      applyPosition(true)
      schedulePosition()
    })
    // 输入框会随布局滚动/变高：滚动与尺寸变化都要重贴选择器
    window.addEventListener('scroll', schedulePosition, true)
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && panelOpen) closePanel()
    })
  }

  /** 徽标本身是按钮：拖动用指针事件，这里只补键盘可达性兜底。 */
  function badgedelegate() {
    badge.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') openPanel()
    })
  }

  mount()
})()
