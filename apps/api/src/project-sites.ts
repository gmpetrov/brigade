// A new project from its website: the API reads the site (only public
// addresses, a few pages, a size cap), takes a first guess at its name,
// description and logo from the HTML, and asks a runner for the brief, the name
// and the pick of the site's logos, written with the member's own account
// (project.describe). Nothing is kept: what the dashboard shows comes back when
// the project is made.
import { randomUUID } from 'node:crypto'
import {
  DESCRIBE_PROTOCOL,
  PROJECT_LOGO_CANDIDATES_MAX,
  PROJECT_SITE_TEXT_MAX,
  type RunnerToApi,
  type SiteBrief,
  type SiteInfo,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { parse, serializeOuter, type DefaultTreeAdapterTypes } from 'parse5'
import { publicUrl } from './connectors/mcp.js'
import type { ScopedDb } from './db.js'
import { hubs } from './hub.js'
import type { WorkspaceScope } from './scope.js'

type Node = DefaultTreeAdapterTypes.Node
type Element = DefaultTreeAdapterTypes.Element

const TIMEOUT_MS = 8_000
const MAX_REDIRECTS = 5
/** Most of a page read: past it, the rest is left. */
const PAGE_MAX = 2 * 1024 * 1024
const MANIFEST_MAX = 64 * 1024
/** Pages besides the home page whose text the brief reads, when the home page links them. */
const MORE_PAGES = /^\/(about|company|product|products|features|pricing|solutions)\/?$/i
const MORE_PAGES_MAX = 2
/** What the brief reads of the home page and of each other page. */
const HOME_TEXT_MAX = 8_000
const OTHER_TEXT_MAX = 2_000
/** Longest a brief run may take, past the runner's own limit. */
const DESCRIBE_MS = 75_000
const USER_AGENT = 'Mozilla/5.0 (compatible; Brigade/1.0; +https://www.brigade.lol)'

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * A GET that follows redirects itself, so each address it is sent to is
 * checked as public too. The body is read up to `max` bytes.
 */
async function fetchPublic(raw: string, max: number, accept: string) {
  let url = raw
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await publicUrl(url)
    const response = await fetch(url, {
      redirect: 'manual',
      headers: { accept, 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => undefined)
      url = new URL(location, url).href
      continue
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`${new URL(url).hostname} answered ${response.status}`)
    }
    return {
      url,
      type: response.headers.get('content-type') ?? '',
      bytes: await readUpTo(response, max),
    }
  }
  throw new Error('Too many redirects')
}

async function readUpTo(response: Response, max: number) {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < max) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
  }
  await reader.cancel().catch(() => undefined)
  const bytes = new Uint8Array(Math.min(size, max))
  let at = 0
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.length - at)
    bytes.set(part, at)
    at += part.byteLength
    if (at >= bytes.length) break
  }
  return bytes
}

// ---------------------------------------------------------------------------
// Reading the HTML
// ---------------------------------------------------------------------------

const isElement = (node: Node): node is Element => 'tagName' in node
const attr = (node: Element, name: string) =>
  node.attrs.find((a) => a.name === name)?.value?.trim() ?? ''

/** Every element of the page, in document order. */
function* elements(node: Node): Generator<Element> {
  if (isElement(node)) yield node
  const children = 'childNodes' in node ? node.childNodes : []
  const content = isElement(node) && node.tagName === 'template' ? [] : children
  for (const child of content) yield* elements(child)
}

/** Shown to nobody, or not the page's own words. */
const NO_TEXT = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head', 'iframe'])
/** Elements that end a line of text. */
const BLOCK =
  /^(p|div|section|article|header|footer|main|aside|nav|li|ul|ol|h[1-6]|br|tr|td|th|dt|dd|blockquote|figcaption|button|a)$/

/** The page's visible text, a line per block, blank lines dropped. */
function pageText(node: Node): string {
  const parts: string[] = []
  const walk = (n: Node) => {
    if (n.nodeName === '#text') {
      parts.push((n as DefaultTreeAdapterTypes.TextNode).value)
      return
    }
    if (isElement(n) && NO_TEXT.has(n.tagName)) return
    for (const child of 'childNodes' in n ? n.childNodes : []) walk(child)
    if (isElement(n) && BLOCK.test(n.tagName)) parts.push('\n')
  }
  walk(node)
  return parts
    .join('')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

/** The first part of a title like "Acme | Furniture for offices". */
const titleName = (title: string) => title.split(/\s+[|·•—–-]\s+|:\s+/)[0]!.trim()

const clean = (text: string, max: number) => {
  const value = text.replace(/\s+/g, ' ').trim()
  return value ? (value.length > max ? `${value.slice(0, max - 1)}…` : value) : null
}

/** An image the site offers as its logo, and how to say it to the model. */
export type Candidate = {
  /** Where to fetch it; or its bytes, for an SVG drawn in the page. */
  source: { href: string } | { bytes: Uint8Array }
  kind: 'apple-touch-icon' | 'icon' | 'manifest' | 'page' | 'og:image' | 'favicon'
  /** Its side in px, as the site says; 0 when unknown. */
  size: number
  /** Width over height, as the page draws it; 1 when unknown. */
  aspect: number
  hint: string
}

/** "180x180" → 180; "any" (an SVG) counts as large. */
function sizeOf(sizes: string, fallback: number) {
  if (/\bany\b/i.test(sizes)) return 256
  const found = [...sizes.matchAll(/(\d+)x(\d+)/gi)].map((m) => Math.min(+m[1]!, +m[2]!))
  return found.length ? Math.max(...found) : fallback
}

/**
 * The first guess, before the model chooses: a large square icon, else a
 * square logo in the page, else a smaller icon; wide wordmarks and share
 * pictures last, as they shrink to nothing in a 20 px tile.
 */
export function rank(c: Candidate) {
  if (c.kind === 'og:image') return 1
  if (c.kind === 'page') return c.aspect > 1.5 || c.aspect < 0.67 ? 300 : 850
  if (c.size >= 120) return 1000 - Math.abs(c.size - 192)
  if (c.size >= 64) return 800 + c.size
  return c.size
}

/** A URL's file, for the model: Next's image URLs name theirs in `url`. */
function fileOf(href: string) {
  try {
    const url = new URL(href)
    const inner = url.searchParams.get('url')
    const path = inner ? new URL(inner, url).pathname : url.pathname
    return path.split('/').filter(Boolean).pop() ?? url.hostname
  } catch {
    return href.slice(0, 80)
  }
}

const quoted = (label: string, value: string) =>
  value ? `${label} "${value.replace(/\s+/g, ' ').trim().slice(0, 80)}"` : ''

const hintOf = (parts: (string | number | false | undefined)[]) =>
  parts.filter(Boolean).join(', ').slice(0, 300)

/** The largest picture of an `<img>`'s srcset, else its src. */
function imageSource(node: Element) {
  const set = attr(node, 'srcset')
    .split(',')
    .map((entry) => entry.trim().split(/\s+/))
    .filter(([href]) => href)
    .map(([href, descriptor = '1x']) => ({ href: href!, weight: parseFloat(descriptor) || 1 }))
    .sort((a, b) => b.weight - a.weight)
  return set[0]?.href ?? attr(node, 'src')
}

/** Most `<img>` and `<svg>` logos taken from one page. */
const PAGE_LOGOS_MAX = 3
/**
 * Most a logo may weigh when read. Some sites serve a 2 MB PNG for a 28 px
 * logo; the dashboard shrinks it to PROJECT_LOGO_MAX before it is kept.
 */
const CANDIDATE_MAX = 4 * 1024 * 1024
/** Most of a logo the site cache keeps, as a data URL; larger ones are fetched again. */
const KEPT_LOGO_MAX = 512 * 1024
/** Most an SVG drawn in the page may weigh to be kept as a logo. */
const INLINE_SVG_MAX = 64 * 1024
const LOGO_WORDS = /logo/i
/** A picture this wide is a photo or a banner, not a logo. */
const PAGE_LOGO_WIDTH_MAX = 600

/**
 * The `<img>` and `<svg>` in the page that look like its logo: named so (alt,
 * class, id, file), or the picture of a link to the home page.
 */
function pageLogos(document: Node, url: string): Candidate[] {
  const found: Candidate[] = []
  const home = new URL('/', url).href
  const walk = (node: Node, inHomeLink: boolean, inHeader: boolean) => {
    if (found.length >= PAGE_LOGOS_MAX || !isElement(node)) {
      for (const child of 'childNodes' in node ? node.childNodes : [])
        walk(child, inHomeLink, inHeader)
      return
    }
    const tag = node.tagName
    if (NO_TEXT.has(tag) && tag !== 'svg') return
    const where = [inHeader && 'in the header', inHomeLink && 'in the link to the home page']
      .filter(Boolean)
      .join(', ')
    const named = [attr(node, 'class'), attr(node, 'id'), attr(node, 'aria-label')].join(' ')
    if (tag === 'img') {
      const src = imageSource(node)
      const label = attr(node, 'alt')
      if (src && (inHomeLink || LOGO_WORDS.test(`${label} ${named} ${src}`))) {
        const href = (() => {
          try {
            return new URL(src, url).href
          } catch {
            return null
          }
        })()
        const width = Number(attr(node, 'width')) || 0
        const height = Number(attr(node, 'height')) || 0
        if (href && /^(https?:|data:image\/)/.test(href) && width <= PAGE_LOGO_WIDTH_MAX)
          found.push({
            source: { href },
            kind: 'page',
            size: Math.max(width, height),
            aspect: width && height ? width / height : 1,
            hint: hintOf([
              '<img> in the page',
              where,
              quoted('alt', label),
              width && height && `${width}×${height}`,
              !href.startsWith('data:') && `file ${fileOf(href)}`,
            ]),
          })
      }
      return
    }
    if (tag === 'svg') {
      if (inHomeLink || LOGO_WORDS.test(named)) {
        let markup = serializeOuter(node)
        if (!/\sxmlns=/.test(markup.slice(0, 200)))
          markup = markup.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"')
        const box = (attr(node, 'viewBox') || attr(node, 'viewbox')).split(/[\s,]+/).map(Number)
        const aspect = box.length === 4 && box[2]! > 0 && box[3]! > 0 ? box[2]! / box[3]! : 1
        const bytes = new TextEncoder().encode(markup)
        if (bytes.byteLength <= INLINE_SVG_MAX)
          found.push({
            source: { bytes },
            kind: 'page',
            size: 0,
            aspect,
            hint: hintOf([
              '<svg> drawn in the page',
              where,
              quoted('aria-label', attr(node, 'aria-label')),
              quoted('class', attr(node, 'class')),
              aspect > 1.5 && 'wide',
            ]),
          })
      }
      return
    }
    const homeLink =
      tag === 'a' &&
      (() => {
        try {
          return new URL(attr(node, 'href') || '#', url).href === home
        } catch {
          return false
        }
      })()
    const header = tag === 'header' || tag === 'nav' || /\bheader\b|\bnavbar\b/i.test(named)
    for (const child of node.childNodes) walk(child, inHomeLink || homeLink, inHeader || header)
  }
  walk(document, false, false)
  return found
}

type Page = {
  url: string
  name: string | null
  description: string | null
  /** Icons the head lists and logos the page shows, not yet the manifest's. */
  icons: Candidate[]
  manifest: string | null
  more: string[]
  text: string
}

export function readPage(html: string, url: string): Page {
  const document = parse(html)
  let title = ''
  let siteName = ''
  let appName = ''
  let description = ''
  const icons: Candidate[] = []
  const ogImages: Candidate[] = []
  let manifest: string | null = null
  const more = new Set<string>()
  const origin = new URL(url).origin
  const resolve = (href: string) => {
    try {
      return new URL(href, url).href
    } catch {
      return null
    }
  }
  for (const node of elements(document)) {
    if (node.tagName === 'title' && !title) title = pageText(node)
    else if (node.tagName === 'meta') {
      const key = (attr(node, 'property') || attr(node, 'name')).toLowerCase()
      const content = attr(node, 'content')
      if (key === 'og:image' && content) {
        const href = resolve(content)
        if (href && /^https?:/.test(href))
          ogImages.push({
            source: { href },
            kind: 'og:image',
            size: 0,
            aspect: 1.9,
            hint: hintOf([
              'og:image (the picture shown when the site is shared, often a wide banner)',
              `file ${fileOf(href)}`,
            ]),
          })
      } else if (key === 'og:site_name') siteName ||= content
      else if (key === 'application-name') appName ||= content
      else if (key === 'description') description ||= content
      else if (key === 'og:description' && !description) description = content
    } else if (node.tagName === 'link') {
      const rel = attr(node, 'rel').toLowerCase().split(/\s+/)
      const href = resolve(attr(node, 'href'))
      if (!href || !/^https?:/.test(href)) continue
      const sizes = attr(node, 'sizes')
      if (rel.includes('manifest')) manifest ??= href
      else if (rel.some((r) => r.startsWith('apple-touch-icon'))) {
        const size = sizeOf(sizes, 180)
        icons.push({
          source: { href },
          kind: 'apple-touch-icon',
          size,
          aspect: 1,
          hint: hintOf([
            'apple-touch-icon (home screen icon)',
            `${size}×${size}`,
            `file ${fileOf(href)}`,
          ]),
        })
      } else if (rel.includes('icon')) {
        const svg = /svg/i.test(attr(node, 'type')) || /\.svg(\?|$)/i.test(href)
        const size = sizeOf(sizes, svg ? 256 : 32)
        icons.push({
          source: { href },
          kind: 'icon',
          size,
          aspect: 1,
          hint: hintOf([
            'favicon (browser tab icon)',
            svg ? 'SVG' : sizes && `${size}×${size}`,
            `file ${fileOf(href)}`,
          ]),
        })
      }
    } else if (node.tagName === 'a' && more.size < MORE_PAGES_MAX) {
      const href = resolve(attr(node, 'href'))
      if (!href) continue
      const link = new URL(href)
      if (link.origin === origin && MORE_PAGES.test(link.pathname))
        more.add(link.origin + link.pathname)
    }
  }
  const body = document.childNodes
    .filter(isElement)
    .flatMap((html) => html.childNodes.filter((n) => isElement(n) && n.tagName === 'body'))[0]
  return {
    url,
    name: clean(siteName || appName || titleName(title), 80),
    description: clean(description, 500),
    icons: [...icons, ...pageLogos(document, url), ...ogImages.slice(0, 1)],
    manifest,
    more: [...more],
    text: [title.trim(), description.trim(), body ? pageText(body) : ''].filter(Boolean).join('\n'),
  }
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

// ---------------------------------------------------------------------------
// The logo
// ---------------------------------------------------------------------------

/** The image type its first bytes show, whatever the server said. */
export function imageType(bytes: Uint8Array): string | null {
  const b = bytes
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (decode(b.subarray(0, 4)) === 'RIFF' && decode(b.subarray(8, 12)) === 'WEBP')
    return 'image/webp'
  if (b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0) return 'image/x-icon'
  const head = decode(b.subarray(0, 1024)).replace(/^﻿/, '')
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(head))
    return 'image/svg+xml'
  return null
}

const toBase64 = (bytes: Uint8Array) => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** The icons a web app manifest lists. */
async function manifestIcons(href: string): Promise<Candidate[]> {
  const { url, bytes } = await fetchPublic(
    href,
    MANIFEST_MAX,
    'application/manifest+json, application/json',
  )
  const icons = (JSON.parse(decode(bytes)) as { icons?: unknown }).icons
  if (!Array.isArray(icons)) return []
  return icons.flatMap(
    (icon: { src?: unknown; sizes?: unknown; type?: unknown; purpose?: unknown }) => {
      if (typeof icon?.src !== 'string') return []
      const svg = typeof icon.type === 'string' && /svg/i.test(icon.type)
      const size = sizeOf(typeof icon.sizes === 'string' ? icon.sizes : '', svg ? 256 : 0)
      const iconUrl = new URL(icon.src, url).href
      return [
        {
          source: { href: iconUrl },
          kind: 'manifest' as const,
          size,
          aspect: 1,
          hint: hintOf([
            'app icon from the web manifest',
            size && `${size}×${size}`,
            typeof icon.purpose === 'string' &&
              icon.purpose.includes('maskable') &&
              'maskable (padded)',
            `file ${fileOf(iconUrl)}`,
          ]),
        },
      ]
    },
  )
}

/** A candidate's image as a data URL, or null when it does not load or is no image. */
async function loadCandidate(candidate: Candidate): Promise<string | null> {
  let bytes: Uint8Array
  if ('bytes' in candidate.source) bytes = candidate.source.bytes
  else if (candidate.source.href.startsWith('data:')) {
    const base64 = candidate.source.href.match(
      /^data:image\/[\w.+-]+;base64,([A-Za-z0-9+/=]+)$/,
    )?.[1]
    if (!base64) return null
    bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  } else {
    const image = await fetchPublic(candidate.source.href, CANDIDATE_MAX + 1, 'image/*').catch(
      () => null,
    )
    if (!image) return null
    bytes = image.bytes
  }
  if (bytes.byteLength > CANDIDATE_MAX || bytes.byteLength < 16) return null
  const type = imageType(bytes)
  return type ? `data:${type};base64,${toBase64(bytes)}` : null
}

/** A logo the site offers that loaded, as a data URL, and how it is said to the model. */
type Logo = {
  hint: string
  candidate: Candidate
  /** Kept only when small: a large one is fetched again if it is the one chosen. */
  data: string | null
}

/** A logo's data URL, fetched again when it was too large to keep. */
const dataOf = async (logo: Logo | undefined) =>
  logo ? (logo.data ?? (await loadCandidate(logo.candidate).catch(() => null))) : null

/**
 * Every logo the site offers that loads, best guess first: the head's icons,
 * the manifest's, the page's own logos, its share picture, else /favicon.ico.
 */
async function findLogos(page: Page): Promise<Logo[]> {
  const fromManifest = page.manifest ? await manifestIcons(page.manifest).catch(() => []) : []
  const seen = new Set<string>()
  const candidates = [...page.icons, ...fromManifest]
    .filter((c) => {
      const key = 'href' in c.source ? c.source.href : decode(c.source.bytes)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, PROJECT_LOGO_CANDIDATES_MAX - 1)
  const favicon = new URL('/favicon.ico', page.url).href
  if (!seen.has(favicon))
    candidates.push({
      source: { href: favicon },
      kind: 'favicon',
      size: 16,
      aspect: 1,
      hint: 'favicon.ico at the site root (browser tab icon)',
    })
  const loaded = await Promise.all(candidates.map((c) => loadCandidate(c).catch(() => null)))
  return candidates.flatMap((candidate, i) => {
    const data = loaded[i]
    if (!data) return []
    return [{ hint: candidate.hint, candidate, data: data.length <= KEPT_LOGO_MAX ? data : null }]
  })
}

// ---------------------------------------------------------------------------
// Reading a site
// ---------------------------------------------------------------------------

type Read = SiteInfo & { text: string; logos: Logo[] }

/** Sites read lately, by workspace and address: the brief comes right after the rest. */
const recent = new Map<string, { at: number; read: Promise<Read> }>()
const RECENT_MS = 10 * 60_000
const RECENT_MAX = 20

async function read(url: string): Promise<Read> {
  const home = await fetchPublic(url, PAGE_MAX, 'text/html,application/xhtml+xml').catch(
    (error: unknown) => {
      throw new HTTPException(422, {
        message: `Could not read ${url}: ${error instanceof Error ? error.message : String(error)}`,
      })
    },
  )
  if (!/html|xml/i.test(home.type) && home.type)
    throw new HTTPException(422, { message: `${url} is not a web page` })
  const page = readPage(decode(home.bytes), home.url)
  const [logos, ...others] = await Promise.all([
    findLogos(page).catch((): Logo[] => []),
    ...page.more.map((href) =>
      fetchPublic(href, PAGE_MAX, 'text/html')
        .then((p) => readPage(decode(p.bytes), p.url).text)
        .catch(() => ''),
    ),
  ])
  // The home page first, the others after it, each cut to its share.
  const text = [page.text.slice(0, HOME_TEXT_MAX), ...others.map((t) => t.slice(0, OTHER_TEXT_MAX))]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, PROJECT_SITE_TEXT_MAX)
  return {
    url: page.url,
    name: page.name,
    description: page.description,
    logo: await dataOf(logos[0]),
    logos,
    text,
  }
}

export function readCached(scope: WorkspaceScope, url: string) {
  const key = `${scope.workspaceId} ${url}`
  const now = Date.now()
  for (const [k, v] of recent) if (now - v.at > RECENT_MS) recent.delete(k)
  const hit = recent.get(key)
  if (hit) return hit.read
  if (recent.size >= RECENT_MAX) recent.delete(recent.keys().next().value!)
  const promise = read(url)
  recent.set(key, { at: now, read: promise })
  promise.catch(() => recent.delete(key))
  return promise
}

/** The site's name, description and logo. */
export async function readSite(scope: WorkspaceScope, url: string): Promise<SiteInfo> {
  await publicUrl(url).catch((error: unknown) => {
    throw new HTTPException(400, {
      message: error instanceof Error ? error.message : String(error),
    })
  })
  const { text: _text, logos: _logos, ...info } = await readCached(scope, url)
  return info
}

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

type DescribeResult = Extract<RunnerToApi, { type: 'project.describe.result' }>

/**
 * The account the brief is written with: the member's own, never another's,
 * on a computer online now with a runner that knows project.describe. The
 * default first, Claude before Codex, accounts out of usage never.
 */
async function briefAccount(db: ScopedDb, scope: WorkspaceScope) {
  const { memberId } = scope
  const now = new Date()
  const rows = await db.account.findMany({
    where: { memberId, status: { in: ['ready', 'unverified'] } },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  })
  if (rows.length === 0)
    return {
      reason: 'Connect a Claude or Codex account under Accounts to have it written for you.',
    }
  const fresh = rows.filter((r) => !r.exhaustedUntil || r.exhaustedUntil <= now)
  if (fresh.length === 0) return { reason: 'Your accounts are out of usage for now.' }
  const presence = await hubs
    .get(scope.workspaceId)
    .presence([...new Set(fresh.map((r) => r.computerId))])
  const online = fresh.filter((r) => presence[r.computerId]?.online)
  if (online.length === 0) return { reason: 'None of the computers with your accounts is online.' }
  const ready = online
    .filter((r) => (presence[r.computerId]?.protocolVersion ?? 0) >= DESCRIBE_PROTOCOL)
    .sort(
      (a, b) =>
        Number(b.isDefault) - Number(a.isDefault) ||
        Number(a.provider === 'codex') - Number(b.provider === 'codex'),
    )
  if (ready.length === 0) return { reason: 'Brigade on your computer needs an update to write it.' }
  return { account: ready[0]! }
}

/** A brief of the site written with the member's account, or why there is none. */
export async function describeSite(
  db: ScopedDb,
  scope: WorkspaceScope,
  url: string,
): Promise<SiteBrief> {
  await publicUrl(url).catch((error: unknown) => {
    throw new HTTPException(400, {
      message: error instanceof Error ? error.message : String(error),
    })
  })
  const [site, choice] = await Promise.all([readCached(scope, url), briefAccount(db, scope)])
  if (!('account' in choice) || !choice.account) return { brief: null, reason: choice.reason! }
  if (!site.text.trim()) return { brief: null, reason: 'The site shows no text to read.' }
  const account = choice.account
  const requestId = randomUUID()
  const answer = await hubs.get(scope.workspaceId).askRunner(
    account.computerId,
    {
      type: 'project.describe',
      requestId,
      account: { id: account.id, provider: account.provider, source: account.source },
      url: site.url,
      text: site.text,
      logos: site.logos.map((l) => l.hint),
    },
    DESCRIBE_MS,
    { touch: false, offline: 'The computer went offline' },
  )
  const result: DescribeResult =
    'type' in answer && answer.type === 'project.describe.result'
      ? answer
      : {
          type: 'project.describe.result',
          requestId,
          ok: false,
          error:
            'error' in answer && answer.error !== 'The computer did not answer'
              ? answer.error
              : 'The computer did not answer in time',
        }
  if (result.ok && result.brief)
    return {
      brief: result.brief,
      name: result.name ?? null,
      logo: result.logo === undefined ? null : await dataOf(site.logos[result.logo]),
    }
  return { brief: null, reason: `It could not be written: ${result.error ?? 'no answer'}` }
}
