// Open a preview's pages as a person would, before anyone is told it is ready:
// the computer's Chrome loads each one at the address people open, and says
// what a status code cannot (a page that renders nothing, a script that
// throws). Run as the teammate, like design-shot.ts, so screenshots land in
// its folder:
//   node preview-check.js '<json: { url, paths, out }>'
// Prints the result as JSON.
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright-core'

type Input = {
  /** What a person opens: the preview's address, with its token when it needs one. */
  url: string
  paths: string[]
  out: string
  /** Its last check passed (a recheck after an edit): wait less for the page to settle. */
  quick?: boolean
}

export type PageCheck = {
  path: string
  /** The page's own response; 0 when it never answered. */
  status: number
  /** Where it ended, after redirects, as a path. */
  finalPath: string
  title: string
  /** It loaded and shows something, and no script failed. */
  ok: boolean
  /** Why not, for the teammate to fix. */
  problems: string[]
  /** Errors the page logged that did not stop it (e.g. hydration warnings). */
  warnings: string[]
  screenshot: string
}

export type CheckResult = { ok: boolean; pages: PageCheck[] }

const CHROMES = [
  process.env.BRIGADE_CHROME,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]
/** A first visit to a dev server compiles the page: wait that long for it. */
const LOAD_MS = 90_000
/** The proxy's page while the app starts or restarts. */
const WAITING = /reloads by itself/
/** No visible text and nothing drawn: a blank page. (Sparse pages with a frame are judged on their body.) */
const MIN_TEXT = 1

const slug = (path: string) =>
  path
    .replace(/^\/+/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .slice(0, 60) || 'home'

/**
 * What the page shows: its visible text, whether anything is drawn (images,
 * canvas, video, svg), and how much content lies below the header band and
 * right of a sidebar strip (text, pictures, controls). A page whose header and
 * menu render around an empty body (a form hidden until a check passes) has
 * text, but none there. Only a page with such a frame is judged on its body:
 * a bare page with a heading at the top is fine.
 */
const VISIBLE = `(() => {
  const text = (document.body && document.body.innerText || '').trim()
  const shown = (el) => {
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05
  }
  const drawn = [...document.querySelectorAll('img, canvas, video, svg, iframe')].some((el) => {
    const r = el.getBoundingClientRect()
    return r.width >= 32 && r.height >= 32 && shown(el)
  })
  const top = innerHeight * 0.12, left = innerWidth * 0.1
  const inBody = (r) => r.width > 0 && r.height > 0 && r.bottom > top && r.right > left && r.top < innerHeight && r.left < innerWidth
  const inStrip = (r) => r.width > 0 && r.height > 0 && r.bottom > top && r.right <= left
  let body = 0, strip = 0
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n && body < 50; n = walker.nextNode()) {
    if (!n.textContent.trim() || !n.parentElement || !shown(n.parentElement)) continue
    const range = document.createRange()
    range.selectNodeContents(n)
    const rects = [...range.getClientRects()]
    if (rects.some(inBody)) body++
    else if (rects.some(inStrip)) strip++
  }
  for (const el of document.querySelectorAll('img, canvas, video, svg, iframe, input, textarea, select, button')) {
    const r = el.getBoundingClientRect()
    if (r.width < 16 || r.height < 16 || !shown(el)) continue
    if (inBody(r)) body++
    else if (inStrip(r)) strip++
  }
  // A frame around the body: a sidebar strip with content, or a header or navigation with text.
  const framed = strip > 0 || [...document.querySelectorAll('header, nav, [role=banner], [role=navigation]')]
    .some((el) => shown(el) && el.innerText.trim())
  return { text: text.length, drawn, body, framed }
})()`

/** How often to look at the page while it settles. */
const LOOK_MS = 300
/** Pages checked at once, each in its own tab. */
const AT_ONCE = 4
/**
 * Waits after the page loads: at least `min` (a client render, a script that
 * throws just after), then until what it shows has not changed for `stable`,
 * and at most `max` (data, or a CAPTCHA check, that arrives late). Not until
 * the network is idle: a page that polls or streams never is. Shorter for a
 * recheck: its pages passed before, so a slow first render or a CAPTCHA is not
 * what an edit changes.
 */
const WAITS = {
  full: { min: 1_500, stable: 1_000, max: 12_000 },
  quick: { min: 500, stable: 500, max: 4_000 },
}

async function checkPage(
  page: Page,
  base: URL,
  path: string,
  out: string,
  waits: (typeof WAITS)['full'],
): Promise<PageCheck> {
  const problems: string[] = []
  const warnings = new Set<string>()
  const origin = base.origin
  const local = (url: string) => (url.startsWith(origin) ? url.slice(origin.length) || '/' : url)
  page.on('console', (m) => {
    if (m.type() === 'error') warnings.add(`console: ${m.text().slice(0, 300)}`)
  })
  page.on('pageerror', (e) => problems.push(`script error: ${e.message.slice(0, 300)}`))
  page.on('response', (r) => {
    const request = r.request()
    // The page's own requests (its data, its scripts) failing; not third parties'.
    let own = false
    try {
      own = request.frame() === page.mainFrame()
    } catch {
      // A service worker's request has no frame.
    }
    if (r.status() >= 500 && r.url().startsWith(origin) && own)
      problems.push(`${r.status()} for ${request.method()} ${local(r.url())}`)
    else if (r.status() >= 400 && r.url().startsWith(origin) && r.status() !== 404)
      warnings.add(`${r.status()} for ${request.method()} ${local(r.url())}`)
  })

  const target = new URL(path, base)
  let status = 0
  const deadline = Date.now() + LOAD_MS
  // The proxy's waiting page while the app compiles or restarts: load again until the app answers.
  for (;;) {
    const response = await page
      .goto(target.href, { waitUntil: 'load', timeout: Math.max(5_000, deadline - Date.now()) })
      .catch((error: Error) => {
        problems.push(`did not load: ${error.message.split('\n')[0]}`)
        return null
      })
    status = response?.status() ?? 0
    const html = response && status === 503 ? await response.text().catch(() => '') : ''
    if (!WAITING.test(html) || Date.now() > deadline) break
    await page.waitForTimeout(2_000)
  }
  if (status >= 400) problems.push(`the page answered ${status}`)
  type Visible = { text: number; drawn: boolean; body: number; framed: boolean }
  const look = () =>
    page
      .evaluate(VISIBLE)
      .catch(() => ({ text: 0, drawn: false, body: 0, framed: false })) as Promise<Visible>
  const shows = (v: Visible) => (v.text >= MIN_TEXT || v.drawn) && !(v.framed && v.body === 0)
  // Client-rendered pages draw after their data arrives: look until what it shows holds still.
  const loaded = Date.now()
  let visible = await look()
  let seen = JSON.stringify(visible)
  let since = loaded
  while (Date.now() - loaded < waits.max) {
    const now = Date.now()
    if (now - loaded >= waits.min && now - since >= waits.stable && shows(visible)) break
    await page.waitForTimeout(LOOK_MS)
    visible = await look()
    const next = JSON.stringify(visible)
    if (next !== seen) [seen, since] = [next, Date.now()]
  }
  const why =
    '(a form hidden until a check passes, a render that needs data or settings it does not have, a script that failed)'
  if (status > 0 && status < 400 && visible.text < MIN_TEXT && !visible.drawn)
    problems.push(`the page is blank: no text or images after it loaded ${why}`)
  else if (status > 0 && status < 400 && visible.framed && visible.body === 0)
    problems.push(
      `the page's body is empty: its header or menu shows, but nothing below or beside it ${why}. ` +
        'If it is meant to look like this, look at its screenshot and save anyway with a reason',
    )

  const screenshot = join(out, `${slug(path)}.png`)
  await page.screenshot({ path: screenshot }).catch(() => undefined)
  const final = new URL(page.url())
  return {
    path,
    status,
    finalPath: final.origin === origin ? final.pathname + (final.search ? '?…' : '') : final.origin,
    title: (await page.title().catch(() => '')).slice(0, 200),
    ok: problems.length === 0,
    problems: [...new Set(problems)].slice(0, 10),
    warnings: [...warnings].slice(0, 10),
    screenshot,
  }
}

async function main(input: Input): Promise<CheckResult> {
  const executablePath = CHROMES.find((p) => p && existsSync(p))
  if (!executablePath) throw new Error('No Chrome on this computer to check the preview')
  await mkdir(input.out, { recursive: true })
  // On a cloud computer, the usual OOM score rather than the runner's low one, as a turn's.
  if (process.platform === 'linux')
    await writeFile('/proc/self/oom_score_adj', '0').catch(() => undefined)
  const base = new URL(input.url)
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    ...(process.platform === 'linux' ? { chromiumSandbox: false } : {}),
  })
  const pages: PageCheck[] = new Array(input.paths.length)
  try {
    // One context: the address with its token first, whose cookie lets the pages in.
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    if (base.href !== `${base.origin}/`) {
      const page = await context.newPage()
      await page.goto(base.href, { waitUntil: 'commit', timeout: 30_000 }).catch(() => undefined)
      await page.close()
    }
    const origin = new URL(base.origin)
    // A few tabs at once: a dev server compiles their routes side by side.
    let next = 0
    const tab = async () => {
      for (let i = next++; i < input.paths.length; i = next++) {
        const page = await context.newPage()
        pages[i] = await checkPage(
          page,
          origin,
          input.paths[i]!,
          input.out,
          WAITS[input.quick ? 'quick' : 'full'],
        )
        await page.close()
      }
    }
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, input.paths.length) }, tab))
  } finally {
    await browser.close()
  }
  return { ok: pages.every((p) => p.ok), pages }
}

const raw = process.argv[2]
if (raw) {
  main(JSON.parse(raw) as Input).then(
    (result) => process.stdout.write(JSON.stringify(result)),
    (error: unknown) => {
      process.stderr.write(error instanceof Error ? error.message : String(error))
      process.exit(1)
    },
  )
}
