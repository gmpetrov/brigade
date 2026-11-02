// A received mail's HTML made into the document the Inbox's frame shows (components/mail-body.tsx),
// in the browser. The frame is the guard: sandboxed with no scripts, no forms and no navigation
// of the dashboard, and a CSP that fetches nothing at all until a person asks for its images
// (a sender learns from one that the mail was opened, and when, and where), then only images.
// CSS has too many ways to name an image (url(), image-set(), escapes…) to find them all: the CSP
// is what holds, and the rewriting here only keeps hidden images from showing as broken ones.
// Besides: what the frame would refuse anyway goes (scripts, frames, <base>, <meta>), links open
// in a new tab, and the files the mail carries (cid:) come from the API once shown (they are
// served by a redirect to another host, which a narrower CSP would have to name).

/** No script, and nothing fetched: images only once shown, from anywhere (cid: files too). */
const csp = (showImages: boolean) =>
  `default-src 'none'; img-src ${showImages ? '* data: blob:' : 'data:'}; style-src 'unsafe-inline'; font-src data:`

/** CSS that may name an image. */
const CSS_IMAGE = /url\(|image(-set)?\(|\\/i

/** What the mail's frame can't show or use anyway. */
const DROPPED = 'script,iframe,frame,frameset,object,embed,applet,base,meta,link,portal'

/** Attributes that fetch an image. */
const IMAGE_ATTRIBUTES = ['src', 'srcset', 'background', 'poster', 'href', 'xlink:href']

export type MailFrameTheme = {
  /** The dashboard's colors and font, for a mail that sets none of its own. */
  foreground: string
  link: string
  font: string
  scheme: 'light' | 'dark'
}

export type MailDocument = {
  /** The frame's whole document. */
  html: string
  /** It has images (or may: CSS that names one), fetched only once shown. */
  images: boolean
  /**
   * It sets its own colors (a newsletter, a receipt): shown as it was made, on white. A plain
   * mail (a person's) takes the dashboard's colors instead, so it reads the same in dark mode.
   */
  designed: boolean
}

const REMOTE = /^\s*(https?:)?\/\//i
const URL_IN_CSS = /url\(\s*(['"]?)(.*?)\1\s*\)/gi

export function mailDocument(
  raw: string,
  options: {
    showImages: boolean
    /** Each file it carries, by Content-ID: where the dashboard opens it. */
    inline: Map<string, string>
    theme: MailFrameTheme
  },
): MailDocument {
  const doc = new DOMParser().parseFromString(raw, 'text/html')
  let images = false
  // An image's address as the frame gets it, once shown: a file it carries from the API, one from
  // the web as it is. Null: left out (a data: image needs nothing fetched).
  const image = (value: string): string | null => {
    const v = value.trim()
    if (/^data:image\//i.test(v)) return v
    if (!v) return null
    images = true
    if (!options.showImages) return null
    if (/^cid:/i.test(v)) return options.inline.get(cidOf(v)) ?? null
    return REMOTE.test(v) ? v : null
  }
  const css = (text: string) => {
    if (CSS_IMAGE.test(text)) images = true
    return text.replace(/@import[^;]*;?/gi, '').replace(URL_IN_CSS, (_, __, url: string) => {
      const kept = image(url)
      return kept ? `url("${kept.replace(/["\\\n]/g, '')}")` : 'none'
    })
  }

  for (const el of doc.querySelectorAll(DROPPED)) el.remove()
  const designed =
    !!doc.querySelector('[bgcolor],[background],table[width]') ||
    [...doc.querySelectorAll('style')].some((s) => /background/i.test(s.textContent ?? '')) ||
    [...doc.querySelectorAll('[style]')].some((el) =>
      /background(-color|-image)?\s*:/i.test(el.getAttribute('style') ?? ''),
    )

  for (const style of doc.querySelectorAll('style'))
    style.textContent = css(style.textContent ?? '')
  for (const el of doc.querySelectorAll('*')) {
    for (const attribute of [...el.attributes]) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on')) el.removeAttribute(attribute.name)
    }
    const tag = el.tagName.toLowerCase()
    if (tag === 'a' || tag === 'area') {
      const href = el.getAttribute('href') ?? ''
      if (/^\s*(javascript|data|vbscript):/i.test(href)) el.removeAttribute('href')
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noopener noreferrer')
    } else {
      for (const name of IMAGE_ATTRIBUTES) {
        const value = el.getAttribute(name)
        if (value === null) continue
        if (name === 'srcset') {
          // Each candidate is an address: keep the attribute only when every one is shown.
          const kept = value.split(',').every((c) => image(c.trim().split(/\s+/)[0] ?? ''))
          if (!kept) el.removeAttribute(name)
          continue
        }
        const kept = image(value)
        if (kept) el.setAttribute(name, kept)
        else el.removeAttribute(name)
      }
    }
    const style = el.getAttribute('style')
    if (style) el.setAttribute('style', css(style))
    // A plain mail's colors are the dashboard's: a dark gray written for white paper would not
    // read on the dark theme.
    if (!designed) {
      if (el instanceof HTMLElement) el.style.removeProperty('color')
      if (tag === 'font') el.removeAttribute('color')
    }
  }

  const { theme } = options
  const head =
    '<meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp(options.showImages)}">` +
    '<meta name="referrer" content="no-referrer">' +
    '<base target="_blank">' +
    '<style>' +
    (designed
      ? ':root{color-scheme:light;background:#fff;color:#000}' +
        'body{margin:0;padding:16px;font:14px/1.5 system-ui,sans-serif}'
      : `:root{color-scheme:${theme.scheme};background:transparent;color:${cssValue(theme.foreground)}}` +
        `body{margin:0;font:15px/1.625 ${cssValue(theme.font)}}` +
        `a{color:${cssValue(theme.link)}}`) +
    'body{overflow-wrap:anywhere}img{max-width:100%;height:auto}' +
    // Its height is its content's, whatever the mail says: the frame is sized to fit it, so a
    // height of 100% (or 100vh) would grow with the frame, and the frame with it.
    'html,body{height:auto!important;min-height:0!important}' +
    'blockquote{margin:0 0 0 .25em;padding-left:.75em;border-left:2px solid rgb(127 127 127 / .35)}' +
    'pre{white-space:pre-wrap}' +
    '</style>'
  // Ours first: the mail's own styles come after, and win.
  return {
    html: `<!doctype html><html><head>${head}${doc.head.innerHTML}</head>${doc.body.outerHTML}</html>`,
    images,
    designed,
  }
}

/** A Content-ID as a cid: link names it: no angle brackets, %-escapes read, any case. */
export function cidOf(value: string) {
  let id = value.trim().replace(/^cid:/i, '').replace(/^<|>$/g, '')
  try {
    id = decodeURIComponent(id)
  } catch {
    // As it is.
  }
  return id.toLowerCase()
}

/** A value from the dashboard's own stylesheet, made safe to put in a <style>. */
const cssValue = (value: string) => value.replace(/[<>{};]/g, '')

/** Taller than this, the frame stops growing (and scrolls): no mail is, unless it grows itself. */
export const FRAME_MAX = 20_000

/**
 * Keeps a same-origin frame as tall as its document, from now on. A document that grows with its
 * frame (a height in vh) would push the page down forever: growing on each resize, many times in
 * a moment, it stops there (images loading grow it a few times, not frame after frame). Returns
 * what stops it.
 */
export function followHeight(frame: HTMLIFrameElement, onHeight: (height: number) => void) {
  const root = frame.contentDocument?.documentElement
  if (!root) return () => {}
  let last = 0
  let growths: number[] = []
  const fit = () => {
    const height = Math.min(Math.max(Math.ceil(root.getBoundingClientRect().height), 24), FRAME_MAX)
    if (Math.abs(height - last) < 1) return
    if (height > last && last > 0) {
      const now = performance.now()
      growths = [...growths.filter((t) => now - t < 1000), now]
      if (growths.length > LOOP_GROWTHS) return observer.disconnect()
    }
    last = height
    onHeight(height)
  }
  const observer = new ResizeObserver(fit)
  observer.observe(root)
  fit()
  return () => observer.disconnect()
}

/** Growths within a second that mean the document follows its frame. */
const LOOP_GROWTHS = 12
