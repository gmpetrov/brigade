'use client'
// A widget a teammate drew (its show_widget tool), in a sandboxed frame: an
// opaque origin with scripts but no cookies, no access to the dashboard or the
// API, no forms, popups or top navigation. Its CSP blocks network requests
// besides scripts from public CDNs and Google Fonts. A srcdoc frame also
// inherits the dashboard's CSP, should the dashboard ever set one.
//
// The frame talks to the dashboard by postMessage: it reports its height and
// its first script error, and gets the dashboard's theme variables when the
// theme changes. The document is built once per widget, so the frame loads
// once; a second load means the widget navigated itself away, and it is
// replaced with a notice. A script error shows above the widget, in its place
// when nothing was drawn.
import { WIDGET_THEME_VARS } from '@brigade/contracts'
import { useEffect, useRef, useState } from 'react'
import { themeFontHrefs } from '@/app/theme-fonts'

/** Taller than this, the frame scrolls. */
const HEIGHT_MAX = 1600

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com data:',
  'img-src data: blob:',
  "connect-src 'none'",
].join('; ')

/** Runs in the frame, before the widget's HTML. Plain JavaScript in a string. */
const BRIDGE = String.raw`(function () {
  var root = document.documentElement
  var last = -1
  var failed = false
  var fail = function (message) {
    if (failed) return
    failed = true
    parent.postMessage({ source: 'brigade-widget', type: 'error', message: String(message).slice(0, 300) }, '*')
  }
  addEventListener('error', function (event) { fail(event.message || 'Script error') })
  addEventListener('unhandledrejection', function (event) {
    fail((event.reason && event.reason.message) || event.reason || 'Unhandled rejection')
  })
  var measure = function () {
    var height = Math.ceil(document.body.getBoundingClientRect().height)
    if (height === last) return
    last = height
    parent.postMessage({ source: 'brigade-widget', type: 'height', height: height }, '*')
  }
  addEventListener('DOMContentLoaded', function () {
    new ResizeObserver(measure).observe(document.body)
    measure()
  })
  addEventListener('message', function (event) {
    var data = event.data
    if (event.source !== parent || !data || data.source !== 'brigade-dashboard' || data.type !== 'theme') return
    for (var name in data.vars) root.style.setProperty(name, data.vars[name])
    root.style.colorScheme = data.scheme
    dispatchEvent(new Event('themechange'))
  })
})()`

type Theme = { vars: Record<string, string>; scheme: string }

/** The dashboard's current theme, as the frame needs it. */
function currentTheme(): Theme {
  const style = getComputedStyle(document.documentElement)
  const vars: Record<string, string> = {}
  for (const name of WIDGET_THEME_VARS) vars[name] = style.getPropertyValue(name).trim()
  return { vars, scheme: style.colorScheme || 'normal' }
}

/** A value from the dashboard's own stylesheet, made safe to put in a <style>. */
const cssValue = (value: string) => value.replace(/[<>{};]/g, '')

function widgetDocument(html: string, theme: Theme) {
  const vars = Object.entries(theme.vars)
    .map(([name, value]) => `${name}: ${cssValue(value)};`)
    .join(' ')
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    '<meta name="referrer" content="no-referrer">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    themeFontHrefs.map((href) => `<link rel="stylesheet" href="${href}">`).join('') +
    `<style>:root { ${vars} color-scheme: ${cssValue(theme.scheme)}; }` +
    // flow-root: a first or last child's margin stays inside the body, which is what is measured.
    ' html { font-size: 16px; }' +
    ' body { display: flow-root; margin: 0; background: transparent; color: var(--foreground);' +
    ' font: 14px/1.5 var(--font-sans); -webkit-font-smoothing: antialiased; }</style>' +
    `<script>${BRIDGE}</script>` +
    `</head><body>${html}</body></html>`
  )
}

export function WidgetFrame({ html, title }: { html: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const loads = useRef(0)
  const [doc, setDoc] = useState<string>()
  const [height, setHeight] = useState<number>()
  const [navigated, setNavigated] = useState(false)
  const [error, setError] = useState<string>()

  // Built on the client, where the theme can be read; once per widget.
  useEffect(() => {
    loads.current = 0
    setNavigated(false)
    setHeight(undefined)
    setError(undefined)
    setDoc(widgetDocument(html, currentTheme()))
  }, [html])

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // Only from this frame's own document: after a navigation, the frame holds another page.
      if (!frame.current || event.source !== frame.current.contentWindow || loads.current > 1)
        return
      const data = event.data as {
        source?: unknown
        type?: unknown
        height?: unknown
        message?: unknown
      } | null
      if (data?.source !== 'brigade-widget') return
      if (data.type === 'error' && typeof data.message === 'string') setError(data.message)
      if (data.type !== 'height') return
      if (typeof data.height !== 'number' || !Number.isFinite(data.height)) return
      setHeight(data.height <= 0 ? 0 : Math.min(Math.max(Math.ceil(data.height), 24), HEIGHT_MAX))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // next-themes switches a class on <html>: send the new values instead of reloading.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      if (loads.current !== 1) return
      frame.current?.contentWindow?.postMessage(
        { source: 'brigade-dashboard', type: 'theme', ...currentTheme() },
        '*',
      )
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    })
    return () => observer.disconnect()
  }, [])

  if (navigated)
    return (
      <div className="text-sm text-muted-foreground">
        This visual tried to open another page and was stopped.
      </div>
    )
  if (!doc) return <div className="h-40" />
  // A script that failed before drawing anything leaves an empty frame: only the notice shows.
  const empty = error !== undefined && height === 0
  const notice = error !== undefined && (
    <div className="text-sm text-muted-foreground">
      {empty ? 'This visual could not be drawn' : 'This visual hit an error and may be incomplete'}:{' '}
      <span className="font-mono text-xs wrap-anywhere">{error}</span>
    </div>
  )
  return (
    <div className="flex flex-col gap-2">
      {notice}
      <iframe
        ref={frame}
        title={title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        loading="lazy"
        srcDoc={doc}
        onLoad={() => {
          loads.current += 1
          if (loads.current > 1) setNavigated(true)
        }}
        className="block w-full border-0 bg-transparent"
        style={{ height: height ?? 160 }}
        hidden={empty}
      />
    </div>
  )
}
