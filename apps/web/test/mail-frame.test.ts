// A mail's HTML in the Inbox's frame (lib/mail-html), in a real Chrome: nothing is fetched until
// its images are shown, whatever CSS names them, and the frame's height settles. Skipped where
// no Chrome is installed (CHROME_PATH, else /usr/bin/google-chrome).
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { after, before, describe, test } from 'node:test'
import { type Browser, chromium, type Page } from 'playwright-core'

const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome'
const skip = existsSync(CHROME) ? false : `no Chrome at ${CHROME}`
const SOURCE = stripTypeScriptTypes(
  readFileSync(new URL('../lib/mail-html.ts', import.meta.url), 'utf8'),
).replace(/^export /gm, '')
const THEME = { foreground: '#111', link: '#00f', font: 'sans-serif', scheme: 'light' }

let browser: Browser
let page: Page
let requests: string[] = []

/** Loads the mail's document in a frame as the Inbox does; what it fetched shows in `requests`. */
async function show(html: string, showImages: boolean) {
  requests = []
  await page.goto('about:blank')
  const result = await page.evaluate(
    async ({ source, html, showImages, theme }) => {
      const { mailDocument } = new Function(`${source};return { mailDocument }`)()
      const doc = mailDocument(html, {
        showImages,
        inline: new Map([['logo@sender', 'https://api.invalid/files/logo']]),
        theme,
      })
      const frame = document.createElement('iframe')
      frame.sandbox.add('allow-same-origin', 'allow-popups', 'allow-popups-to-escape-sandbox')
      const loaded = new Promise((resolve) => (frame.onload = resolve))
      frame.srcdoc = doc.html
      document.body.append(frame)
      await loaded
      return { images: doc.images as boolean }
    },
    { source: SOURCE, html, showImages, theme: THEME },
  )
  await page.waitForTimeout(300)
  return result
}

/** The heights the frame takes over a moment, sized by followHeight from 96px. */
async function heights(html: string) {
  await page.goto('about:blank')
  return page.evaluate(
    async ({ source, html, theme }) => {
      const { mailDocument, followHeight } = new Function(
        `${source};return { mailDocument, followHeight }`,
      )()
      const doc = mailDocument(html, { showImages: false, inline: new Map(), theme })
      const frame = document.createElement('iframe')
      frame.style.height = '96px'
      frame.style.width = '600px'
      frame.sandbox.add('allow-same-origin')
      const loaded = new Promise((resolve) => (frame.onload = resolve))
      frame.srcdoc = doc.html
      document.body.append(frame)
      await loaded
      const seen: number[] = []
      const stop = followHeight(frame, (height: number) => {
        seen.push(height)
        frame.style.height = `${height}px`
      })
      await new Promise((resolve) => setTimeout(resolve, 1500))
      stop()
      return seen
    },
    { source: SOURCE, html, theme: THEME },
  )
}

describe('the mail frame', { skip }, () => {
  before(async () => {
    browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox'],
    })
    page = await browser.newPage()
    await page.route(/^https:\/\/(tracker|api)\.invalid\//, async (route) => {
      requests.push(route.request().url())
      await route.fulfill({ status: 200, contentType: 'image/png', body: '' })
    })
  })
  after(() => browser?.close())

  const TRACKERS =
    `<div style="width:30px;height:30px;background-image:image-set('https://tracker.invalid/set.png' 1x)">a</div>` +
    `<div style="width:30px;height:30px;background:url(\\68ttps://tracker.invalid/escaped.png)">b</div>` +
    `<style>p{background:url(https://tracker.invalid/style.png)}</style><p>c</p>` +
    `<img src="https://tracker.invalid/img.png"><img src="cid:logo@sender">`

  test('nothing is fetched before its images are shown, however its CSS names them', async () => {
    const { images } = await show(TRACKERS, false)
    assert.equal(images, true)
    assert.deepEqual(requests, [])
  })

  test('shown, its images come, the files it carries from the API', async () => {
    await show(TRACKERS, true)
    assert.ok(requests.includes('https://tracker.invalid/img.png'), requests.join(', '))
    assert.ok(requests.includes('https://tracker.invalid/set.png'), requests.join(', '))
    assert.ok(requests.includes('https://api.invalid/files/logo'), requests.join(', '))
  })

  test('a mail with no image says so', async () => {
    assert.equal((await show('<p>Hello</p>', false)).images, false)
  })

  test('a height of 100% settles at its content', async () => {
    const seen = await heights('<style>html,body{height:100%}</style><p>Hello</p>')
    assert.ok(seen.length <= 2, seen.join(', '))
    assert.ok(seen.at(-1)! < 96, seen.join(', '))
  })

  test('a document that grows with its frame stops growing', async () => {
    const seen = await heights('<div style="height:calc(100vh + 15px)">Hello</div>')
    assert.ok(seen.length <= 14, seen.join(', '))
    assert.ok(seen.at(-1)! < 1000, seen.join(', '))
  })

  test('a long mail gets its whole height', async () => {
    const seen = await heights('<p>Line</p>'.repeat(60))
    assert.ok(seen.at(-1)! > 1000, seen.join(', '))
  })
})
