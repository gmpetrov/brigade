// Starts the packaged app (release/out/*-unpacked) against a stand-in dashboard and checks what
// a member relies on: the bridge in the dashboard's windows and nowhere else, the new thread
// window reading the draft's captures, the setup checklist, and a clean quit.
//   node test/e2e/smoke.mjs [path to the app's executable]
// On Linux without a display, run it under xvfb-run.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
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
// Its API, for Brigade.app's own notifications: what the app fetched and removed, with which token.
const apiCalls = []
const server = createServer((req, res) => {
  if (req.url.startsWith('/api/desktop-notifications')) {
    apiCalls.push({ method: req.method, auth: req.headers.authorization })
    res.setHeader('content-type', 'application/json')
    if (req.method === 'DELETE') return res.writeHead(204).end()
    const message = {
      title: 'Sam has a question',
      body: 'Ship it?',
      url: '/app/threads/t1',
      tag: 't1',
      badge: 1,
    }
    return res.end(JSON.stringify({ messages: [message] }))
  }
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
/** The last check that ran: where a hang happened. */
let lastCheck = 'the launch'
// A hang is a failure too.
setTimeout(() => {
  fail('timed out', new Error(`after "${lastCheck}"`))
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

  // macOS: a Dock icon from the start, before any window opens, as for any Mac app (0.4.4 had one
  // only while the dashboard was open).
  if (process.platform === 'darwin') {
    const dock = await app.evaluate(({ app }) => app.dock?.isVisible())
    check('Dock icon without a window', () => assert.equal(dock, true))
  }

  // macOS: the app menu holds what the menu-bar menu does, as on a Mac (menu.ts).
  if (process.platform === 'darwin') {
    const menus = await app.evaluate(({ Menu }) =>
      Object.fromEntries(
        Menu.getApplicationMenu().items.map((m) => [
          m.label,
          m.submenu?.items.filter((i) => i.type !== 'separator').map((i) => i.label) ?? [],
        ]),
      ),
    )
    check('app menu', () => {
      assert.deepEqual(Object.keys(menus), ['Brigade', 'File', 'Edit', 'View', 'Window'])
      for (const item of ['Check for Updates…', 'Open at Login', 'Keep Screen Awake', 'Shortcuts'])
        assert.ok(menus.Brigade.includes(item), `Brigade › ${item}`)
      for (const item of ['Restart Runner', 'Show Logs', 'Close Window', 'Quit Brigade'])
        assert.ok(menus.Brigade.includes(item), `Brigade › ${item}`)
      for (const item of ['New Thread', 'Open Dashboard', 'Open in Browser'])
        assert.ok(menus.File.includes(item), `File › ${item}`)
    })
  }

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
  // No title bar on macOS and Windows; the desktop's own on Linux. The new thread window has none.
  const frames = { darwin: 'mac', win32: 'overlay', linux: 'native' }
  check('main frame', () => assert.equal(mainSeen.info?.frame, frames[process.platform]))
  check('capture has no frame info', () => assert.equal(seen.info?.frame, undefined))
  // The dashboard sits in a view below the band for the window's buttons: 32px on Windows,
  // none elsewhere (macOS's band shows only on a narrow page).
  const top = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((w) => w.contentView.children.length > 0)
    return window?.contentView.children[0]?.getBounds().y
  })
  check('dashboard view below the band', () =>
    assert.equal(top, process.platform === 'win32' ? 32 : 0),
  )
  // Only the band above the view moves the window: a drag area under the view takes its clicks
  // on macOS (0.4.2: nothing in the dashboard could be clicked).
  const host = app.windows().find((w) => w.url().endsWith('window.html'))
  // Its height follows the view: a timeout here still reports what it found, below.
  await waitFor(() =>
    host.evaluate((top) => getComputedStyle(band).height === `${top}px`, top).catch(() => false),
  ).catch(() => {})
  const drag = await host.evaluate(() => {
    const region = (el) =>
      ['app-region', '-webkit-app-region'].some(
        (p) => getComputedStyle(el).getPropertyValue(p) === 'drag',
      )
    return {
      body: region(document.body),
      band: region(band),
      height: getComputedStyle(band).height,
    }
  })
  check('window drags only above the view', () =>
    assert.deepEqual(drag, { body: false, band: true, height: `${top}px` }),
  )
  const refused = await main.evaluate(() =>
    window.brigadeDesktop.captures.list().then(
      () => 'listed',
      () => 'refused',
    ),
  )
  check('main has no draft', () => assert.equal(refused, 'refused'))

  // ⌘F (Ctrl+F) in the dashboard opens the find bar over it, which finds as the person types and
  // closes on Esc (find.ts).
  const findShown = () => app.evaluate(() => globalThis.brigadeTest.find.findOpen())
  await main.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
  const opened = await waitFor(findShown, 5_000).catch(() => false)
  check('find bar opens', () => assert.equal(opened, true))
  const bar = await waitFor(async () => app.windows().find((w) => w.url().endsWith('find.html')))
  await bar.waitForLoadState('load')
  await bar.fill('#text', 'out')
  const count = await waitFor(
    () => bar.evaluate(() => document.getElementById('count').textContent),
    5_000,
  ).catch(() => '')
  check('find bar finds in the page', () => assert.equal(count, '1/1'))
  await bar.keyboard.press('Escape')
  const closed = await waitFor(async () => !(await findShown()), 5_000).catch(() => false)
  check('find bar closes', () => assert.equal(closed, true))
  // Esc closes it from the dashboard's page too, once the person clicked back into it.
  await main.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
  await waitFor(findShown, 5_000).catch(() => {})
  await main.bringToFront()
  await main.keyboard.press('Escape')
  const closedFromPage = await waitFor(async () => !(await findShown()), 5_000).catch(() => false)
  check('find bar closes on Esc in the page', () => assert.equal(closedFromPage, true))

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

  // Whether the person looks at it, as the window says (notifications wait meanwhile).
  const focus = await main.evaluate(() => typeof window.brigadeDesktop.focus.focused())
  check('window focus told to the page', () => assert.equal(focus, 'boolean'))

  // Brigade.app's own notifications: turned on from the dashboard with the device the API made,
  // fetched with its token, shown on the dashboard's site only, and turned off again.
  const notifications = await main.evaluate(() => window.brigadeDesktop.notifications.status())
  check('notifications off at first', () => assert.equal(notifications.on, false))
  await main.evaluate(
    (api) =>
      window.brigadeDesktop.notifications.enable({ api, deviceId: 'device_1', token: 'token_1' }),
    origin,
  )
  await waitFor(async () => apiCalls.some((c) => c.method === 'GET' && c.auth === 'Bearer token_1'))
  const on = await main.evaluate(() => window.brigadeDesktop.notifications.status())
  check('notifications fetched with the device token', () => assert.equal(on.on, true))
  const deviceFile = join(home, 'notifications.json')
  check('the device kept for its person alone', () => {
    assert.ok(existsSync(deviceFile))
    if (process.platform !== 'win32') assert.equal(statSync(deviceFile).mode & 0o777, 0o600)
  })
  const targets = await app.evaluate(() => [
    globalThis.brigadeTest.notifications.target('/app/threads/t1?workspace=w1'),
    globalThis.brigadeTest.notifications.target('https://elsewhere.example/app'),
  ])
  check('a notification opens the dashboard only', () =>
    assert.deepEqual(targets, [`${origin}/app/threads/t1?workspace=w1`, `${origin}/app`]),
  )
  const refusedApi = await main.evaluate(() =>
    window.brigadeDesktop.notifications
      .enable({ api: 'http://example.com', deviceId: 'd', token: 't' })
      .then(
        () => 'enabled',
        () => 'refused',
      ),
  )
  check('notifications from an API over http refused', () => assert.equal(refusedApi, 'refused'))
  const removed = await main.evaluate(() => window.brigadeDesktop.notifications.disable())
  check('notifications turned off', () => {
    assert.equal(removed, 'device_1')
    assert.ok(apiCalls.some((c) => c.method === 'DELETE' && c.auth === 'Bearer token_1'))
    assert.ok(!existsSync(deviceFile))
  })

  // Another site loaded in a window by the app itself still gets no bridge.
  // The dashboard is a view in its window (windows.ts): found among all pages.
  await app.evaluate(({ webContents }, url) => {
    const page = webContents.getAllWebContents().find((c) => c.getURL().endsWith('/app'))
    return page.loadURL(url)
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

  // Closing the dashboard window asks its page first (the window itself only holds the band):
  // unsaved edits keep it open, unless the person discards them.
  await app.evaluate(() => globalThis.brigadeTest.showDashboard())
  await waitFor(() => main.evaluate(() => !!window.seen?.bridge))
  await main.evaluate(() => addEventListener('beforeunload', (event) => event.preventDefault()))
  // Chromium honours beforeunload only on a page the person used.
  await main.mouse.click(200, 200)
  const answer = (response) =>
    app.evaluate(({ dialog }, response) => {
      globalThis.asked ??= 0
      dialog.showMessageBox = async () => {
        globalThis.asked++
        return { response, checkboxChecked: false }
      }
    }, response)
  const closeMain = () => app.evaluate(() => globalThis.brigadeTest.dashboardWindow()?.close())
  const mainOpen = () => app.evaluate(() => !!globalThis.brigadeTest.dashboardWindow())
  const asked = () => app.evaluate(() => globalThis.asked ?? 0)
  await answer(1)
  await closeMain()
  await waitFor(asked)
  await main.waitForTimeout(500)
  const kept = await mainOpen()
  check('unsaved edits kept: the window stays', () => assert.equal(kept, true))
  check('unsaved edits kept: the page stays', () => assert.equal(main.isClosed(), false))
  await answer(0)
  await closeMain()
  await waitFor(async () => !(await mainOpen()))
  const timesAsked = await asked()
  check('unsaved edits discarded: the window closes', () => assert.equal(timesAsked, 2))
  // Nothing unsaved: it closes without a question.
  await app.evaluate(() => globalThis.brigadeTest.showDashboard())
  await waitFor(() => mainOpen())
  await waitFor(() =>
    app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().some((c) => c.getURL().endsWith('/app') && !c.isLoading()),
    ),
  )
  await closeMain()
  await waitFor(async () => !(await mainOpen()))
  const askedAfter = await asked()
  check('closes without a question', () => assert.equal(askedAfter, 2))
} catch (error) {
  // A step that threw: the checks after it never ran.
  fail('the run stopped', error)
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
  lastCheck = name
  try {
    assertion()
    console.log(`ok   ${name}`)
  } catch (error) {
    fail(name, error)
  }
}

/** A failure, also as an annotation on the job in GitHub Actions: its log needs admin rights. */
function fail(name, error) {
  console.log(`FAIL ${name}: ${error.message}`)
  failures.push(name)
  if (process.env.GITHUB_ACTIONS)
    console.log(
      `::error title=Smoke test (${process.platform})::${name}: ${error.message}`.replace(
        /\r?\n/g,
        '%0A',
      ),
    )
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
