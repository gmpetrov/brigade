// Records the demo's fixtures (lib/demo/fixtures.json) from a running preview, signed in
// as Ada in the sample Acme workspace (apps/api/prisma/seed-workspace.ts): it opens each
// dashboard page in a browser, follows its links, and keeps every API response the pages
// asked for. scripts/demo/record.sh starts a preview of its own and runs it; see docs/demo.md.
//
//   node scripts/demo-record.mjs [--url http://localhost:3000] [--out lib/demo/fixtures.json]
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const BASE = arg('url', 'http://localhost:3000').replace(/\/$/, '')
const OUT = arg('out', fileURLToPath(new URL('../lib/demo/fixtures.json', import.meta.url)))
const MAX_PAGES = Number(arg('max-pages', '400'))

// Query parameters that change with each visit (a timeline's window): dropped from keys.
const VOLATILE = new Set(['from', 'to'])
/** A request's key in the fixtures: method, path under /api, and its stable query. */
export function keyOf(method, url) {
  const u = new URL(url)
  const params = [...u.searchParams].filter(([k]) => !VOLATILE.has(k)).sort()
  const search = params.length ? `?${new URLSearchParams(params)}` : ''
  return `${method} ${u.pathname.replace(/^\/api/, '')}${search}`
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
})
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
/** @type {Record<string, { status: number, body: unknown }>} */
const responses = {}
/** Messages the API's socket sent: the shapes the demo's own socket plays. */
const socket = []

// A page's response, or one fetched below (which has no request to ask its method).
const keep = async (response, method = response.request().method()) => {
  const url = new URL(response.url())
  if (url.origin !== BASE || !url.pathname.startsWith('/api/') || method !== 'GET') return
  const key = keyOf('GET', response.url())
  const type = response.headers()['content-type'] ?? ''
  let body
  try {
    if (type.includes('json')) body = await response.json()
    else if (type.startsWith('text/') || type.includes('markdown')) body = { $text: await response.text(), type }
    else return
  } catch {
    return
  }
  // A failure (before the workspace was chosen, say) never replaces a success.
  if (responses[key] && responses[key].status < 400 && response.status() >= 400) return
  responses[key] = { status: response.status(), body }
}
page.on('response', (response) => void keep(response).catch(() => undefined))
page.on('websocket', (ws) =>
  ws.on('framereceived', ({ payload }) => {
    if (socket.length < 200) socket.push(String(payload))
  }),
)

const queue = ['/app']
const visited = new Set()
while (queue.length && visited.size < MAX_PAGES) {
  const path = queue.shift()
  if (visited.has(path)) continue
  visited.add(path)
  try {
    await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 30_000 })
  } catch {
    console.warn(`slow: ${path}`)
  }
  await page.waitForTimeout(300)
  const links = await page.$$eval('a[href^="/app"]', (as) => as.map((a) => a.getAttribute('href')))
  for (const link of links) {
    const clean = link.split('#')[0]
    if (!visited.has(clean) && !clean.startsWith('/app/capture') && !clean.includes('/log'))
      queue.push(clean)
  }
}

// What pages ask for only on a click: each library file's content and versions, each
// skill and thread file. Fetched with the page's session.
const get = async (path) => {
  await keep(await page.request.get(`${BASE}/api${path}`), 'GET')
}
const tree = responses['GET /library/tree']?.body
for (const file of tree?.files ?? []) {
  await get(`/library/${file.id}/content`)
  await get(`/library/${file.id}/versions`)
}
await browser.close()

// Each thread page's own socket sent the thread's state; one of each type is enough.
const byType = new Map()
for (const raw of socket) {
  try {
    const message = JSON.parse(raw)
    if (!byType.has(message.type)) byType.set(message.type, message)
  } catch {}
}

const sorted = Object.fromEntries(Object.entries(responses).sort(([a], [b]) => a.localeCompare(b)))
// The preview's address in what it answered (file links, say) becomes the demo's at run time.
const text = JSON.stringify(
  { recordedAt: new Date().toISOString(), origin: BASE, socket: [...byType.values()], responses: sorted },
  null,
  1,
).replaceAll(BASE, '{{origin}}')
writeFileSync(OUT, `${text}\n`)
console.log(`${visited.size} pages, ${Object.keys(sorted).length} responses → ${OUT}`)
