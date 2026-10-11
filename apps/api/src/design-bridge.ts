// The script the sandbox host adds to a design's pages, for the dashboard's
// viewer around it: pick an element to comment on, try knob values, print, and
// capture the page or its slides as pictures. It talks to the viewer only by
// postMessage (the design's origin is opaque) and does nothing in a page that
// is not framed. Messages it sends carry `source: 'brigade-design'`.
//
// Plain JavaScript in a string: it runs in the design's page, not here.
// Capturing draws the page with html-to-image, loaded on first use: it renders
// through an SVG image, where libraries that clone the page into a frame fail
// (in a sandbox every frame is its own origin). It inlines fonts and images by
// fetching them, which the design's CSP allows from itself and public CDNs.

const HTML_TO_IMAGE = 'https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.js'

const SOURCE = String.raw`(function () {
  if (window.parent === window) return
  var send = function (message) {
    message.source = 'brigade-design'
    window.parent.postMessage(message, '*')
  }
  var picking = false
  var box = null
  var target = function (node) {
    var element = node instanceof Element ? node : null
    return element ? element.closest('[data-id]') || element : null
  }
  var outline = function (element) {
    if (!box) {
      box = document.createElement('div')
      box.style.cssText =
        'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #7c3aed;' +
        'background:rgba(124,58,237,.08);border-radius:4px;display:none'
      document.documentElement.appendChild(box)
    }
    if (!element) return void (box.style.display = 'none')
    var r = element.getBoundingClientRect()
    box.style.display = 'block'
    box.style.left = r.left - 2 + 'px'
    box.style.top = r.top - 2 + 'px'
    box.style.width = r.width + 4 + 'px'
    box.style.height = r.height + 4 + 'px'
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
  addEventListener('mousemove', function (e) { if (picking) outline(target(e.target)) }, true)
  addEventListener('click', function (e) {
    if (!picking) return
    e.preventDefault()
    e.stopPropagation()
    var element = target(e.target)
    if (!element) return
    send({
      type: 'picked',
      dataId: element.getAttribute('data-id'),
      selector: path(element),
      text: (element.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      html: element.outerHTML.replace(/\s+/g, ' ').slice(0, 500),
    })
  }, true)
  addEventListener('keydown', function (e) {
    if (picking && e.key === 'Escape') send({ type: 'cancel' })
  })

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
        var ratio = Math.min(2, window.devicePixelRatio || 1)
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
  addEventListener('message', function (e) {
    if (e.source !== window.parent) return
    var m = e.data || {}
    if (m.type === 'brigade:pick') {
      picking = Boolean(m.on)
      document.documentElement.style.cursor = picking ? 'crosshair' : ''
      if (!picking) outline(null)
    } else if (m.type === 'brigade:vars') {
      var vars = m.vars || {}
      for (var name in vars)
        if (/^--[\w-]+$/.test(name)) document.documentElement.style.setProperty(name, String(vars[name]))
    } else if (m.type === 'brigade:print') {
      print()
    } else if (m.type === 'brigade:capture') {
      capture(m)
    }
  })
  // Added to the head: say so once the page is parsed, with its slides.
  var ready = function () {
    send({ type: 'ready', slides: document.querySelectorAll('[data-slide]').length })
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', ready)
  else ready()
})()`

/** The bridge, as an inline script. */
export const BRIDGE_SCRIPT = `<script data-brigade-bridge>${SOURCE.replace(
  'HTML_TO_IMAGE_URL',
  JSON.stringify(HTML_TO_IMAGE),
)}</script>`
