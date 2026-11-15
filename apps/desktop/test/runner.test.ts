// The supervisor against fake runners: shell scripts in a home of their own, standing in for
// bin/brigade-runner and the API's install script.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { Supervisor, type Status } from '../src/runner.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'brigade-runner-'))
  process.env.BRIGADE_HOME = home
})

afterEach(() => {
  delete process.env.BRIGADE_HOME
})

/** bin/brigade-runner: `start` runs `body`; `link` writes runner.json as the real one does. */
function wrapper(body: string) {
  mkdirSync(join(home, 'bin'), { recursive: true })
  const file = join(home, 'bin', 'brigade-runner')
  writeFileSync(
    file,
    `#!/bin/sh
case "$1" in
  link) printf '{"workspaceName":"Acme","apiUrl":"%s","workspaceId":"ws_1"}' "$4" > "$BRIGADE_HOME/runner.json"; exit 0 ;;
  start) ${body} ;;
esac
`,
  )
  chmodSync(file, 0o755)
}

const linked = (dir = home) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'runner.json'),
    JSON.stringify({ workspaceName: 'Acme', apiUrl: 'https://api.test' }),
  )
}

function supervisor(extra: Partial<ConstructorParameters<typeof Supervisor>[0]> = {}) {
  const seen: Status[] = []
  const s = new Supervisor({
    onChange: (status) => seen.push(status),
    graceMs: 3_000,
    backoffMs: 50,
    runningElsewhere: async () => false,
    ...extra,
  })
  return { s, seen }
}

/** A file's lines, none while it is missing. */
const lines = (file: string) =>
  existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []

async function until(check: () => boolean, ms = 5_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await sleep(25)
  }
}

test('not connected without a runner or a link', async () => {
  const { s } = supervisor()
  await s.start()
  await until(() => s.status.kind === 'notConnected')
  wrapper('sleep 30')
  await s.start()
  await until(() => s.status.kind === 'notConnected')
})

test('runs the runner, and stops its whole group with SIGTERM', async () => {
  linked()
  // The wrapper and a child of its own, as node behind the real wrapper: both get the signal.
  wrapper(`echo $$ > "$BRIGADE_HOME/wrapper.pid"
trap 'echo term >> "$BRIGADE_HOME/signals"; exit 0' TERM
sh -c 'trap "echo child >> \\"$BRIGADE_HOME/signals\\"; exit 0" TERM; touch "$BRIGADE_HOME/child"; while :; do sleep 0.1; done' &
while :; do sleep 0.1; done`)
  const { s } = supervisor({ helper: '/Applications/Brigade.app/Contents/Resources/Helper.app' })
  await s.start()
  // Both traps set before the signal.
  await until(() => s.status.kind === 'running' && existsSync(join(home, 'child')))
  assert.deepEqual(s.status, { kind: 'running', workspace: 'Acme' })
  const group = readFileSync(join(home, 'desktop-runner.pgid'), 'utf8').trim()
  assert.equal(group, readFileSync(join(home, 'wrapper.pid'), 'utf8').trim())
  await s.stop()
  assert.equal(s.status.kind, 'stopped')
  await until(() => lines(join(home, 'signals')).length >= 2)
  assert.deepEqual(lines(join(home, 'signals')).sort(), ['child', 'term'])
  assert.ok(!existsSync(join(home, 'desktop-runner.pgid')))
})

test('gives the runner its home and the helper', async () => {
  linked()
  // Written whole, then moved in place: never read half written.
  wrapper(`env > "$BRIGADE_HOME/env.tmp"; mv "$BRIGADE_HOME/env.tmp" "$BRIGADE_HOME/env"; sleep 30`)
  const { s } = supervisor({ helper: '/x/Brigade Computer Use.app' })
  await s.start()
  await until(() => existsSync(join(home, 'env')))
  const env = readFileSync(join(home, 'env'), 'utf8')
  assert.match(env, new RegExp(`^BRIGADE_HOME=${home}$`, 'm'))
  assert.match(env, /^BRIGADE_COMPUTER_USE_APP=\/x\/Brigade Computer Use\.app$/m)
  assert.match(env, /^PATH=\/opt\/homebrew\/bin:/m)
  await s.stop()
})

test('starts a runner that exits again, and backs off', async () => {
  linked()
  wrapper(`echo run >> "$BRIGADE_HOME/runs"; exit 1`)
  const { s, seen } = supervisor()
  await s.start()
  await until(() => lines(join(home, 'runs')).length >= 3)
  await s.stop()
  assert.ok(seen.some((st) => st.kind === 'restarting' && st.reason === 'exited with code 1'))
  const runs = lines(join(home, 'runs')).length
  await sleep(300)
  // Stopped: no more starts.
  assert.equal(lines(join(home, 'runs')).length, runs)
})

test('a runner that finds another one running stays out', async () => {
  linked()
  wrapper('exit 3')
  const { s } = supervisor()
  await s.start()
  await until(() => s.status.kind === 'elsewhere')
})

test('one started elsewhere keeps it from starting', async () => {
  linked()
  wrapper('echo run >> "$BRIGADE_HOME/runs"; sleep 30')
  const { s } = supervisor({ runningElsewhere: async () => true })
  await s.start()
  await until(() => s.status.kind === 'elsewhere')
  assert.ok(!existsSync(join(home, 'runs')))
})

test('stops the runner an earlier run of the app left behind', async () => {
  linked()
  wrapper(`trap 'echo term >> "$BRIGADE_HOME/signals"; exit 0' TERM; while :; do sleep 0.1; done`)
  // A runner the app started before it was killed: its group, noted in desktop-runner.pgid.
  const left = spawn(join(home, 'bin', 'brigade-runner'), ['start'], {
    env: { ...process.env, BRIGADE_HOME: home },
    detached: true,
    stdio: 'ignore',
  })
  const gone = new Promise((resolve) => left.once('exit', resolve))
  writeFileSync(join(home, 'desktop-runner.pgid'), String(left.pid))
  await sleep(200)
  const { s } = supervisor()
  await s.start()
  await until(() => existsSync(join(home, 'signals')) && s.status.kind === 'running')
  await gone
  await s.stop()
})

test('connects: installs with the API script, links, then runs', async () => {
  // The API: install.sh writes the wrapper, as the real one does.
  const script = `#!/bin/sh
mkdir -p "$BRIGADE_INSTALL_DIR/bin"
cat > "$BRIGADE_INSTALL_DIR/bin/brigade-runner" <<'SH'
#!/bin/sh
case "$1" in
  link) [ "$2" = good ] || exit 1; printf '{"workspaceName":"Acme","apiUrl":"%s","workspaceId":"ws_1"}' "$4" > "$BRIGADE_HOME/runner.json" ;;
  start) sleep 30 ;;
esac
SH
chmod +x "$BRIGADE_INSTALL_DIR/bin/brigade-runner"
`
  const server = createServer((req, res) => {
    if (req.url === '/runner/install.sh') res.end(script)
    else res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const { s, seen } = supervisor()
    // An expired code: nothing linked, and the home made for it is gone.
    assert.match((await s.connect(api, 'expired', 'ws_1')) ?? '', /did not work/)
    assert.ok(!existsSync(join(home, 'runner.json')))
    assert.equal(await s.connect(api, 'good', 'ws_1'), undefined)
    assert.ok(seen.some((st) => st.kind === 'installing'))
    await until(() => s.status.kind === 'running')
    // A second workspace gets a home of its own, and becomes the one that runs.
    assert.equal(await s.connect(api, 'good', 'ws_2'), undefined)
    const active = readFileSync(join(home, 'active-workspace'), 'utf8')
    assert.match(active, /^w\d+$/)
    assert.ok(existsSync(join(home, 'workspaces', active, 'runner.json')))
    await until(() => s.status.kind === 'running')
    // And back.
    await s.switch('')
    assert.equal(readFileSync(join(home, 'active-workspace'), 'utf8'), '')
    await until(() => s.status.kind === 'running')
    await s.stop()
  } finally {
    server.close()
  }
})
