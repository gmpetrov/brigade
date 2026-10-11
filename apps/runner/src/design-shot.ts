// Render a design on this computer, as the teammate who made it: a screenshot
// per viewport (per slide for a deck), the errors its page logged, and
// optionally the gallery's thumbnail. Run as its own process so it reads and
// writes files with the teammate's rights:
//   node design-shot.js '<json: { folder, out, viewports?, thumbnail? }>'
// Prints the result as JSON. Uses the computer's Chrome through playwright-core.
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, extname, join, resolve, sep } from 'node:path'
import {
  addToHead,
  DESIGN_ENTRY,
  DESIGN_KNOBS,
  DESIGN_MANIFEST,
  DesignKnobs,
  DesignManifest,
  knobsStyle,
  type DesignViewport,
} from '@brigade/contracts'
import { chromium } from 'playwright-core'

type Input = {
  folder: string
  out: string
  viewports?: DesignViewport[]
  /** false: only the thumbnail. */
  shots?: boolean
  thumbnail?: boolean
}
export type ShotResult = { screenshots: string[]; errors: string[]; thumbnail?: string }

const SIZES: Record<DesignViewport, { width: number; height: number }> = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
}
/** Longest full-page screenshot; a page taller than this is cut. */
const MAX_HEIGHT = 8000
const MAX_SLIDES = 40

const CHROMES = [
  process.env.BRIGADE_CHROME,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]

async function json<T>(file: string, schema: { safeParse: (v: unknown) => { data?: T } }) {
  try {
    return schema.safeParse(JSON.parse(await readFile(file, 'utf8'))).data ?? null
  } catch {
    return null
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

/**
 * The folder over HTTP on a private port, as the viewer serves it: module
 * scripts do not load from file://. Its pages get the knobs' values, like in
 * the library.
 */
async function serve(folder: string, style: string) {
  const root = resolve(folder)
  const server = createServer((req, res) => {
    void (async () => {
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
      const file = resolve(root, `.${path.endsWith('/') ? `${path}${DESIGN_ENTRY}` : path}`)
      if (!file.startsWith(root + sep)) return res.writeHead(404).end()
      let body: Buffer | string = await readFile(file)
      const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
      if (style && type.startsWith('text/html'))
        body = addToHead(body.toString('utf8'), `<style data-brigade-knobs>${style}</style>`)
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(body)
    })().catch(() =>
      // Chrome asks for a favicon on its own: not the design's mistake.
      res.writeHead(req.url === '/favicon.ico' ? 204 : 404).end(),
    )
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

async function main(input: Input): Promise<ShotResult> {
  const folder = input.folder.replace(/\/+$/, '')
  const entry = join(folder, DESIGN_ENTRY)
  if (!existsSync(entry)) throw new Error(`${folder} has no ${DESIGN_ENTRY}`)
  const manifest = await json(join(folder, DESIGN_MANIFEST), DesignManifest)
  const knobs = await json(join(folder, DESIGN_KNOBS), DesignKnobs)
  const style = knobs ? knobsStyle(knobs.knobs) : ''
  const executablePath = CHROMES.find((p) => p && existsSync(p))
  if (!executablePath)
    throw new Error('No Chrome on this computer to render the design (set BRIGADE_CHROME)')
  await mkdir(input.out, { recursive: true })

  const served = await serve(folder, style)
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    // Cloud computers run Chrome without its user-namespace sandbox; the page is the teammate's own.
    ...(process.platform === 'linux' ? { chromiumSandbox: false } : {}),
  })
  const errors = new Set<string>()
  const name = basename(folder).replace(/\.design$/, '')
  const result: ShotResult = { screenshots: [], errors: [] }
  try {
    const open = async (viewport: { width: number; height: number }, scale = 1) => {
      const page = await browser.newPage({ viewport, deviceScaleFactor: scale })
      page.on('console', (m) => m.type() === 'error' && errors.add(`console: ${m.text()}`))
      page.on('pageerror', (e) => errors.add(`script error: ${e.message}`))
      const local = (url: string) => url.replace(served.origin, '.')
      page.on('requestfailed', (r) =>
        errors.add(`failed to load ${local(r.url())}: ${r.failure()?.errorText}`),
      )
      page.on(
        'response',
        (r) =>
          r.status() >= 400 &&
          errors.add(
            r.url().startsWith(served.origin)
              ? `missing file ${local(r.url())}`
              : `${r.status()} for ${r.url()}`,
          ),
      )
      await page.goto(`${served.origin}/${DESIGN_ENTRY}`, { waitUntil: 'load', timeout: 30_000 })
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined)
      // Strings: this file has no DOM types; they run in the page.
      await page.evaluate('document.fonts && document.fonts.ready').catch(() => undefined)
      return page
    }

    if (input.shots === false) {
      // Only the thumbnail.
    } else if (manifest?.kind === 'slides') {
      const page = await open(SIZES.desktop)
      const slides = (await page.$$('[data-slide]')).slice(0, MAX_SLIDES)
      if (slides.length === 0) errors.add('design.json says slides, but no element has data-slide')
      for (const [i, slide] of slides.entries()) {
        const file = join(input.out, `${name}-slide-${String(i + 1).padStart(2, '0')}.png`)
        await slide.screenshot({ path: file })
        result.screenshots.push(file)
      }
      await page.close()
    } else {
      const viewports = input.viewports?.length
        ? input.viewports
        : manifest?.viewports?.length
          ? manifest.viewports
          : (['desktop', 'mobile'] as DesignViewport[])
      for (const viewport of viewports) {
        const page = await open(SIZES[viewport])
        const height = (await page.evaluate('document.documentElement.scrollHeight')) as number
        const file = join(input.out, `${name}-${viewport}.png`)
        await page.screenshot({
          path: file,
          fullPage: height <= MAX_HEIGHT,
          ...(height > MAX_HEIGHT
            ? { clip: { x: 0, y: 0, width: SIZES[viewport].width, height: MAX_HEIGHT } }
            : {}),
        })
        if (height > MAX_HEIGHT)
          errors.add(
            `${viewport}: the page is ${height}px tall; the screenshot stops at ${MAX_HEIGHT}px`,
          )
        result.screenshots.push(file)
        await page.close()
      }
    }

    if (input.thumbnail) {
      // Half size: what the gallery shows.
      const page = await open(SIZES.desktop, 0.5)
      const file = join(input.out, 'thumbnail.png')
      const slide = manifest?.kind === 'slides' ? await page.$('[data-slide]') : null
      if (slide) await slide.screenshot({ path: file })
      else await page.screenshot({ path: file })
      result.thumbnail = file
      await page.close()
    }
  } finally {
    await browser.close()
    served.server.close()
  }
  result.errors = [...errors].slice(0, 30)
  return result
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
