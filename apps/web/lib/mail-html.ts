// A received mail's HTML made into the document the Inbox's frame shows (components/mail-body.tsx),
// in the browser. The frame is the guard: sandboxed with no scripts, no forms and no navigation
// of the dashboard, and a CSP that fetches nothing but images. Here, what is left: what the frame
// would refuse anyway goes (scripts, frames, <base>, <meta>), links open in a new tab, the files
// the mail carries (cid:) come from the API, and images from the web are left out until a person
// asks for them, since a sender learns from them that the mail was opened, and when, and where.

/** Nothing fetched but images (the images from the web only once shown), and no script. */
const CSP = "default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline'; font-src data:"

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
  /** It has images from the web, left out unless shown. */
  remoteImages: boolean
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
  let remoteImages = false
  // An image's address as the frame gets it: a file it carries from the API, one from the web
  // only once shown. Null: left out.
  const image = (value: string): string | null => {
    const v = value.trim()
    if (/^cid:/i.test(v)) return options.inline.get(cidOf(v)) ?? null
    if (/^data:image\//i.test(v)) return v
    if (REMOTE.test(v)) {
      remoteImages = true
      return options.showImages ? v : null
    }
    return null
  }
  const css = (text: string) =>
    text.replace(/@import[^;]*;?/gi, '').replace(URL_IN_CSS, (_, __, url: string) => {
      const kept = image(url)
      return kept ? `url("${kept.replace(/["\\\n]/g, '')}")` : 'none'
    })

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
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
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
    'blockquote{margin:0 0 0 .25em;padding-left:.75em;border-left:2px solid rgb(127 127 127 / .35)}' +
    'pre{white-space:pre-wrap}' +
    '</style>'
  // Ours first: the mail's own styles come after, and win.
  return {
    html: `<!doctype html><html><head>${head}${doc.head.innerHTML}</head>${doc.body.outerHTML}</html>`,
    remoteImages,
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
