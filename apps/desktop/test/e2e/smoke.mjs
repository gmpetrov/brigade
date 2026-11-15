// Starts the packaged app (release/out/*-unpacked) against a stand-in dashboard and checks what
// a member relies on: the bridge in the dashboard's windows and nowhere else, the new thread
// window reading the draft's captures, the setup checklist, and a clean quit.
//   node test/e2e/smoke.mjs [path to the app's executable]
// On Linux without a display, run it under xvfb-run.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

// fileURLToPath, not .pathname: on Windows that would be /D:/….
const out = fileURLToPath(new URL('../../release/out/', import.meta.url))
function executable() {
  if (process.argv[2]) return process.argv[2]
  const dir = readdirSync(out).find((d) => d.endsWith('-unpacked') || d.startsWith('mac'))
  assert.ok(dir, `no packaged app in ${out}`)
  if (process.platform === 'darwin')
    return join(out, dir, 'Brigade.app', 'Contents', 'MacOS', 'brigade-desktop')
  return join(out, dir, process.platform === 'win32' ? 'Brigade.exe' : 'brigade-desktop')
}

// The stand-in dashboard: each page says what the bridge gives it.
const page = (
  title,
) => `<!doctype html><title>${title}</title><a id="out" href="https://example.com/">out</a>
<script>window.seen = { bridge: !!window.brigadeDesktop, info: window.brigadeDesktop?.info ?? null }</script>`
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html')
  res.end(page(req.url))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
// Another site, which must not get the bridge.
const other = createServer((_req, res) => res.end(page('other')))
await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve))
const otherOrigin = `http://localhost:${other.address().port}`

const home = mkdtempSync(join(tmpdir(), 'brigade-smoke-'))
mkdirSync(join(home, 'captures'), { recursive: true })
writeFileSync(join(home, 'captures', '1700000000000.png'), Buffer.from([137, 80, 78, 71]))
writeFileSync(join(home, 'captures', 'notes.txt'), 'not a capture')
writeFileSync(
  join(home, 'desktop.json'),
  JSON.stringify({ dashboardUrl: `${origin}/app`, loginSet: true }),
)

const app = await electron.launch({
  executablePath: executable(),
  env: {
    ...process.env,
    BRIGADE_HOME: home,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    BRIGADE_DESKTOP_TEST: '1',
  },
  timeout: 60_000,
})
const failures = []
// A hang is a failure too.
setTimeout(() => {
  console.error('FAIL timed out')
  app.process().kill('SIGKILL')
  process.exit(1)
}, 180_000).unref()
app.process().stderr?.on('data', (d) => process.stderr.write(d))
try {
  // The runner: nothing linked here.
  await waitFor(() => app.evaluate(() => globalThis.brigadeTest?.ctx.supervisor.status.kind))
  const status = await app.evaluate(() => globalThis.brigadeTest.ctx.supervisor.status.kind)
  const expected = process.platform === 'win32' ? 'unsupported' : 'notConnected'
  check('runner status', () => assert.equal(status, expected))

  // The new thread window: the dashboard's /app/capture, with the bridge and the draft.
  await app.evaluate(() => globalThis.brigadeTest.capture.show())
  const capture = await windowAt('/app/capture')
  const seen = await capture.evaluate(() => window.seen)
  check('capture bridge', () =>
    assert.deepEqual(
      { bridge: seen.bridge, window: seen.info?.window, platform: seen.info?.platform },
      { bridge: true, window: 'capture', platform: process.platform },
    ),
  )
  const names = await capture.evaluate(() => window.brigadeDesktop.captures.list())
  check('capture list', () => assert.deepEqual(names, ['1700000000000.png']))
  const bytes = await capture.evaluate(async () =>
    Array.from(await window.brigadeDesktop.captures.read('1700000000000.png')),
  )
  check('capture read', () => assert.deepEqual(bytes, [137, 80, 78, 71]))
  const escaped = await capture.evaluate(() =>
    window.brigadeDesktop.captures.read('../desktop.json').then(
      () => 'read',
      () => 'refused',
    ),
  )
  check('capture read outside the draft', () => assert.equal(escaped, 'refused'))

  // A link off the dashboard's site leaves the window where it is.
  await capture.click('#out', { noWaitAfter: true })
  await capture.waitForTimeout(1_000)
  check('navigation guard', () => assert.equal(new URL(capture.url()).origin, origin))

  // Closing hides it; the draft stays.
  await capture.evaluate(() => window.brigadeDesktop.captures.hide())
  const visible = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some(
      (w) => w.isVisible() && w.webContents.getURL().includes('/app/capture'),
    ),
  )
  check('capture hides', () => assert.equal(visible, false))

  // The dashboard window: the bridge, but not the draft.
  await app.evaluate(() => globalThis.brigadeTest.showDashboard())
  const main = await windowAt('/app', true)
  const mainSeen = await main.evaluate(() => window.seen)
  check('main bridge', () => assert.equal(mainSeen.info?.window, 'main'))
  const refused = await main.evaluate(() =>
    window.brigadeDesktop.captures.list().then(
      () => 'listed',
      () => 'refused',
    ),
  )
  check('main has no draft', () => assert.equal(refused, 'refused'))

  // An App's sign-in, done in the browser, comes back to the page that waits: once, and only
  // with the one-time value the app gave it.
  const nonce = await main.evaluate(() => {
    window.results = []
    window.brigadeDesktop.providerSignIn.onResult((r) => window.results.push(r))
    return window.brigadeDesktop.providerSignIn.start()
  })
  const signedIn = (value) =>
    app.evaluate(
      ({ app }, url) => app.emit('second-instance', {}, [url]),
      `brigade://signed-in?nonce=${value}&connected=conn_1`,
    )
  await signedIn('forged')
  await signedIn(nonce)
  await signedIn(nonce)
  await main.waitForTimeout(500)
  const results = await main.evaluate(() => window.results)
  check('provider sign-in comes back', () => assert.deepEqual(results, [{ connected: 'conn_1' }]))

  // Another site loaded in a window by the app itself still gets no bridge.
  await app.evaluate(({ BrowserWindow }, url) => {
    const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/app'))
    return w.loadURL(url)
  }, `${otherOrigin}/`)
  const otherSeen = await main.evaluate(() => window.seen)
  check('no bridge elsewhere', () => assert.equal(otherSeen.bridge, false))

  // The setup checklist, on the platforms that run teammates.
  if (process.platform !== 'win32') {
    await app.evaluate(() => globalThis.brigadeTest.setup.show())
    const setup = await windowAt('setup.html')
    await setup.waitForSelector('#steps li')
    const steps = await setup.$$eval('#steps li .title', (els) => els.map((e) => e.textContent))
    check('setup steps', () => assert.ok(steps.includes('Connected to a workspace'), steps.join()))
    const heading = await setup.textContent('h1')
    check('setup heading', () =>
      assert.equal(
        heading,
        `Get this ${process.platform === 'darwin' ? 'Mac' : 'computer'} ready for your teammates`,
      ),
    )
  }
} finally {
  // Quit as the menu does: the app ends by itself.
  const closed = new Promise((resolve) => app.process().once('exit', (code) => resolve(code)))
  // Not awaited: the app may end before it answers.
  app.evaluate(({ app }) => app.quit()).catch(() => {})
  const code = await Promise.race([
    closed,
    new Promise((r) => setTimeout(() => r('timeout'), 20_000)),
  ])
  check('quits', () => assert.notEqual(code, 'timeout'))
  if (code === 'timeout') app.process().kill('SIGKILL')
  server.close()
  other.close()
}

if (failures.length) {
  console.error(`\n${failures.length} failed:\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('\nAll checks passed.')
// Playwright's connection keeps Node up.
process.exit(0)

function check(name, assertion) {
  try {
    assertion()
    console.log(`ok   ${name}`)
  } catch (error) {
    console.log(`FAIL ${name}: ${error.message}`)
    failures.push(name)
  }
}

async function waitFor(get, ms = 20_000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await get().catch(() => undefined)
    if (value) return value
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** The page whose address ends with (or, `exact`, whose path is) `path`, once loaded. */
async function windowAt(path, exact = false) {
  const end = Date.now() + 30_000
  for (;;) {
    for (const w of app.windows()) {
      const url = w.url()
      const match = exact
        ? url.startsWith('http') && new URL(url).pathname === path
        : url.includes(path)
      if (match) {
        await w.waitForLoadState('load')
        if (!url.startsWith('http') || (await w.evaluate(() => !!window.seen).catch(() => false)))
          return w
      }
    }
    if (Date.now() > end) throw new Error(`no window at ${path}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}
