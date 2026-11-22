import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  agentDesktopBinary,
  binaryIn,
  DesktopError,
  desktopCall,
  parseEnvelope,
  renderTree,
  shellQuote,
  type DesktopExec,
  type DesktopNode,
} from '../src/agent-desktop.js'
import { ComputerUseError, type RequestOptions } from '../src/computer-use.js'
import {
  actArgs,
  actEntry,
  desktopTools,
  macAppInput,
  macDesktopExec,
  pickWindow,
  snapshotArgs,
  snapshotEntry,
  xdotoolKey,
  type Desktop,
  type Keyboard,
} from '../src/harness/desktop-tools.js'
import type { ComputerUse } from '../src/harness/tools.js'

const options = (abortSignal?: AbortSignal) =>
  ({ toolCallId: 'call-1', messages: [], abortSignal }) as never

const envelope = (data: unknown) => JSON.stringify({ version: '2.6', ok: true, data })
const refusal = (code: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: '2.6',
    ok: false,
    error: { code, message: `${code} message`, ...extra },
  })

/** An exec that answers each command from `answer`, and keeps what it was asked. */
function fakeExec(answer: (args: string[], stdin?: string) => string) {
  const calls: { args: string[]; stdin?: string }[] = []
  const exec: DesktopExec = async (args, opts = {}) => {
    calls.push({ args, ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}) })
    return answer(args, opts.stdin)
  }
  return { exec, calls }
}

function fakeKeyboard() {
  const typed: string[] = []
  const keys: string[] = []
  const keyboard: Keyboard = {
    type: async (text) => void typed.push(text),
    key: async (combo) => void keys.push(combo),
  }
  return { keyboard, typed, keys }
}

const TREE: DesktopNode = {
  role: 'window',
  name: 'Sign in',
  children: [
    {
      role: 'textfield',
      name: 'Username',
      ref_id: '@s1:e1',
      states: ['focused'],
      available_actions: ['Click', 'RightClick', 'SetFocus'],
    },
    { role: 'button', name: 'Restore', ref_id: '@s1:e2', states: ['hidden'] },
    {
      role: 'group',
      children: [
        {
          role: 'textfield',
          name: 'Address and search bar',
          value: 'example.com',
          placeholder: 'Search Google or type a URL',
          ref_id: '@s1:e3',
          available_actions: ['Click'],
        },
      ],
    },
    { role: 'list', ref_id: '@s1:e4', children_count: 12 },
  ],
}

test('a tree is a line an element, without what is hidden, with refs and what each can do', () => {
  const { text, left, hidden } = renderTree(TREE)
  assert.equal(
    text,
    [
      'window "Sign in"',
      '  textfield "Username" [focused] @s1:e1 {click, right_click, set_focus}',
      '  group',
      '    textfield "Address and search bar" = "example.com" placeholder "Search Google or type a URL" @s1:e3 {click}',
      '  list @s1:e4 (12 inside)',
    ].join('\n'),
  )
  assert.equal(left, 0)
  assert.equal(hidden, 1)
  assert.match(renderTree(TREE, { hidden: true }).text, /button "Restore" @s1:e2/)
})

test('a tree past its size stops and says how many elements it left out', () => {
  const big: DesktopNode = {
    role: 'list',
    children: Array.from({ length: 100 }, (_, i) => ({
      role: 'listitem',
      name: `Item ${i}`,
      ref_id: `@s1:e${i}`,
    })),
  }
  const { text, left } = renderTree(big, { max: 300, children: Number.POSITIVE_INFINITY })
  assert.ok(text.length <= 300)
  assert.ok(left > 80)
  assert.equal(text.split('\n').length + left, 101)
})

test('long names are cut, and newlines in them do not break the tree', () => {
  const { text } = renderTree({ role: 'text', name: `a\nb ${'x'.repeat(400)}` })
  assert.equal(text.split('\n').length, 1)
  assert.ok(text.length < 200)
  assert.match(text, /^text "a b x+…"$/)
})

test('the envelope is read even after a notice line, and anything else is an error', () => {
  assert.equal(parseEnvelope(envelope({ a: 1 })).ok, true)
  assert.equal(parseEnvelope(`agent-desktop: a notice\n${envelope({ a: 1 })}\n`).ok, true)
  assert.throws(() => parseEnvelope(''), /printed no answer/)
  assert.throws(() => parseEnvelope('Segmentation fault'), /printed no answer: Segmentation fault/)
  assert.throws(() => parseEnvelope('{"hello":1}'), /unexpected answer/)
})

test("a refusal carries agent-desktop's code, words and suggestion, and warns when it may have happened", async () => {
  const { exec } = fakeExec(() =>
    refusal('ACTION_FAILED', {
      suggestion: 'Take a snapshot',
      disposition: { retry: 'unsafe' },
      details: { why: 1 },
    }),
  )
  await assert.rejects(desktopCall(exec, ['click', '@s1:e1']), (error: unknown) => {
    assert.ok(error instanceof DesktopError)
    assert.equal(error.code, 'ACTION_FAILED')
    assert.deepEqual(error.details, { why: 1 })
    assert.equal(
      error.message,
      'ACTION_FAILED: ACTION_FAILED message. Take a snapshot. It may have happened anyway: look before you try again.',
    )
    return true
  })
  // A suggestion that ends its own sentence is not given a second period.
  const { exec: ended } = fakeExec(() => refusal('STALE_REF', { suggestion: 'Snapshot again.' }))
  await assert.rejects(desktopCall(ended, ['click']), (error: unknown) => {
    assert.equal((error as Error).message, 'STALE_REF: STALE_REF message. Snapshot again.')
    return true
  })
})

test('text to type goes through stdin, never in the arguments', () => {
  const secret = 'hunter2 && rm -rf /'
  const typed = actArgs({ ref: '@s1:e1', action: 'type', text: secret })
  assert.deepEqual(typed, { args: ['type', '@s1:e1', '--stdin'], stdin: secret })
  assert.ok(!typed.args.includes(secret))
  assert.deepEqual(actArgs({ ref: '@s1:e1', action: 'set_value', text: '' }), {
    args: ['set-value', '@s1:e1', '--stdin'],
    stdin: '',
  })
  assert.throws(() => actArgs({ ref: '@s1:e1', action: 'type' }), /text is required/)
})

test('each action becomes its command, headed in front when asked', () => {
  assert.deepEqual(actArgs({ ref: '@s1:e1', action: 'right_click' }).args, [
    'right-click',
    '@s1:e1',
  ])
  assert.deepEqual(actArgs({ ref: '@s1:e1', action: 'scroll_to', headed: true }).args, [
    '--headed',
    'scroll-to',
    '@s1:e1',
  ])
  assert.deepEqual(actArgs({ ref: '@s1:e1', action: 'select', option: 'France' }).args, [
    'select',
    '@s1:e1',
    'France',
  ])
  assert.throws(() => actArgs({ ref: '@s1:e1', action: 'select' }), /option is required/)
  assert.deepEqual(actArgs({ ref: '@s1:e1', action: 'scroll', amount: 999 }).args, [
    'scroll',
    '@s1:e1',
    '--direction',
    'down',
    '--amount',
    '50',
  ])
})

test("a snapshot reads the app asked for; on a cloud computer the teammate's browser by default", () => {
  assert.deepEqual(snapshotArgs({}, 'mac'), ['snapshot', '-i', '--compact', '--timeout-ms', '8000'])
  assert.deepEqual(snapshotArgs({}, 'cloud'), [
    'snapshot',
    '--app',
    'chrome',
    '-i',
    '--compact',
    '--timeout-ms',
    '8000',
  ])
  assert.deepEqual(
    snapshotArgs(
      { window: 'w-1', root: '@s1:e3', skeleton: true, all: true, surface: 'sheet', maxDepth: 3 },
      'cloud',
    ),
    [
      'snapshot',
      '--window-id',
      'w-1',
      '--compact',
      '--root',
      '@s1:e3',
      '--skeleton',
      // A root names its element already: agent-desktop refuses a surface beside it.
      '--max-depth',
      '3',
      '--timeout-ms',
      '8000',
    ],
  )
  assert.deepEqual(snapshotArgs({ app: 'Notes', surface: 'window' }, 'mac').slice(0, 3), [
    'snapshot',
    '--app',
    'Notes',
  ])
})

test("keys become xdotool's names, and anything else is refused", () => {
  assert.equal(xdotoolKey('ctrl+shift+t'), 'ctrl+shift+t')
  assert.equal(xdotoolKey('Escape'), 'Escape')
  assert.equal(xdotoolKey('return'), 'Return')
  assert.equal(xdotoolKey('cmd+L'), 'super+l')
  assert.equal(xdotoolKey('f5'), 'F5')
  assert.equal(xdotoolKey('ctrl+-'), 'ctrl+minus')
  assert.equal(xdotoolKey(' pagedown '), 'Next')
  assert.throws(() => xdotoolKey('ctrl+nope'), /Not a key: "nope"/)
  assert.throws(() => xdotoolKey('ctrl+'), /Not a key/)
  assert.throws(() => xdotoolKey('$(reboot)'), /Not a key/)
})

test("the window read in the teammate's browser: the one in front, else its biggest, the others listed", () => {
  const windows = [
    {
      id: 'w-1',
      title: 'Riley browser - Chromium',
      is_focused: false,
      bounds: { width: 900, height: 900 },
    },
    { id: 'w-2', title: '', is_focused: true, bounds: { width: 300, height: 40 } },
    { id: 'w-3', title: 'Save password?', is_focused: false, bounds: { width: 400, height: 300 } },
    { id: 'w-4', title: 'Old', minimized: true, bounds: { width: 2000, height: 2000 } },
  ]
  assert.deepEqual(pickWindow(windows), {
    chosen: 'w-1',
    others: [{ id: 'w-3', title: 'Save password?' }],
  })
  assert.equal(
    pickWindow([...windows, { id: 'w-5', title: 'Sign in', is_focused: true }]).chosen,
    'w-5',
  )
  assert.deepEqual(pickWindow([{ id: 'w-2', title: '' }]), { chosen: 'w-2', others: [] })
  assert.deepEqual(pickWindow([]), { chosen: undefined, others: [] })
})

const cloud = (exec: DesktopExec, keyboard?: Keyboard, ready?: Desktop['ready']): Desktop => ({
  exec,
  where: 'cloud',
  ...(keyboard ? { keyboard } : {}),
  ...(ready ? { ready } : {}),
})

test("on a cloud computer, a snapshot reads the browser's window in front and lists the others", async () => {
  let started = 0
  const { exec, calls } = fakeExec((args) =>
    args[0] === 'list-windows'
      ? envelope([
          { id: 'w-1', title: 'Riley browser - Chromium', is_focused: true },
          { id: 'w-9', title: 'Save password?' },
        ])
      : envelope({ app: 'chrome', snapshot_id: 's1', complete: true, tree: TREE }),
  )
  const tools = desktopTools(cloud(exec, undefined, async () => void started++))
  const result = (await tools.computer_snapshot!.execute!({}, options())) as Record<string, unknown>
  assert.deepEqual(calls[0]!.args, ['list-windows', '--app', 'chrome'])
  assert.deepEqual(calls[1]!.args.slice(0, 3), ['snapshot', '--window-id', 'w-1'])
  assert.equal(result.window, 'w-1')
  assert.deepEqual(result.otherWindows, [{ id: 'w-9', title: 'Save password?' }])
  assert.equal(result.snapshot, 's1')
  assert.match(String(result.tree), /textfield "Username"/)
  assert.equal(started, 2)
  // A window named: read as it is, nothing listed first.
  calls.length = 0
  await tools.computer_snapshot!.execute!({ window: 'w-9' }, options())
  assert.deepEqual(
    calls.map((c) => c.args[0]),
    ['snapshot'],
  )
})

test('a snapshot that matched several windows says which to pick', async () => {
  const { exec } = fakeExec(() =>
    refusal('AMBIGUOUS_TARGET', {
      details: {
        candidates: [
          { window_id: 'w-1', title: 'Notes' },
          { window_id: 'w-2', title: 'Notes 2' },
        ],
      },
    }),
  )
  await assert.rejects(
    desktopTools({ exec, where: 'mac' }).computer_snapshot!.execute!(
      { app: 'Notes' },
      options(),
    ) as Promise<unknown>,
    /Windows \(pass one as window\): w-1 "Notes"; w-2 "Notes 2"/,
  )
})

test('on a cloud computer, a browser that is not on its accessibility bus yet is explained', async () => {
  const { exec } = fakeExec((args) =>
    args[0] === 'list-windows' ? envelope([]) : refusal('APP_NOT_FOUND'),
  )
  await assert.rejects(
    desktopTools(cloud(exec)).computer_snapshot!.execute!({}, options()) as Promise<unknown>,
    /after its next start/,
  )
})

test('on a cloud computer, text a field takes no other way goes in with the keyboard, after a click on it', async () => {
  const { keyboard, typed, keys } = fakeKeyboard()
  const { exec, calls } = fakeExec((args) =>
    args[0] === 'type' || args[0] === 'set-value'
      ? refusal('POLICY_DENIED')
      : envelope({ disposition: { delivery: 'delivered_unverified' } }),
  )
  const tools = desktopTools(cloud(exec, keyboard))
  const result = await tools.computer_act!.execute!(
    { ref: '@s1:e1', action: 'type', text: 'usr' },
    options(),
  )
  assert.deepEqual(result, {
    action: 'type',
    delivery: 'typed_with_keyboard',
    check: 'Take a new snapshot to check the field (a password field shows no value).',
  })
  assert.deepEqual(
    calls.map((c) => c.args),
    [
      ['type', '@s1:e1', '--stdin'],
      ['click', '@s1:e1'],
    ],
  )
  assert.deepEqual(typed, ['usr'])
  assert.deepEqual(keys, [])
  // set_value replaces what was there: selected first.
  await tools.computer_act!.execute!(
    { ref: '@s1:e2', action: 'set_value', text: 'example.org' },
    options(),
  )
  assert.deepEqual(keys, ['ctrl+a'])
  assert.deepEqual(typed, ['usr', 'example.org'])
})

test('other refusals are not typed around, and a Mac has no keyboard fallback', async () => {
  const { keyboard, typed } = fakeKeyboard()
  const { exec } = fakeExec(() => refusal('STALE_REF'))
  await assert.rejects(
    desktopTools(cloud(exec, keyboard)).computer_act!.execute!(
      { ref: '@s1:e1', action: 'type', text: 'x' },
      options(),
    ) as Promise<unknown>,
    /STALE_REF/,
  )
  const denied = fakeExec(() => refusal('POLICY_DENIED'))
  await assert.rejects(
    desktopTools({ exec: denied.exec, where: 'mac' }).computer_act!.execute!(
      { ref: '@s1:e1', action: 'type', text: 'x' },
      options(),
    ) as Promise<unknown>,
    /POLICY_DENIED/,
  )
  assert.deepEqual(typed, [])
})

test('an action says how it was delivered and what it left open', async () => {
  const { exec } = fakeExec(() =>
    envelope({
      disposition: { delivery: 'delivered_verified' },
      steps: [{ label: 'Action.DoAction' }],
      surfaces: [{ id: 'w-1', title: 'Menu', type: 'menu' }],
    }),
  )
  assert.deepEqual(
    await desktopTools({ exec, where: 'mac' }).computer_act!.execute!(
      { ref: '@s1:e1', action: 'click' },
      options(),
    ),
    {
      action: 'click',
      delivery: 'delivered_verified',
      open: [{ type: 'menu', title: 'Menu', window: 'w-1' }],
      // Its snapshot was not taken in this turn: nothing to read again after it.
      check: 'Take a new snapshot to check it worked.',
    },
  )
})

test('on a cloud computer: no headed input, no double click, and a key tool', async () => {
  const { keyboard, keys } = fakeKeyboard()
  const { exec, calls } = fakeExec(() => envelope({}))
  const tools = desktopTools(cloud(exec, keyboard))
  const schema = (
    tools.computer_act!.inputSchema as {
      jsonSchema: { properties: Record<string, { enum?: string[] }> }
    }
  ).jsonSchema
  assert.equal(schema.properties.headed, undefined)
  assert.ok(!schema.properties.action!.enum!.includes('double_click'))
  await tools.computer_act!.execute!({ ref: '@s1:e1', action: 'click', headed: true }, options())
  assert.deepEqual(calls[0]!.args, ['click', '@s1:e1'])
  assert.deepEqual(await tools.computer_key!.execute!({ key: 'ctrl+l' }, options()), {
    pressed: 'ctrl+l',
  })
  assert.deepEqual(keys, ['ctrl+l'])
  // On a Mac, keys stay computer_key's own (tools.ts): none here.
  assert.equal(desktopTools({ exec, where: 'mac' }).computer_key, undefined)
  const mac = (
    desktopTools({ exec, where: 'mac' }).computer_act!.inputSchema as {
      jsonSchema: { properties: Record<string, unknown> }
    }
  ).jsonSchema
  assert.ok(mac.properties.headed)
})

type Call = { method: string; params: Record<string, unknown>; options?: RequestOptions }

/** A Brigade Computer Use that runs a command as a shell would, for what it writes and reads. */
function fakeComputer(run: (command: string) => Promise<Record<string, unknown>>) {
  const calls: Call[] = []
  const computer: ComputerUse = {
    request: async (method, params, _signal, opts) => {
      calls.push({ method, params, ...(opts ? { options: opts } : {}) })
      if (method === 'run') return run(params.command as string)
      return { ok: true }
    },
    workDir: '/work/thread',
    env: () => ({ PATH: '/usr/bin' }),
    screenshotPath: () => ({ path: 'images/x.png', absolute: '/work/thread/images/x.png' }),
    share: () => undefined,
    seen: () => undefined,
    acted: () => undefined,
  }
  return { computer, calls }
}

/** The files a command line redirects to and from: <in >out 2>err. */
const redirects = (command: string) => {
  const unquote = (word: string) => word.slice(1, -1).replace(/'\\''/g, "'")
  const match = / <('(?:[^']|'\\'')*') >('(?:[^']|'\\'')*') 2>('(?:[^']|'\\'')*')$/.exec(command)
  assert.ok(match, command)
  return { input: unquote(match[1]!), out: unquote(match[2]!), err: unquote(match[3]!) }
}

test('on a Mac, agent-desktop runs through Brigade Computer Use, its answer and text through files', async () => {
  const binary = {
    path: "/Users/ada/.brigade/runner/it's/agent-desktop-darwin-arm64",
    macosHelper: '/h/helper',
  }
  let seenInput = ''
  const { computer, calls } = fakeComputer(async (command) => {
    const { input, out } = redirects(command)
    seenInput = readFileSync(input, 'utf8')
    writeFileSync(out, envelope({ ok: 1 }))
    return { exitCode: 0, output: '' }
  })
  const exec = macDesktopExec(computer, async () => binary)
  const out = await exec(['type', '@s1:e1', '--stdin'], { stdin: 'pa$$ word' })
  assert.deepEqual(JSON.parse(out).data, { ok: 1 })
  assert.equal(seenInput, 'pa$$ word')
  const call = calls[0]!
  assert.equal(call.method, 'run')
  assert.equal(
    (call.params.command as string).split(' <')[0],
    `exec ${shellQuote(binary.path)} 'type' '@s1:e1' '--stdin'`,
  )
  assert.ok(!(call.params.command as string).includes('pa$$ word'))
  assert.equal(call.params.cwd, '/work/thread')
  assert.deepEqual(call.params.env, {
    PATH: '/usr/bin',
    AGENT_DESKTOP_MACOS_HELPER_PATH: '/h/helper',
  })
  assert.equal(call.params.timeout, 90)
  assert.deepEqual(call.options, { wait: 120_000, once: true })
  // Its files are gone once it answered.
  const { input } = redirects(call.params.command as string)
  assert.equal(existsSync(input), false)
  // Nothing to type: its stdin is empty.
  await exec(['snapshot'])
  assert.equal(redirects(calls[1]!.params.command as string).input, '/dev/null')
})

test('on a Mac: no answer is an error with what it printed, and an old helper asks for an update', async () => {
  const quiet = fakeComputer(async (command) => {
    writeFileSync(redirects(command).err, 'dyld: Library not loaded')
    return { exitCode: 134, output: '' }
  })
  await assert.rejects(
    macDesktopExec(quiet.computer, async () => ({ path: '/b' }))(['snapshot']),
    /agent-desktop gave no answer: dyld: Library not loaded/,
  )
  const old = fakeComputer(async () => {
    throw new ComputerUseError('unknown_method', 'unknown method run')
  })
  await assert.rejects(
    macDesktopExec(old.computer, async () => ({ path: '/b' }))(['snapshot']),
    /update Brigade\.app/,
  )
  await assert.rejects(
    macDesktopExec(old.computer, async () => undefined)(['snapshot']),
    /missing from this runner/,
  )
})

test('on a Mac, an interrupted turn cancels the command in the helper, or never starts it', async () => {
  const controller = new AbortController()
  const { computer, calls } = fakeComputer(
    () =>
      new Promise((_, reject) =>
        controller.signal.addEventListener('abort', () => reject(new Error('aborted'))),
      ),
  )
  const running = macDesktopExec(computer, async () => ({ path: '/b' }))(['snapshot'], {
    signal: controller.signal,
  })
  // Once the helper runs it.
  while (!calls.length) await new Promise((r) => setTimeout(r, 1))
  controller.abort()
  await assert.rejects(running, /aborted/)
  assert.deepEqual(
    calls.map((c) => c.method),
    ['run', 'cancel'],
  )
  // Interrupted before: the helper is not asked at all.
  calls.length = 0
  await assert.rejects(
    macDesktopExec(computer, async () => ({ path: '/b' }))(['snapshot'], {
      signal: AbortSignal.abort(),
    }),
    /aborted/,
  )
  assert.deepEqual(calls, [])
})

test("the runner has agent-desktop's binary for macOS and Linux, and the macOS helper beside it", () => {
  const linux = agentDesktopBinary('linux', 'x64')
  assert.ok(linux && existsSync(linux.path) && linux.path.endsWith('agent-desktop-linux-x64'))
  const mac = agentDesktopBinary('darwin', 'arm64')
  assert.ok(mac?.macosHelper?.endsWith('agent-desktop-macos-helper-darwin-arm64'))
  assert.ok(agentDesktopBinary('darwin', 'x64'))
  assert.equal(agentDesktopBinary('win32', 'x64'), undefined)
  assert.equal(binaryIn('/nowhere', 'linux', 'x64'), undefined)
  assert.equal(binaryIn('/nowhere', 'linux', 'ia32'), undefined)
})

test("on a Mac, agent-desktop is on a command's PATH, unless the person has their own", async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { ensureAgentDesktopShim } = await import('../src/harness/env.js')
  const root = mkdtempSync(join(tmpdir(), 'shim-'))
  const shims = join(root, 'shims')
  const theirs = join(root, 'bin')
  const binary = {
    path: "/Users/ada/.brigade/runner/it's/agent-desktop-darwin-arm64",
    macosHelper: '/h/helper',
  }
  try {
    ensureAgentDesktopShim(`/usr/bin:${shims}`, shims, binary)
    const shim = readFileSync(join(shims, 'agent-desktop'), 'utf8')
    assert.equal(
      shim,
      "#!/bin/sh\n# Brigade's agent-desktop\nAGENT_DESKTOP_MACOS_HELPER_PATH='/h/helper' " +
        `exec '/Users/ada/.brigade/runner/it'\\''s/agent-desktop-darwin-arm64' "$@"\n`,
    )
    // Their own, installed since: ours goes.
    mkdirSync(theirs)
    writeFileSync(join(theirs, 'agent-desktop'), '#!/bin/sh\n', { mode: 0o755 })
    ensureAgentDesktopShim(`${theirs}:${shims}`, shims, binary)
    assert.equal(existsSync(join(shims, 'agent-desktop')), false)
    // Not a Mac (no helper): nothing.
    ensureAgentDesktopShim('/usr/bin', shims, { path: '/b' })
    assert.equal(existsSync(join(shims, 'agent-desktop')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * The cloud keyboard against stubs: sudo runs the script here, and xdotool keeps which window is
 * active in a file. Each teammate's browser window is 1<n> (bt-a: 100, bt-b: 200).
 */
async function stubbedDesktop() {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'keyboard-'))
  const log = join(dir, 'log')
  const active = join(dir, 'active')
  const stub = (name: string, body: string) =>
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  // sudo -n -u <user> -- env -i VAR=... sh -c <script> sh <args>: the script, with the stubs.
  stub('sudo', `while [ "$1" != sh ]; do shift; done; shift; PATH="${dir}:$PATH" exec /bin/sh "$@"`)
  stub(
    'xdotool',
    [
      `case "$1" in`,
      `  search) case "$*" in *brigade-bt-a*) echo 100 ;; *brigade-bt-b*) echo 200 ;; *brigade-bt-c*) echo 100; echo 101 ;; esac ;;`,
      `  getactivewindow) cat "${active}" ;;`,
      `  windowactivate) [ "$(cat "${dir}/refuse" 2>/dev/null)" = 1 ] && exit 1; echo "$3" >"${active}" ;;`,
      // type --window <id> …: what Chrome gets only while <id> has the focus; logged under <id>.
      `  type) T=$(cat); [ "$2" = --window ] || exit 9; echo "type $3 $T" >>"${log}"`,
      // Someone clicks another window after the first piece.
      `    [ -f "${dir}/steal" ] && cat "${dir}/steal" >"${active}"; true ;;`,
      `  key) [ "$2" = --window ] || exit 9; echo "key $3 $5" >>"${log}" ;;`,
      `esac`,
    ].join('\n'),
  )
  writeFileSync(active, '999\n')
  const previous = process.env.PATH
  process.env.PATH = `${dir}:${previous}`
  return {
    dir,
    lines: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    done: () => {
      process.env.PATH = previous
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test("on a cloud computer, the keyboard goes only into the teammate's own window, or nowhere", async () => {
  const { teammateKeyboard } = await import('../src/desktop.js')
  const desk = await stubbedDesktop()
  try {
    // Another window has the focus and won't give it: nothing typed.
    writeFileSync(join(desk.dir, 'refuse'), '1')
    await assert.rejects(teammateKeyboard('bt-a').type('private-text'), /could not be brought/)
    await assert.rejects(teammateKeyboard('bt-a').key('Return'), /could not be brought/)
    assert.deepEqual(desk.lines(), [])
    // It comes to the front: typed there, in pieces.
    writeFileSync(join(desk.dir, 'refuse'), '0')
    const text = 'x'.repeat(40) + 'é'
    await teammateKeyboard('bt-a').type(text)
    await teammateKeyboard('bt-a').key('ctrl+l')
    assert.deepEqual(desk.lines(), [
      `type 100 ${'x'.repeat(32)}`,
      `type 100 ${'x'.repeat(8)}é`,
      'key 100 ctrl+l',
    ])
  } finally {
    desk.done()
  }
})

test('on a cloud computer, typing stops once another window takes the focus', async () => {
  const { teammateKeyboard } = await import('../src/desktop.js')
  const desk = await stubbedDesktop()
  try {
    writeFileSync(join(desk.dir, 'steal'), '999\n')
    await assert.rejects(teammateKeyboard('bt-a').type('y'.repeat(70)), /took the focus/)
    assert.deepEqual(desk.lines(), [`type 100 ${'y'.repeat(32)}`])
    // Another of the teammate's own windows takes it (someone clicked there): the rest isn't
    // typed there either.
    writeFileSync(join(desk.dir, 'active'), '100\n')
    writeFileSync(join(desk.dir, 'steal'), '101\n')
    await assert.rejects(teammateKeyboard('bt-c').type('z'.repeat(40)), /took the focus/)
    assert.deepEqual(desk.lines().slice(1), [`type 100 ${'z'.repeat(32)}`])
    // Focus taken in the middle of a piece: its keys are still sent to the teammate's window only,
    // and the call says the field may miss some of them.
    writeFileSync(join(desk.dir, 'active'), '100\n')
    writeFileSync(join(desk.dir, 'steal'), '200\n')
    await assert.rejects(teammateKeyboard('bt-a').type('private-password'), /may miss some/)
    assert.deepEqual(desk.lines().slice(2), ['type 100 private-password'])
  } finally {
    desk.done()
  }
})

test('on a cloud computer, an interrupted call sends nothing, and two teammates type one after the other', async () => {
  const { teammateKeyboard } = await import('../src/desktop.js')
  const desk = await stubbedDesktop()
  try {
    await assert.rejects(teammateKeyboard('bt-a').key('Return', AbortSignal.abort()), /aborted/)
    await assert.rejects(teammateKeyboard('bt-a').type('secret', AbortSignal.abort()), /aborted/)
    assert.deepEqual(desk.lines(), [])
    await Promise.all([
      teammateKeyboard('bt-a').type('a'.repeat(100)),
      teammateKeyboard('bt-b').type('b'.repeat(100)),
    ])
    const lines = desk.lines()
    assert.equal(lines.length, 8)
    // Each one's pieces together, each into its own window.
    assert.ok(
      lines.slice(0, 4).every((l) => /^type 100 a+$/.test(l)),
      lines.join('\n'),
    )
    assert.ok(
      lines.slice(4).every((l) => /^type 200 b+$/.test(l)),
      lines.join('\n'),
    )
  } finally {
    desk.done()
  }
})

test("a runner downloads agent-desktop once, checks it, and keeps only its own platform's binaries", async () => {
  const { execFileSync } = await import('node:child_process')
  const { createHash } = await import('node:crypto')
  const { mkdtempSync, mkdirSync, rmSync, statSync, readdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { ensureAgentDesktop } = await import('../src/agent-desktop.js')
  const root = mkdtempSync(join(tmpdir(), 'agent-desktop-'))
  try {
    // A tarball laid out as npm's: package/bin/<binaries>.
    const bin = join(root, 'src', 'package', 'bin')
    mkdirSync(bin, { recursive: true })
    for (const name of [
      'agent-desktop-linux-x64',
      'agent-desktop-linux-clipboard-owner-linux-x64',
      'agent-desktop-darwin-arm64',
      'agent-desktop-macos-helper-darwin-arm64',
      'agent-desktop-win32-x64.exe',
    ])
      writeFileSync(join(bin, name), `#!/bin/sh\necho ${name}\n`, { mode: 0o644 })
    const tarball = join(root, 'package.tgz')
    execFileSync('tar', ['-czf', tarball, '-C', join(root, 'src'), 'package'])
    const bytes = readFileSync(tarball)
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    let fetched = 0
    const fetch = (async () => {
      fetched++
      return new Response(bytes)
    }) as unknown as typeof globalThis.fetch

    // Not what was pinned: refused, nothing kept.
    const wrong = join(root, 'wrong', '1.3.1')
    await assert.rejects(
      ensureAgentDesktop({ fromPackage: false, os: 'linux', cpu: 'x64', dir: wrong, fetch }),
      /does not match the version pinned/,
    )
    assert.equal(existsSync(wrong), false)

    // Two calls at once: one download, its platform's binaries only, runnable by others too.
    const dir = join(root, 'install', 'agent-desktop', '1.3.1')
    fetched = 0
    const [a, b] = await Promise.all([
      ensureAgentDesktop({ fromPackage: false, os: 'linux', cpu: 'x64', dir, fetch, integrity }),
      ensureAgentDesktop({ fromPackage: false, os: 'linux', cpu: 'x64', dir, fetch, integrity }),
    ])
    assert.equal(fetched, 1)
    assert.deepEqual(a, { path: join(dir, 'agent-desktop-linux-x64') })
    assert.deepEqual(b, a)
    assert.deepEqual(readdirSync(dir).sort(), [
      'agent-desktop-linux-clipboard-owner-linux-x64',
      'agent-desktop-linux-x64',
    ])
    assert.equal(statSync(a.path).mode & 0o777, 0o755)
    assert.equal(statSync(dir).mode & 0o777, 0o755)
    // Nothing left of the download beside it.
    assert.deepEqual(readdirSync(join(root, 'install', 'agent-desktop')), ['1.3.1'])
    // There already: no download.
    await ensureAgentDesktop({ fromPackage: false, os: 'linux', cpu: 'x64', dir, fetch, integrity })
    assert.equal(fetched, 1)

    // A Mac: the binary and the helper it starts.
    const mac = join(root, 'mac', '1.3.1')
    const binary = await ensureAgentDesktop({
      fromPackage: false,
      os: 'darwin',
      cpu: 'arm64',
      dir: mac,
      fetch,
      integrity,
    })
    assert.deepEqual(binary, {
      path: join(mac, 'agent-desktop-darwin-arm64'),
      macosHelper: join(mac, 'agent-desktop-macos-helper-darwin-arm64'),
    })

    // npm down: an error, tried again at the next call.
    const down = (async () =>
      new Response('', { status: 503 })) as unknown as typeof globalThis.fetch
    const later = join(root, 'later', '1.3.1')
    await assert.rejects(
      ensureAgentDesktop({
        fromPackage: false,
        os: 'linux',
        cpu: 'x64',
        dir: later,
        fetch: down,
        integrity,
      }),
      /npm answered 503/,
    )
    assert.ok(
      await ensureAgentDesktop({
        fromPackage: false,
        os: 'linux',
        cpu: 'x64',
        dir: later,
        fetch,
        integrity,
      }),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the version a runner downloads is the one pinned in the lockfile, and the bundle leaves it out', async () => {
  const { AGENT_DESKTOP_INTEGRITY, AGENT_DESKTOP_VERSION } = await import('../src/agent-desktop.js')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  // A devDependency: \`pnpm deploy --prod\` (bundle.sh) leaves it out of the runner's bundle, which
  // the API serves as a Worker asset of at most 25 MiB.
  assert.equal(pkg.dependencies['agent-desktop'], undefined)
  assert.equal(pkg.devDependencies['agent-desktop'], AGENT_DESKTOP_VERSION)
  const lock = readFileSync(new URL('../../../pnpm-lock.yaml', import.meta.url), 'utf8')
  const entry = lock.indexOf(`\n  agent-desktop@${AGENT_DESKTOP_VERSION}:\n`)
  assert.ok(entry > 0)
  assert.match(
    lock.slice(entry, entry + 300),
    new RegExp(`integrity: ${AGENT_DESKTOP_INTEGRITY.replace(/[+/]/g, '\\$&')}`),
  )
})

test('a stalled download fails at its deadline, and a caller that gives up stops only its own wait', async () => {
  const { execFileSync } = await import('node:child_process')
  const { createHash } = await import('node:crypto')
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { ensureAgentDesktop } = await import('../src/agent-desktop.js')
  const root = mkdtempSync(join(tmpdir(), 'agent-desktop-stall-'))
  try {
    const bin = join(root, 'src', 'package', 'bin')
    mkdirSync(bin, { recursive: true })
    for (const name of ['agent-desktop-linux-x64', 'agent-desktop-linux-clipboard-owner-linux-x64'])
      writeFileSync(join(bin, name), '#!/bin/sh\n')
    const tarball = join(root, 'package.tgz')
    execFileSync('tar', ['-czf', tarball, '-C', join(root, 'src'), 'package'])
    const bytes = readFileSync(tarball)
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    // Headers, then the first bytes, then nothing: the body never ends, whatever the signal.
    const stalled = (async () =>
      new Response(
        new ReadableStream({
          start: (controller) => controller.enqueue(bytes.subarray(0, 100)),
        }),
      )) as unknown as typeof globalThis.fetch
    const dir = join(root, 'stalled', '1.3.1')
    const options = { fromPackage: false, os: 'linux' as const, cpu: 'x64', dir, integrity }

    // Past its deadline: an error, for every caller.
    const started = Date.now()
    await assert.rejects(
      Promise.all([
        ensureAgentDesktop({ ...options, fetch: stalled, deadlineMs: 200 }),
        ensureAgentDesktop({ ...options, fetch: stalled, deadlineMs: 200 }),
      ]),
      /no answer from npm within/,
    )
    assert.ok(Date.now() - started < 5000)
    assert.equal(existsSync(dir), false)

    // A caller whose turn was interrupted stops waiting; the download goes on for the other.
    let release: () => void = () => undefined
    const slow = (async () => {
      await new Promise<void>((resolve) => (release = resolve))
      return new Response(bytes)
    }) as unknown as typeof globalThis.fetch
    const controller = new AbortController()
    const leaving = ensureAgentDesktop({ ...options, fetch: slow, signal: controller.signal })
    const staying = ensureAgentDesktop({ ...options, fetch: slow })
    controller.abort()
    await assert.rejects(leaving, /aborted/)
    release()
    assert.deepEqual(await staying, { path: join(dir, 'agent-desktop-linux-x64') })
    // Interrupted before it asked: no wait at all.
    await assert.rejects(
      ensureAgentDesktop({
        ...options,
        dir: join(root, 'other'),
        fetch: slow,
        signal: AbortSignal.abort(),
      }),
      /aborted/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a long list shows its first items and a line for the rest; rooted on it, all of it', () => {
  const list: DesktopNode = {
    role: 'list',
    ref_id: '@s1:e1',
    children: Array.from({ length: 40 }, (_, i) => ({
      role: 'textfield',
      value: `file-${i}`,
      ref_id: `@s1:e${i + 2}`,
    })),
  }
  const short = renderTree(list).text.split('\n')
  assert.equal(short.length, 1 + 25 + 1)
  assert.equal(short.at(-1), '  … 15 more here: snapshot with root @s1:e1 to list them')
  assert.equal(renderTree(list, { children: Number.POSITIVE_INFINITY }).text.split('\n').length, 41)
})

test('siblings scrolled out of view, three or more in a row, are one line; hidden: true lists them', () => {
  const at = (i: number, out: boolean): DesktopNode => ({
    role: 'textfield',
    value: `file-${i}`,
    ref_id: `@s1:e${i}`,
    ...(out ? { states: ['offscreen'] } : {}),
  })
  const list: DesktopNode = {
    role: 'list',
    children: [
      ...Array.from({ length: 30 }, (_, i) => at(i, true)),
      at(30, false),
      at(31, false),
      at(32, true),
      at(33, true),
    ],
  }
  assert.equal(
    renderTree(list).text,
    [
      'list',
      '  … 30 out of view (scroll to them, or snapshot with hidden: true)',
      '  textfield = "file-30" @s1:e30',
      '  textfield = "file-31" @s1:e31',
      // Two in a row stay as they are.
      '  textfield = "file-32" [offscreen] @s1:e32',
      '  textfield = "file-33" [offscreen] @s1:e33',
    ].join('\n'),
  )
  assert.equal(
    renderTree(list, { hidden: true, children: Number.POSITIVE_INFINITY }).text.split('\n').length,
    35,
  )
})

test('actions and snapshots become batch entries, by their own field names', () => {
  assert.deepEqual(actEntry({ ref: '@s1:e1', action: 'right_click' }), {
    command: 'right-click',
    args: { ref_id: '@s1:e1' },
  })
  assert.deepEqual(actEntry({ ref: '@s1:e1', action: 'select', option: 'PDF' }), {
    command: 'select',
    args: { ref_id: '@s1:e1', value: 'PDF' },
  })
  assert.deepEqual(actEntry({ ref: '@s1:e1', action: 'scroll', amount: 500 }), {
    command: 'scroll',
    args: { ref_id: '@s1:e1', direction: 'down', amount: 50 },
  })
  assert.throws(() => actEntry({ ref: '@s1:e1', action: 'type', text: 'secret' }), /never/)
  assert.deepEqual(
    snapshotEntry({ app: 'TextEdit', surface: 'sheet', maxDepth: 4, bounds: true }, 'mac'),
    {
      command: 'snapshot',
      args: {
        app: 'TextEdit',
        interactive_only: true,
        compact: true,
        include_bounds: true,
        surface: 'sheet',
        max_depth: 4,
        timeout_ms: 8000,
      },
    },
  )
})

/** The entries of a batch call, or undefined for another command. */
const entriesOf = (args: string[]) => {
  const at = args.indexOf('batch')
  return at < 0 ? undefined : (JSON.parse(args[at + 1]!) as { command: string; args: any }[])
}

/** An exec that answers snapshots with a tree of their own id, batches entry by entry. */
function appExec(
  refuse: (entry: { command: string; args: any }) => string | undefined = () => undefined,
) {
  let shot = 0
  const snapshotData = (args: any) => {
    shot++
    return {
      app: args?.app ?? 'TextEdit',
      snapshot_id: `s${shot}`,
      tree: {
        role: args?.surface === 'sheet' ? 'sheet' : 'window',
        name: args?.surface === 'sheet' ? 'save' : 'Untitled',
        children: [{ role: 'button', name: 'Save', ref_id: `@s${shot}:e1` }],
      },
    }
  }
  return fakeExec((args) => {
    const entries = entriesOf(args)
    if (!entries) {
      if (args[0] === 'snapshot')
        return envelope(snapshotData({ app: args[args.indexOf('--app') + 1] }))
      return envelope({ disposition: { delivery: 'delivered_verified' } })
    }
    const results = []
    for (const entry of entries) {
      const code = refuse(entry)
      if (code) {
        results.push({
          command: entry.command,
          ok: false,
          error: { code, message: `${code} message` },
        })
        break
      }
      results.push({
        command: entry.command,
        ok: true,
        data:
          entry.command === 'snapshot'
            ? snapshotData(entry.args)
            : entry.command === 'wait'
              ? { waited_ms: entry.args.ms }
              : { disposition: { delivery: 'delivered_unverified' } },
      })
    }
    return envelope({ results })
  })
}

test('an action on a ref reads its window again in the same call, with the new refs', async () => {
  const { exec, calls } = appExec()
  const tools = desktopTools({ exec, where: 'mac' })
  const snapshot = (await tools.computer_snapshot!.execute!(
    { app: 'TextEdit', skeleton: true },
    options(),
  )) as Record<string, unknown>
  assert.equal(snapshot.snapshot, 's1')
  const result = (await tools.computer_act!.execute!(
    { ref: '@s1:e1', action: 'click' },
    options(),
  )) as Record<string, any>
  assert.equal(result.action, 'click')
  assert.equal(result.delivery, 'delivered_unverified')
  assert.equal(result.check, undefined)
  assert.equal(result.after.snapshot, 's2')
  assert.match(result.after.tree, /button "Save" @s2:e1/)
  // One trip: the click, a moment to settle, and the same app read again (not as a skeleton).
  assert.deepEqual(entriesOf(calls[1]!.args), [
    { command: 'click', args: { ref_id: '@s1:e1' } },
    { command: 'wait', args: { ms: 300 } },
    {
      command: 'snapshot',
      // A small window: read again with its text too (all).
      args: { app: 'TextEdit', interactive_only: false, compact: true, timeout_ms: 8000 },
    },
  ])
  assert.ok(calls[1]!.args.includes('--stop-on-error'))
  // The new refs are known in turn.
  const next = (await tools.computer_act!.execute!(
    { ref: '@s2:e1', action: 'click' },
    options(),
  )) as Record<string, any>
  assert.equal(next.after.snapshot, 's3')
  assert.equal(calls.length, 3)
})

test('steps go in order in batches, text alone through stdin, and the window is read once at the end', async () => {
  const { exec, calls } = appExec()
  const tools = desktopTools({ exec, where: 'mac' })
  await tools.computer_snapshot!.execute!({ app: 'Calculator' }, options())
  const result = (await tools.computer_act!.execute!(
    {
      steps: [
        { ref: '@s1:e1', action: 'click' },
        { ref: '@s1:e2', action: 'click' },
        { ref: '@s1:e3', action: 'type', text: 'secret words' },
        { ref: '@s1:e4', action: 'click' },
      ],
    },
    options(),
  )) as Record<string, any>
  assert.equal(result.done, 4)
  assert.equal(result.of, 4)
  assert.equal(result.failed, undefined)
  assert.equal(result.after.snapshot, 's2')
  assert.deepEqual(
    calls.slice(1).map((c) => entriesOf(c.args)?.map((e) => e.command) ?? c.args),
    [
      ['click', 'click'],
      ['type', '@s1:e3', '--stdin'],
      ['click', 'wait', 'snapshot'],
    ],
  )
  assert.equal(calls[2]!.stdin, 'secret words')
  // Text is never on a command line.
  assert.ok(calls.every((c) => !c.args.join(' ').includes('secret')))
})

test('a step that fails stops the rest, says which, and the window is read as it is', async () => {
  const { exec, calls } = appExec((entry) =>
    entry.args?.ref_id === '@s1:e2' ? 'STALE_REF' : undefined,
  )
  const tools = desktopTools({ exec, where: 'mac' })
  await tools.computer_snapshot!.execute!({ app: 'Calculator' }, options())
  const result = (await tools.computer_act!.execute!(
    {
      steps: [
        { ref: '@s1:e1', action: 'click' },
        { ref: '@s1:e2', action: 'click' },
        { ref: '@s1:e3', action: 'click' },
      ],
    },
    options(),
  )) as Record<string, any>
  assert.equal(result.done, 1)
  assert.equal(result.of, 3)
  assert.equal(result.failed.step, 1)
  assert.equal(result.failed.ref, '@s1:e2')
  assert.match(result.failed.error, /STALE_REF/)
  assert.equal(result.after.snapshot, 's2')
  assert.equal(calls.length, 3)
})

test('an action that opens a sheet comes back with the sheet', async () => {
  const { exec, calls } = fakeExec((args) => {
    const entries = entriesOf(args)
    if (!entries)
      return envelope({
        app: 'TextEdit',
        snapshot_id: 's1',
        tree: { role: 'window', name: 'Untitled' },
      })
    return envelope({
      results: entries.map((entry) => ({
        command: entry.command,
        ok: true,
        data:
          entry.command === 'snapshot'
            ? {
                app: 'TextEdit',
                snapshot_id: entry.args.surface ? 's3' : 's2',
                tree: { role: entry.args.surface ?? 'window', name: 'x' },
              }
            : {
                disposition: { delivery: 'delivered_verified' },
                surfaces: [{ type: 'sheet', title: 'save' }],
              },
      })),
    })
  })
  const tools = desktopTools({ exec, where: 'mac' })
  await tools.computer_snapshot!.execute!({ app: 'TextEdit' }, options())
  const result = (await tools.computer_act!.execute!(
    { ref: '@s1:e9', action: 'click' },
    options(),
  )) as Record<string, any>
  assert.equal(result.after.snapshot, 's3')
  assert.match(result.after.tree, /^sheet/)
  assert.equal(entriesOf(calls.at(-1)!.args)!.at(-1)!.args.surface, 'sheet')
})

test('a step list is checked before anything is done', async () => {
  const { exec, calls } = appExec()
  const act = desktopTools({ exec, where: 'mac' }).computer_act!
  await assert.rejects(act.execute!({}, options()) as Promise<unknown>, /ref and an action/)
  await assert.rejects(
    act.execute!({ steps: [{ ref: '@s1:e1', action: 'type' }] }, options()) as Promise<unknown>,
    /text is required/,
  )
  await assert.rejects(
    act.execute!(
      { steps: Array.from({ length: 31 }, () => ({ ref: '@s1:e1', action: 'click' })) },
      options(),
    ) as Promise<unknown>,
    /At most 30/,
  )
  assert.equal(calls.length, 0)
})

test('when what was read before is gone (a sheet the action closed), the app is read as a whole', async () => {
  const { exec, calls } = fakeExec((args) => {
    const entries = entriesOf(args)
    if (!entries)
      return envelope({ app: 'TextEdit', snapshot_id: 's1', tree: { role: 'sheet', name: 'save' } })
    return envelope({
      results: entries.map((entry) =>
        entry.command === 'snapshot' && entry.args.surface
          ? {
              command: 'snapshot',
              ok: false,
              error: { code: 'SURFACE_NOT_FOUND', message: 'no sheet' },
            }
          : {
              command: entry.command,
              ok: true,
              data:
                entry.command === 'snapshot'
                  ? {
                      app: 'TextEdit',
                      snapshot_id: 's2',
                      tree: { role: 'window', name: 'test.rtf' },
                    }
                  : { disposition: { delivery: 'delivered_unverified' } },
            },
      ),
    })
  })
  const tools = desktopTools({ exec, where: 'mac' })
  await tools.computer_snapshot!.execute!({ app: 'TextEdit', surface: 'sheet' }, options())
  const result = (await tools.computer_act!.execute!(
    { ref: '@s1:e7', action: 'click' },
    options(),
  )) as Record<string, any>
  assert.equal(result.check, undefined)
  assert.equal(result.after.snapshot, 's2')
  assert.match(result.after.tree, /window "test.rtf"/)
  assert.deepEqual(entriesOf(calls.at(-1)!.args)!.at(-1)!.args, {
    app: 'TextEdit',
    interactive_only: false,
    compact: true,
    timeout_ms: 8000,
  })
})

test('on a Mac, a key for an app goes to its process, and text into its one focused field', async () => {
  const { exec, calls } = fakeExec((args) =>
    args[0] === 'find'
      ? envelope({
          matches: [
            // AppKit marks a list's cells focused too: only a field that takes text counts.
            { role: 'cell', ref_id: '@s9:e1', states: ['focused'] },
            { role: 'textfield', ref_id: '@s9:e2', states: ['focused'] },
          ],
        })
      : envelope({ disposition: { delivery: 'delivered_verified' } }),
  )
  const input = macAppInput({ exec, where: 'mac' })
  assert.deepEqual(await input.press('TextEdit', 'cmd+b'), { delivery: 'delivered_verified' })
  assert.deepEqual(await input.type('TextEdit', 'Bonjour 👋'), { delivery: 'delivered_verified' })
  assert.deepEqual(
    calls.map((c) => c.args),
    [
      ['press', '--app', 'TextEdit', 'cmd+b'],
      ['find', '--app', 'TextEdit', '--state', 'focused'],
      ['type', '@s9:e2', '--stdin'],
    ],
  )
  assert.equal(calls[2]!.stdin, 'Bonjour 👋')
})

test('text for an app with no single focused field is not typed', async () => {
  for (const matches of [
    [],
    [
      { role: 'textfield', ref_id: '@s9:e1', states: ['focused'] },
      { role: 'textfield', ref_id: '@s9:e2', states: ['focused'] },
    ],
  ]) {
    const { exec, calls } = fakeExec(() => envelope({ matches }))
    await assert.rejects(
      macAppInput({ exec, where: 'mac' }).type('TextEdit', 'x'),
      /nothing was typed/,
    )
    assert.deepEqual(
      calls.map((c) => c.args[0]),
      ['find'],
    )
  }
})

test('after an action, the app a default snapshot read is read again, even with another in front now', async () => {
  // Cody's case (review of #856): computer_snapshot({}) on TextEdit, then Finder comes forward.
  let front = 'TextEdit'
  let id = 0
  const snapshot = (app = front) => ({
    app,
    snapshot_id: `s${++id}`,
    tree: {
      role: 'window',
      name: app,
      children: [{ role: 'button', name: 'Button', ref_id: `@s${id}:e1` }],
    },
  })
  const { exec, calls } = fakeExec((args) => {
    const entries = entriesOf(args)
    if (!entries) return envelope(snapshot())
    return envelope({
      results: entries.map((entry) => ({
        command: entry.command,
        ok: true,
        data:
          entry.command === 'snapshot'
            ? snapshot(entry.args.app)
            : { disposition: { delivery: 'delivered_verified' } },
      })),
    })
  })
  const tools = desktopTools({ exec, where: 'mac' })
  const before = (await tools.computer_snapshot!.execute!({}, options())) as Record<string, any>
  front = 'Finder'
  const result = (await tools.computer_act!.execute!(
    { ref: `@${before.snapshot}:e1`, action: 'click' },
    options(),
  )) as Record<string, any>
  assert.equal(result.after.app, 'TextEdit')
  assert.equal(entriesOf(calls.at(-1)!.args)!.at(-1)!.args.app, 'TextEdit')
})

test('a menu bar is read as its menus and items: no Apple menu, each submenu folded with its count', async () => {
  const item = (name: string, ref: string, submenu?: string[]): DesktopNode => ({
    role: 'menuitem',
    name,
    ref_id: ref,
    available_actions: ['Click'],
    ...(submenu
      ? {
          children: [
            {
              role: 'menu',
              name,
              children: submenu.map((child, i) => item(child, `${ref}${i}`)),
            },
          ],
        }
      : {}),
  })
  const bar: DesktopNode = {
    role: 'menu',
    children: [
      item('Apple', '@s1:e1', ['About This Mac', 'Recent Items', 'Shut Down']),
      item('File', '@s1:e2', []),
    ],
  }
  bar.children![1]!.children![0]!.children = [
    item('Save…', '@s1:e3'),
    item('Open Recent', '@s1:e4', ['AuthKey_SECRET.p8', 'notes.txt', 'Clear Menu']),
  ]
  const { exec } = fakeExec(() => envelope({ app: 'TextEdit', snapshot_id: 's1', tree: bar }))
  const tools = desktopTools({ exec, where: 'mac' })
  const read = (await tools.computer_snapshot!.execute!(
    { app: 'TextEdit', surface: 'menubar' },
    options(),
  )) as Record<string, any>
  assert.equal(
    read.tree,
    [
      'menu',
      '  menuitem "File" @s1:e2 {click}',
      '    menu "File"',
      '      menuitem "Save…" @s1:e3 {click}',
      '      menuitem "Open Recent" @s1:e4 {click}',
      '        menu "Open Recent" (3 inside)',
    ].join('\n'),
  )
  assert.doesNotMatch(read.tree, /AuthKey|Shut Down|Apple/)
  // Rooted on an item, as asked: all of it.
  const rooted = (await tools.computer_snapshot!.execute!(
    { app: 'TextEdit', surface: 'menubar', root: '@s1:e4' },
    options(),
  )) as Record<string, any>
  assert.match(rooted.tree, /notes\.txt/)
})

test('a big window is read again after an action as before, without its text', async () => {
  const big = {
    role: 'window',
    name: 'Big',
    children: Array.from({ length: 25 }, (_, i) => ({
      role: 'group',
      children: Array.from({ length: 25 }, (_, j) => ({
        role: 'button',
        name: `A button with a rather long name ${i}-${j}`,
        ref_id: `@s1:e${i * 25 + j}`,
      })),
    })),
  }
  const { exec, calls } = fakeExec((args) => {
    const entries = entriesOf(args)
    if (!entries) return envelope({ app: 'Big', snapshot_id: 's1', tree: big })
    return envelope({
      results: entries.map((entry) => ({
        command: entry.command,
        ok: true,
        data:
          entry.command === 'snapshot'
            ? { app: 'Big', snapshot_id: 's2', tree: { role: 'window' } }
            : { disposition: { delivery: 'delivered_verified' } },
      })),
    })
  })
  const tools = desktopTools({ exec, where: 'mac' })
  await tools.computer_snapshot!.execute!({ app: 'Big' }, options())
  await tools.computer_act!.execute!({ ref: '@s1:e3', action: 'click' }, options())
  assert.equal(entriesOf(calls.at(-1)!.args)!.at(-1)!.args.interactive_only, true)
})

test("waiting for an app's window: an app not there yet is no window; a Stop is the answer itself", async () => {
  const notYet = fakeExec(() => refusal('APP_NOT_FOUND'))
  assert.deepEqual(await macAppInput({ exec: notYet.exec, where: 'mac' }).windows('TextEdit'), [])
  const listed = fakeExec(() =>
    envelope([
      { id: 'w-1', title: 'Open', visible: true },
      { id: 'w-2', title: 'Hidden', minimized: true },
    ]),
  )
  assert.deepEqual(await macAppInput({ exec: listed.exec, where: 'mac' }).windows('TextEdit'), [
    { id: 'w-1', title: 'Open' },
  ])
  // Cody's case (review of #858): the person pressed Stop while the tool waited.
  const stopped: DesktopExec = async () => {
    throw new ComputerUseError('stopped', 'The person pressed Stop on the computer-use indicator.')
  }
  await assert.rejects(
    macAppInput({ exec: stopped, where: 'mac' }).windows('TextEdit'),
    (error: unknown) => error instanceof ComputerUseError && error.code === 'stopped',
  )
})

test('plain siblings of one role in a row (a ruler’s markers) are one line', () => {
  const ruler: DesktopNode = {
    role: 'ruler',
    ref_id: '@s1:e5',
    children: [
      ...Array.from({ length: 15 }, () => ({ role: 'rulermarker' })),
      { role: 'rulermarker', name: 'Left margin' },
    ],
  }
  assert.equal(
    renderTree(ruler).text,
    ['ruler @s1:e5', '  … 15 × rulermarker', '  rulermarker "Left margin"'].join('\n'),
  )
  // Three are shown as they are.
  assert.equal(
    renderTree({
      role: 'group',
      children: [{ role: 'x' }, { role: 'x' }, { role: 'x' }],
    }).text.split('\n').length,
    4,
  )
})

test('an action that closes the window it read says so, rather than to take a new snapshot', async () => {
  const { exec } = fakeExec((args) => {
    const entries = entriesOf(args)
    if (!entries)
      return envelope({
        app: 'TextEdit',
        snapshot_id: 's1',
        tree: { role: 'window', name: 'test.rtf' },
      })
    return envelope({
      results: entries.map((entry) =>
        entry.command === 'snapshot'
          ? {
              command: 'snapshot',
              ok: false,
              error: { code: 'WINDOW_NOT_FOUND', message: 'no window' },
            }
          : {
              command: entry.command,
              ok: true,
              data: { disposition: { delivery: 'delivered_unverified' } },
            },
      ),
    })
  })
  const tools = desktopTools({ exec, where: 'mac' })
  await tools.computer_snapshot!.execute!({ app: 'TextEdit' }, options())
  const result = (await tools.computer_act!.execute!(
    { ref: '@s1:e22', action: 'click' },
    options(),
  )) as Record<string, any>
  assert.equal(result.check, undefined)
  assert.match(result.closed, /the action closed it/)
})

test('a root and a surface together read the root alone, which agent-desktop takes', async () => {
  assert.deepEqual(
    snapshotEntry({ app: 'TextEdit', surface: 'sheet', root: '@s1:e11' }, 'mac').args,
    {
      app: 'TextEdit',
      interactive_only: true,
      compact: true,
      root: '@s1:e11',
      timeout_ms: 8000,
    },
  )
  const { exec } = fakeExec(() =>
    envelope({ app: 'TextEdit', snapshot_id: 's1', tree: { role: 'table', ref_id: '@s1:e12' } }),
  )
  const read = (await desktopTools({ exec, where: 'mac' }).computer_snapshot!.execute!(
    { app: 'TextEdit', root: '@s1:e11' },
    options(),
  )) as Record<string, any>
  assert.match(read.refs, /Refs inside this region are new/)
})

test('siblings that a description, a state or a frame tells apart are not folded', () => {
  const statuses: DesktopNode = {
    role: 'group',
    children: ['Success', 'Warning', 'Error', 'Pending'].map((description, i) => ({
      role: 'image',
      description,
      bounds: { x: i * 10, y: 0, width: 8, height: 8 },
    })),
  }
  assert.match(renderTree(statuses).text, /Success[\s\S]*Warning[\s\S]*Error[\s\S]*Pending/)
  assert.doesNotMatch(renderTree(statuses).text, /× image/)
})
