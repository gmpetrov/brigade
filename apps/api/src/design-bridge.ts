// The script the sandbox host adds to a design's pages, for the dashboard's
// canvas around them: say what is under the pointer and what an element is,
// show a person's changes before they are saved, let them retype a text in
// place, try knob values, print, and capture the page as a picture. It talks to
// the canvas only by postMessage (the design's origin is opaque) and does
// nothing in a page that is not framed. Messages it sends carry
// `source: 'brigade-design'`, its file and the sha256 its elements were
// numbered from (`data-bid`, added by the host: "<number>:<line>:<fingerprint>").
//
// Plain JavaScript in a string: it runs in the design's page, not here. It is
// the first script in the page's head, so its listeners come before the page's.
// Capturing draws the page with html-to-image, loaded on first use: it renders
// through an SVG image, where libraries that clone the page into a frame fail
// (in a sandbox every frame is its own origin). It inlines fonts and images by
// fetching them, which the design's CSP allows from itself and public CDNs.

const HTML_TO_IMAGE = 'https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.js'

/** The computed values the properties panel shows, by their CSS names. */
const COMPUTED = [
  'display',
  'position',
  'flex-direction',
  'flex-wrap',
  'justify-content',
  'align-items',
  'row-gap',
  'column-gap',
  'grid-template-columns',
  'width',
  'height',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'color',
  'background-color',
  'opacity',
  'border-top-left-radius',
  'border-top-width',
  'border-top-style',
  'border-top-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-align',
]

const SOURCE = String.raw`(function () {
  if (window.parent === window) return
  var script = document.currentScript
  var FILE = (script && script.getAttribute('data-file')) || ''
  var SHA = (script && script.getAttribute('data-sha')) || ''
  var send = function (message) {
    message.source = 'brigade-design'
    message.file = FILE
    message.sha = SHA
    window.parent.postMessage(message, '*')
  }

  // Elements the canvas talks about, by a number of their own for this load.
  var handles = []
  var handleOf = new WeakMap()
  var handle = function (element) {
    var h = handleOf.get(element)
    if (h === undefined) {
      h = handles.length
      handles.push(element)
      handleOf.set(element, h)
    }
    return h
  }
  var byHandle = function (h) {
    var element = handles[h]
    return element && element.isConnected ? element : null
  }

  // Same as the host's: FNV-1a over UTF-16 code units, base 36.
  var fingerprint = function (text) {
    var hash = 0x811c9dc5
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(36)
  }
  var ownText = function (element) {
    var text = ''
    for (var n = element.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) text += n.data
    return text.replace(/\s+/g, ' ').trim()
  }
  var mark = function (element) {
    var raw = element.getAttribute('data-bid')
    if (!raw) return null
    var parts = raw.split(':')
    return { id: Number(parts[0]), line: Number(parts[1]), fp: parts[2] || '' }
  }
  var withId = function (id) {
    return Array.prototype.slice.call(document.querySelectorAll('[data-bid^="' + Number(id) + ':"]'))
  }
  var rect = function (element) {
    var r = element.getBoundingClientRect()
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  }
  var label = function (element) {
    if (element.tagName === 'IMG') return element.getAttribute('alt') || ''
    return (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)
  }
  // A short CSS path, for an element without a data-id.
  var path = function (element) {
    var parts = []
    for (var e = element; e && e !== document.body && parts.length < 5; e = e.parentElement) {
      var parent = e.parentElement
      var tag = e.tagName
      var same = parent ? Array.prototype.filter.call(parent.children, function (c) { return c.tagName === tag }) : []
      parts.unshift(tag.toLowerCase() + (same.length > 1 ? ':nth-of-type(' + (same.indexOf(e) + 1) + ')' : ''))
    }
    return parts.join(' > ')
  }
  // What the canvas outlines: an element written in the page, else what the page's script made.
  var describe = function (element) {
    var m = mark(element)
    return {
      h: handle(element),
      bid: m ? m.id : null,
      tag: element.tagName.toLowerCase(),
      label: label(element),
      rect: rect(element),
    }
  }
  var at = function (x, y) {
    var element = document.elementFromPoint(x, y)
    if (!element || element === document.documentElement) return null
    // Inside an icon: the icon. Anything else is itself: one without a number the page's script made.
    var svg = element.closest('svg')
    return svg || element
  }

  var COMPUTED = COMPUTED_PROPERTIES
  var ATTRS = ['href', 'src', 'alt', 'title', 'placeholder', 'aria-label']
  var inspect = function (element) {
    var m = mark(element)
    var css = getComputedStyle(element)
    var computed = {}
    for (var i = 0; i < COMPUTED.length; i++) computed[COMPUTED[i]] = css.getPropertyValue(COMPUTED[i])
    var inline = {}
    for (var j = 0; j < element.style.length; j++) {
      var name = element.style[j]
      inline[name] = element.style.getPropertyValue(name)
    }
    var attrs = {}
    for (var k = 0; k < ATTRS.length; k++)
      if (element.hasAttribute(ATTRS[k])) attrs[ATTRS[k]] = element.getAttribute(ATTRS[k])
    var unique = m ? withId(m.id).length === 1 : false
    var leaf = element.children.length === 0 && !/^(svg|img|input|textarea|select|video|canvas|iframe|br|hr)$/i.test(element.tagName)
    var textOk = unique && leaf && fingerprint(ownText(element)) === m.fp
    var parent = element.parentElement
    while (parent && parent !== document.body && !parent.hasAttribute('data-bid')) parent = parent.parentElement
    var info = describe(element)
    info.line = m ? m.line : null
    info.dataId = element.getAttribute('data-id')
    info.path = path(element)
    info.text = leaf ? element.textContent : null
    info.computed = computed
    info.inline = inline
    info.attrs = attrs
    info.editable = { style: unique, attrs: unique, text: textOk }
    info.scripted = !m || !unique || (leaf && !textOk)
    info.parent = parent && parent !== document.body ? handle(parent) : null
    return info
  }

  // The selection's outlines follow the page: scrolling, resizing, its script changing it.
  var watched = []
  var queued = false
  var report = function () {
    if (queued || watched.length === 0) return
    queued = true
    requestAnimationFrame(function () {
      queued = false
      var rects = {}
      for (var i = 0; i < watched.length; i++) {
        var element = byHandle(watched[i])
        rects[watched[i]] = element ? rect(element) : null
      }
      send({ type: 'rects', rects: rects })
    })
  }
  addEventListener('scroll', report, true)
  addEventListener('resize', report)

  // The page's height, for the canvas to size the board: on load, and when its content changes size.
  var height = function () {
    return Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)
  }
  // \`resized\`: the frame changed size just before: a page that grew with it is sized by it (vh).
  var sizeTimer = 0
  var resized = false
  var sendSize = function () {
    clearTimeout(sizeTimer)
    sizeTimer = setTimeout(function () {
      send({ type: 'size', height: height(), frame: innerHeight, resized: resized })
      resized = false
    }, 150)
  }
  addEventListener('resize', function () {
    resized = true
    sendSize()
  })

  // On the canvas: zoom and pan with the wheel the page does not use.
  var canvas = false
  var play = false
  var canScroll = function (element, dx, dy) {
    for (var e = element; e; e = e.parentElement) {
      var root = e === document.documentElement || e === document.body
      var style = root ? null : getComputedStyle(e)
      if (!root && !/(auto|scroll)/.test(style.overflowY + style.overflowX)) continue
      var box = root ? document.scrollingElement || document.documentElement : e
      if (dy > 0 && box.scrollTop + box.clientHeight < box.scrollHeight - 1) return true
      if (dy < 0 && box.scrollTop > 0) return true
      if (dx > 0 && box.scrollLeft + box.clientWidth < box.scrollWidth - 1) return true
      if (dx < 0 && box.scrollLeft > 0) return true
      if (root) return false
    }
    return false
  }
  addEventListener('wheel', function (e) {
    if (!canvas) return
    var zoom = e.ctrlKey || e.metaKey
    if (!zoom && (!play || canScroll(e.target, e.deltaX, e.deltaY))) return
    e.preventDefault()
    send({ type: 'wheel', dx: e.deltaX, dy: e.deltaY, zoom: zoom, x: e.clientX, y: e.clientY, lines: e.deltaMode === 1 })
  }, { passive: false, capture: true })

  // Retyping a text in place.
  var typing = null
  var finish = function (keep) {
    if (!typing) return
    var t = typing
    typing = null
    t.element.removeAttribute('contenteditable')
    var text = t.element.textContent
    if (!keep) t.element.textContent = t.before
    else if (text !== t.before) {
      var m = mark(t.element)
      if (m) t.element.setAttribute('data-bid', m.id + ':' + m.line + ':' + fingerprint(ownText(t.element)))
    }
    send({ type: 'typed', h: t.h, bid: t.bid, text: keep && text !== t.before ? text : null })
  }
  var retype = function (h) {
    var element = byHandle(h)
    var m = element && mark(element)
    if (!element || !m) return
    finish(true)
    typing = { element: element, h: h, bid: m.id, before: element.textContent }
    element.setAttribute('contenteditable', 'plaintext-only')
    element.focus()
    var range = document.createRange()
    range.selectNodeContents(element)
    var selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  }
  addEventListener('keydown', function (e) {
    if (!typing) return
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false) }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); finish(true) }
  }, true)
  addEventListener('focusout', function (e) {
    if (typing && e.target === typing.element) finish(true)
  }, true)

  var loading = null
  var library = function () {
    if (!loading)
      loading = new Promise(function (resolve, reject) {
        var script = document.createElement('script')
        script.src = HTML_TO_IMAGE_URL
        script.onload = function () { resolve(window.htmlToImage) }
        script.onerror = function () { reject(new Error('Could not load the capture library')) }
        document.head.appendChild(script)
      })
    return loading
  }
  var capture = async function (m) {
    try {
      var draw = await library()
      if (document.fonts) await document.fonts.ready
      var slides = Array.prototype.slice.call(document.querySelectorAll('[data-slide]'))
      var targets = m.slides && slides.length ? slides : [document.body]
      var background = getComputedStyle(document.body).backgroundColor
      if (!background || background === 'rgba(0, 0, 0, 0)') background = '#ffffff'
      var images = []
      for (var i = 0; i < targets.length; i++) {
        var element = targets[i]
        var whole = element === document.body
        var width = whole ? document.documentElement.scrollWidth : element.offsetWidth
        var height = whole ? document.documentElement.scrollHeight : element.offsetHeight
        // A picture of the top of the page only (the gallery's), when asked.
        if (whole && m.maxHeight) height = Math.min(height, m.maxHeight)
        var ratio = m.ratio || Math.min(2, window.devicePixelRatio || 1)
        // A background colour replaces the element's own: only for the whole page, which may have none.
        var options = { pixelRatio: ratio, width: width, height: height }
        if (whole) options.backgroundColor = background
        var data = await draw.toPng(whole ? document.documentElement : element, options)
        images.push({
          data: data,
          width: Math.round(width * ratio),
          height: Math.round(height * ratio),
          notes: element.getAttribute('data-notes') || '',
        })
      }
      send({ type: 'captured', id: m.id, images: images })
    } catch (error) {
      send({ type: 'captured', id: m.id, error: String((error && error.message) || error) })
    }
  }

  var style = function (elements, declarations) {
    for (var i = 0; i < elements.length; i++)
      for (var name in declarations) {
        if (!/^(--)?-?[a-z][a-z0-9-]*$/.test(name)) continue
        var value = declarations[name]
        if (value === null || value === '') elements[i].style.removeProperty(name)
        else elements[i].style.setProperty(name, String(value))
      }
    report()
  }

  addEventListener('message', function (e) {
    if (e.source !== window.parent) return
    var m = e.data || {}
    var element
    if (m.type === 'brigade:canvas') {
      canvas = true
      play = Boolean(m.play)
    } else if (m.type === 'brigade:hit') {
      element = at(Number(m.x), Number(m.y))
      send({ type: 'hit', seq: m.seq, element: element ? describe(element) : null })
    } else if (m.type === 'brigade:inspect') {
      element = byHandle(m.h)
      if (element) send({ type: 'inspected', element: inspect(element) })
    } else if (m.type === 'brigade:watch') {
      watched = Array.isArray(m.hs) ? m.hs.slice(0, 50) : []
      report()
    } else if (m.type === 'brigade:scroll') {
      var box = document.scrollingElement || document.documentElement
      var top = box.scrollTop
      var left = box.scrollLeft
      box.scrollBy(Number(m.dx) || 0, Number(m.dy) || 0)
      send({ type: 'scrolled', dx: (Number(m.dx) || 0) - (box.scrollLeft - left), dy: (Number(m.dy) || 0) - (box.scrollTop - top) })
    } else if (m.type === 'brigade:style') {
      style(withId(m.bid), m.style || {})
    } else if (m.type === 'brigade:attrs') {
      var list = withId(m.bid)
      for (var i = 0; i < list.length; i++)
        for (var name in m.attrs || {})
          if (ATTRS.indexOf(name) >= 0) {
            if (m.attrs[name] === null) list[i].removeAttribute(name)
            else list[i].setAttribute(name, String(m.attrs[name]))
          }
      report()
    } else if (m.type === 'brigade:text') {
      var same = withId(m.bid)
      for (var j = 0; j < same.length; j++) {
        same[j].textContent = String(m.text)
        var mk = mark(same[j])
        if (mk) same[j].setAttribute('data-bid', mk.id + ':' + mk.line + ':' + fingerprint(ownText(same[j])))
      }
      report()
    } else if (m.type === 'brigade:edit-text') {
      retype(m.h)
    } else if (m.type === 'brigade:vars') {
      var vars = m.vars || {}
      for (var v in vars)
        if (/^--[\w-]+$/.test(v)) document.documentElement.style.setProperty(v, String(vars[v]))
    } else if (m.type === 'brigade:print') {
      print()
    } else if (m.type === 'brigade:capture') {
      capture(m)
    }
  })

  // Added to the head: say so once the page is parsed, with its slides; its size once it has one.
  var ready = function () {
    send({ type: 'ready', slides: document.querySelectorAll('[data-slide]').length })
    new MutationObserver(report).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
    if (window.ResizeObserver) new ResizeObserver(sendSize).observe(document.body)
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', ready)
  else ready()
  addEventListener('load', function () {
    var fonts = document.fonts ? document.fonts.ready : Promise.resolve()
    fonts.then(function () { requestAnimationFrame(sendSize) })
  })
})()`

const escapeAttr = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** The bridge, as an inline script, for one page of a design. */
export const bridgeScript = (page: { file: string; sha256: string }) =>
  `<script data-brigade-bridge data-file="${escapeAttr(page.file)}" data-sha="${escapeAttr(page.sha256)}">${SOURCE.replace(
    'HTML_TO_IMAGE_URL',
    JSON.stringify(HTML_TO_IMAGE),
  ).replace('COMPUTED_PROPERTIES', JSON.stringify(COMPUTED))}</script>`
