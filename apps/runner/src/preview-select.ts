// Picking elements in a preview, as Claude does: the proxy adds a script to each
// page it serves, and the dashboard's preview panel turns its select mode on and
// off. While it is on, what the pointer is over is outlined; a click sends that
// element (where it is, its React components, its HTML) to the panel instead of
// reaching the page, and the panel puts it in the composer (contracts'
// preview-elements.ts). Esc in the page turns it off. Then the page draws the
// element (modern-screenshot, loaded only then from the proxy) and sends that
// picture too, for the message to carry as an image. It also tells the panel which
// path the page is at, and opens the one a person types in the panel's bar.
//
// The script is served from the preview's own address (a page's Content-Security-Policy
// allows 'self' more often than inline scripts), runs before the page's own scripts
// and removes its tag at once, so a React page hydrates against the HTML it rendered.
// Outside the dashboard's frame (a tab of its own) it does nothing.
import { readFileSync } from 'node:fs'
import { Transform } from 'node:stream'
import { fileURLToPath } from 'node:url'

/** Where the proxy serves the script, on every preview's address. */
export const SELECT_SCRIPT_PATH = '/__brigade/select.js'
/** And the library that draws an element, loaded once something is picked. */
export const SCREENSHOT_SCRIPT_PATH = '/__brigade/screenshot.mjs'

let screenshot: string | undefined
/** modern-screenshot's browser module: one file, no imports. */
export function screenshotScript() {
  screenshot ??= readFileSync(fileURLToPath(import.meta.resolve('modern-screenshot')), 'utf8')
  return screenshot
}

const TAG = `<script src="${SELECT_SCRIPT_PATH}"></script>`

/** How much of a page is read for its <head> before giving up and passing it through. */
const SEARCH_LIMIT = 64 * 1024

/**
 * Where the tag goes in a page's start: after <head>; once no <head> is coming (`last`),
 * after <html>, else before <body>. -1 when there is no place for it (yet).
 */
export function tagIndex(html: string, last: boolean) {
  for (const re of last ? [/<head(\s[^>]*)?>/i, /<html(\s[^>]*)?>/i] : [/<head(\s[^>]*)?>/i]) {
    const m = re.exec(html)
    if (m) return m.index + m[0].length
  }
  return last ? html.search(/<body[\s>]/i) : -1
}

/**
 * The page with the script's tag added, streamed: its start is held only until the
 * tag's place is found (a dev server streams the rest as it renders).
 */
export function withSelectScript() {
  let held = ''
  let done = false
  const release = (last: boolean) => {
    const at = tagIndex(held, last)
    if (at < 0 && !last) return undefined
    done = true
    const out = at < 0 ? held : held.slice(0, at) + TAG + held.slice(at)
    held = ''
    return Buffer.from(out, 'latin1')
  }
  return new Transform({
    transform(chunk: Buffer, _encoding, next) {
      if (done) return next(null, chunk)
      held += chunk.toString('latin1')
      next(null, release(held.length >= SEARCH_LIMIT))
    },
    flush(next) {
      next(null, done || !held ? null : release(true))
    },
  })
}

/** The script, as the browser runs it. Plain ES2017 in the page: no imports, no globals besides its flag. */
export const SELECT_SCRIPT = String.raw`(() => {
  const tag = document.currentScript
  if (tag) tag.remove()
  if (window.parent === window || window.__brigadeSelect) return
  window.__brigadeSelect = true

  const ACCENT = '#7c5cff'
  // Next.js's own components, which say nothing about where an element is in the app.
  const INTERNAL = /^(Inner|Outer)?(LayoutRouter|ScrollAndFocusHandler|RenderFromTemplateContext|Redirect|NotFound|HTTPAccessFallback|ErrorBoundary|LoadingBoundary|Segment|Metadata|Viewport|Outlet|AppRouter|Router|HotReload|ServerRoot|Root$|DevRoot|AppDev|ReplaySsr|RootError|ClientPageRoot|ClientSegmentRoot|Head$|ServerInsertedHTML|PathnameContext|__next)/
  let on = false
  let origin = null
  let host = null
  let box = null
  let label = null
  let current = null
  // The crosshair over the whole page, without touching its DOM (which React hydrates).
  let cursor = null

  const post = (message, to) => window.parent.postMessage(Object.assign({ source: 'brigade-preview' }, message), to)

  function overlay() {
    if (host) return
    host = document.createElement('brigade-select')
    const root = host.attachShadow({ mode: 'closed' })
    root.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '.box{position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;border:2px solid ' + ACCENT + ';background:' + ACCENT + '1f;border-radius:3px;display:none;transition:background .15s}' +
      '.box.picked{background:' + ACCENT + '66}' +
      '.label{position:fixed;z-index:2147483647;pointer-events:none;display:none;max-width:min(420px,calc(100vw - 16px));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
      'background:#18142a;color:#fff;font:500 12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:3px 7px;border-radius:5px;box-shadow:0 2px 8px #0004}' +
      '.label span{color:#b9a8ff;margin-left:8px;font-weight:400}' +
      '</style><div class="box"></div><div class="label"></div>'
    box = root.querySelector('.box')
    label = root.querySelector('.label')
    document.documentElement.appendChild(host)
  }

  // A component's props worth showing: plain values, not children or callbacks.
  function plain(props) {
    const out = {}
    let n = 0
    for (const key of Object.keys(props || {})) {
      const value = props[key]
      if (key === 'children' || key === 'key' || n >= 12) continue
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue
      out[key.slice(0, 100)] = String(value).slice(0, 200)
      n++
    }
    return out
  }

  function components(el) {
    let node = el
    let fiber = null
    while (node && !fiber) {
      const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$'))
      fiber = key ? node[key] : null
      node = node.parentNode
    }
    const names = []
    let props = null
    for (; fiber && names.length < 40; fiber = fiber.return) {
      const type = fiber.type
      if (!type || typeof type === 'string') continue
      const inner = type.render || type.type || type
      const name = type.displayName || (inner && (inner.displayName || inner.name))
      if (!name || typeof name !== 'string' || name.length < 3 || INTERNAL.test(name)) continue
      if (!props) props = plain(fiber.memoizedProps)
      if (names[names.length - 1] !== name) names.push(name)
    }
    return { names: names.slice(0, 5).reverse(), props: props || {} }
  }

  function short(el) {
    const tag = el.tagName.toLowerCase()
    if (el.id) return tag + '#' + el.id
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : ''
    return cls ? tag + '.' + cls : tag
  }

  // The shortest path up from it that finds it alone, so two alike elements never share one.
  const unique = (parts) => {
    try {
      return document.querySelectorAll(parts.join(' > ')).length === 1
    } catch (error) {
      return false
    }
  }
  function selector(el) {
    const parts = []
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const tag = node.tagName.toLowerCase()
      if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
        parts.unshift('#' + CSS.escape(node.id))
        break
      }
      if (tag === 'html' || tag === 'body') {
        parts.unshift(tag)
        break
      }
      let part = tag
      const classes = typeof node.className === 'string' ? node.className.trim().split(/\s+/).filter(Boolean) : []
      for (const c of classes.slice(0, 2)) part += '.' + CSS.escape(c)
      const parent = node.parentElement
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName)
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')'
      }
      parts.unshift(part)
      if (unique(parts)) break
    }
    return parts.join(' > ')
  }

  function html(el) {
    const outer = el.outerHTML
    return outer.length > 3000 ? outer.slice(0, 3000) + '…' : outer
  }

  function describe(el) {
    const rect = el.getBoundingClientRect()
    const found = components(el)
    const names = found.names
    const name = short(el)
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
    const near = names[names.length - 1]
    return {
      label: (near ? near + ' › ' + name : name).slice(0, 200),
      page: (location.pathname + location.search + location.hash).slice(0, 2000),
      selector: selector(el).slice(0, 1000),
      components: names.map((n) => n.slice(0, 100)),
      props: found.props,
      size: Math.round(rect.width) + '×' + Math.round(rect.height),
      text: text.length > 300 ? text.slice(0, 300) + '…' : text,
      html: html(el),
    }
  }

  function draw() {
    if (!on || !current || !current.isConnected) {
      if (box) box.style.display = label.style.display = 'none'
      return
    }
    // Added on first use, once the page is up rather than while it loads.
    overlay()
    const r = current.getBoundingClientRect()
    Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' })
    label.textContent = short(current)
    const size = document.createElement('span')
    size.textContent = Math.round(r.width) + '×' + Math.round(r.height)
    label.appendChild(size)
    label.style.display = 'block'
    const below = r.bottom + 30 < innerHeight
    label.style.top = Math.max(4, below ? r.bottom + 6 : r.top - 30) + 'px'
    label.style.left = Math.max(4, Math.min(r.left, innerWidth - label.offsetWidth - 4)) + 'px'
  }

  const target = (e) => {
    const el = e.target
    return el && el.nodeType === 1 && el !== host ? el : null
  }
  function move(e) {
    const el = target(e)
    if (!el || el === current) return
    current = el
    draw()
  }
  function block(e) {
    e.preventDefault()
    e.stopImmediatePropagation()
  }
  function pick(e) {
    block(e)
    const el = target(e) || current
    if (!el) return
    current = el
    draw()
    box.classList.add('picked')
    setTimeout(() => box && box.classList.remove('picked'), 300)
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    post({ type: 'selected', id, element: describe(el) }, origin)
    capture(el, id, origin)
  }

  // Its picture, up to 1600 pixels on its longest side; none when the page cannot draw it.
  function capture(el, id, to) {
    const r = el.getBoundingClientRect()
    const longest = Math.max(r.width, r.height)
    if (!longest) return post({ type: 'captured', id }, to)
    const scale = Math.min(window.devicePixelRatio || 1, 1600 / longest)
    import('${SCREENSHOT_SCRIPT_PATH}')
      .then((m) => m.domToBlob(el, { scale, type: 'image/png', timeout: 10000 }))
      .then(
        (image) => post({ type: 'captured', id, image }, to),
        () => post({ type: 'captured', id }, to),
      )
  }
  function key(e) {
    if (e.key !== 'Escape') return
    block(e)
    set(false)
    post({ type: 'stopped' }, origin)
  }
  function leave(e) {
    if (e.relatedTarget) return
    current = null
    draw()
  }

  // Not touchstart or touchend: cancelling them cancels the click a tap picks with.
  const BLOCKED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu', 'auxclick', 'submit']
  function set(value) {
    if (value === on) return
    on = value
    const listen = on ? addEventListener : removeEventListener
    listen('pointermove', move, true)
    listen('click', pick, true)
    for (const type of BLOCKED) listen(type, block, { capture: true, passive: false })
    listen('keydown', key, true)
    listen('scroll', draw, true)
    listen('resize', draw, true)
    document[on ? 'addEventListener' : 'removeEventListener']('mouseout', leave, true)
    if (!on) current = null
    try {
      if (!cursor) {
        cursor = new CSSStyleSheet()
        cursor.replaceSync('*{cursor:crosshair!important}')
      }
      const sheets = document.adoptedStyleSheets.filter((s) => s !== cursor)
      document.adoptedStyleSheets = on ? sheets.concat(cursor) : sheets
    } catch (error) {
      // An older browser: the default cursor.
    }
    draw()
  }

  // Where the page is, for the panel's address bar: once the panel answered, and on each
  // navigation inside the page (a client-side router's pushState, Back, a #hash).
  let shown = null
  function report() {
    const page = (location.pathname + location.search + location.hash).slice(0, 2000)
    if (!origin || page === shown) return
    shown = page
    post({ type: 'location', page }, origin)
  }
  for (const name of ['pushState', 'replaceState']) {
    const original = history[name]
    history[name] = function () {
      const result = original.apply(this, arguments)
      report()
      return result
    }
  }
  addEventListener('popstate', report)
  addEventListener('hashchange', report)

  addEventListener('message', (e) => {
    const data = e.data
    if (e.source !== window.parent || !data || data.source !== 'brigade') return
    if (data.type === 'select') {
      origin = e.origin
      set(!!data.on)
      report()
    } else if (data.type === 'hello') {
      origin = e.origin
      shown = null
      report()
    } else if (data.type === 'navigate' && typeof data.page === 'string' && data.page[0] === '/' && data.page[1] !== '/') {
      // A path the person typed in the panel's bar, on this page's own address.
      location.assign(data.page)
    }
  })
  // Here, for the panel to show its button and turn select mode back on after a navigation.
  post({ type: 'ready' }, '*')
})()
`
