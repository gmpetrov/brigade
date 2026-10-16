// A new project from its website: the API reads the site (only public
// addresses, a few pages, a size cap), takes its name, description and icon
// from the HTML, and asks a runner for a brief written with the member's own
// account (project.describe). Nothing is kept: what the dashboard shows comes
// back when the project is made.
import { randomUUID } from 'node:crypto'
import {
  DESCRIBE_PROTOCOL,
  PROJECT_LOGO_MAX,
  PROJECT_SITE_TEXT_MAX,
  type RunnerToApi,
  type SiteBrief,
  type SiteInfo,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { parse, type DefaultTreeAdapterTypes } from 'parse5'
import { publicUrl } from './connectors/mcp.js'
import type { ScopedDb } from './db.js'
import { isOnline, runnerProtocol, sendToRunner } from './hub.js'
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

type Candidate = { href: string; size: number }

/** "180x180" → 180; "any" (an SVG) counts as large. */
function sizeOf(sizes: string, fallback: number) {
  if (/\bany\b/i.test(sizes)) return 256
  const found = [...sizes.matchAll(/(\d+)x(\d+)/gi)].map((m) => Math.min(+m[1]!, +m[2]!))
  return found.length ? Math.max(...found) : fallback
}

/** Closest to 192 px first; under 64 px only when nothing larger. */
const rank = (c: Candidate) => (c.size >= 64 ? 1000 - Math.abs(c.size - 192) : c.size)

type Page = {
  url: string
  name: string | null
  description: string | null
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
      if (key === 'og:site_name') siteName ||= content
      else if (key === 'application-name') appName ||= content
      else if (key === 'description') description ||= content
      else if (key === 'og:description' && !description) description = content
    } else if (node.tagName === 'link') {
      const rel = attr(node, 'rel').toLowerCase().split(/\s+/)
      const href = resolve(attr(node, 'href'))
      if (!href || !/^https?:/.test(href)) continue
      if (rel.includes('manifest')) manifest ??= href
      else if (rel.some((r) => r.startsWith('apple-touch-icon')))
        icons.push({ href, size: sizeOf(attr(node, 'sizes'), 180) })
      else if (rel.includes('icon')) {
        const svg = /svg/i.test(attr(node, 'type')) || /\.svg(\?|$)/i.test(href)
        icons.push({ href, size: sizeOf(attr(node, 'sizes'), svg ? 256 : 32) })
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
    icons,
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
  return icons.flatMap((icon: { src?: unknown; sizes?: unknown; type?: unknown }) => {
    if (typeof icon?.src !== 'string') return []
    const svg = typeof icon.type === 'string' && /svg/i.test(icon.type)
    return [
      {
        href: new URL(icon.src, url).href,
        size: sizeOf(typeof icon.sizes === 'string' ? icon.sizes : '', svg ? 256 : 0),
      },
    ]
  })
}

/** The best icon the site lists, else /favicon.ico, as a data URL; null when none loads. */
async function findLogo(page: Page): Promise<string | null> {
  const fromManifest = page.manifest ? await manifestIcons(page.manifest).catch(() => []) : []
  const candidates = [...page.icons, ...fromManifest].sort((a, b) => rank(b) - rank(a))
  candidates.push({ href: new URL('/favicon.ico', page.url).href, size: 16 })
  const tried = new Set<string>()
  for (const candidate of candidates.slice(0, 6)) {
    if (tried.has(candidate.href)) continue
    tried.add(candidate.href)
    const image = await fetchPublic(candidate.href, PROJECT_LOGO_MAX + 1, 'image/*').catch(
      () => null,
    )
    if (!image || image.bytes.byteLength > PROJECT_LOGO_MAX || image.bytes.byteLength < 16) continue
    const type = imageType(image.bytes)
    if (type) return `data:${type};base64,${toBase64(image.bytes)}`
  }
  return null
}

// ---------------------------------------------------------------------------
// Reading a site
// ---------------------------------------------------------------------------

type Read = SiteInfo & { text: string }

/** Sites read lately, by workspace and address: the brief comes right after the rest. */
const recent = new Map<string, { at: number; read: Promise<Read> }>()
const RECENT_MS = 10 * 60_000
const RECENT_MAX = 100

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
  const [logo, ...others] = await Promise.all([
    findLogo(page).catch(() => null),
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
  return { url: page.url, name: page.name, description: page.description, logo, text }
}

function readCached(scope: WorkspaceScope, url: string) {
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
  const { text: _text, ...info } = await readCached(scope, url)
  return info
}

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

type DescribeResult = Extract<RunnerToApi, { type: 'project.describe.result' }>
const describing = new Map<
  string,
  { computerId: string; settle: (result: DescribeResult) => void }
>()

/** A runner's answer to project.describe; only the computer asked may answer. */
export function settleDescribe(computerId: string, result: DescribeResult) {
  const run = describing.get(result.requestId)
  if (run?.computerId === computerId) run.settle(result)
}

/**
 * The account the brief is written with: the member's own, never another's,
 * on a computer online now with a runner that knows project.describe. The
 * default first, Claude before Codex, accounts out of usage never.
 */
async function briefAccount(db: ScopedDb, memberId: string) {
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
  const online = fresh.filter((r) => isOnline(r.computerId))
  if (online.length === 0) return { reason: 'None of the computers with your accounts is online.' }
  const ready = online
    .filter((r) => (runnerProtocol(r.computerId) ?? 0) >= DESCRIBE_PROTOCOL)
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
  const [site, choice] = await Promise.all([
    readCached(scope, url),
    briefAccount(db, scope.memberId),
  ])
  if (!('account' in choice) || !choice.account) return { brief: null, reason: choice.reason! }
  if (!site.text.trim()) return { brief: null, reason: 'The site shows no text to read.' }
  const account = choice.account
  const result = await new Promise<DescribeResult>((resolve) => {
    const requestId = randomUUID()
    const settle = (value: DescribeResult) => {
      clearTimeout(timer)
      describing.delete(requestId)
      resolve(value)
    }
    const fail = (error: string) =>
      settle({ type: 'project.describe.result', requestId, ok: false, error })
    const timer = setTimeout(() => fail('The computer did not answer in time'), DESCRIBE_MS)
    describing.set(requestId, { computerId: account.computerId, settle })
    const sent = sendToRunner(
      account.computerId,
      {
        type: 'project.describe',
        requestId,
        account: { id: account.id, provider: account.provider, source: account.source },
        url: site.url,
        text: site.text,
      },
      { touch: false },
    )
    if (!sent) fail('The computer went offline')
  })
  if (result.ok && result.brief) return { brief: result.brief }
  return { brief: null, reason: `It could not be written: ${result.error ?? 'no answer'}` }
}
