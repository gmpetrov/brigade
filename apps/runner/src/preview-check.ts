// Open a preview's pages as a person would, before anyone is told it is ready:
// the computer's Chrome loads each one at the address people open, and says
// what a status code cannot (a page that renders nothing, a script that
// throws). Run as the teammate, like design-shot.ts, so screenshots land in
// its folder:
//   node preview-check.js '<json: { url, paths, out }>'
// Prints the result as JSON.
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright-core'

type Input = {
  /** What a person opens: the preview's address, with its token when it needs one. */
  url: string
  paths: string[]
  out: string
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
/** Less visible text than this, and nothing drawn, is a blank page. */
const MIN_TEXT = 20

const slug = (path: string) =>
  path
    .replace(/^\/+/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .slice(0, 60) || 'home'

/** What the page shows: its visible text and whether anything is drawn (images, canvas, video, svg). */
const VISIBLE = `(() => {
  const text = (document.body && document.body.innerText || '').trim()
  const drawn = [...document.querySelectorAll('img, canvas, video, svg, iframe')].some((el) => {
    const r = el.getBoundingClientRect()
    return r.width >= 32 && r.height >= 32 && getComputedStyle(el).visibility !== 'hidden'
  })
  return { text: text.length, drawn }
})()`

async function checkPage(page: Page, base: URL, path: string, out: string): Promise<PageCheck> {
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
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined)
  // Client-rendered pages draw after their data arrives.
  await page.waitForTimeout(1_500)

  if (status >= 400) problems.push(`the page answered ${status}`)
  const visible = (await page.evaluate(VISIBLE).catch(() => ({ text: 0, drawn: false }))) as {
    text: number
    drawn: boolean
  }
  if (status > 0 && status < 400 && visible.text < MIN_TEXT && !visible.drawn)
    problems.push(
      'the page is blank: no text or images after it loaded (a form hidden until a check passes, ' +
        'a render that needs data or settings it does not have, a script that failed)',
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
  const base = new URL(input.url)
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    ...(process.platform === 'linux' ? { chromiumSandbox: false } : {}),
  })
  const pages: PageCheck[] = []
  try {
    // One context: the address with its token first, whose cookie lets the pages in.
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    if (base.href !== `${base.origin}/`) {
      const page = await context.newPage()
      await page.goto(base.href, { waitUntil: 'commit', timeout: 30_000 }).catch(() => undefined)
      await page.close()
    }
    const origin = new URL(base.origin)
    for (const path of input.paths) {
      const page = await context.newPage()
      pages.push(await checkPage(page, origin, path, input.out))
      await page.close()
    }
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
