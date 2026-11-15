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
  desktopTools,
  macDesktopExec,
  pickWindow,
  snapshotArgs,
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
  const { text, left } = renderTree(big, { max: 300 })
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
      '--surface',
      'sheet',
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
  const exec = macDesktopExec(computer, binary)
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
    macDesktopExec(quiet.computer, { path: '/b' })(['snapshot']),
    /agent-desktop gave no answer: dyld: Library not loaded/,
  )
  const old = fakeComputer(async () => {
    throw new ComputerUseError('unknown_method', 'unknown method run')
  })
  await assert.rejects(
    macDesktopExec(old.computer, { path: '/b' })(['snapshot']),
    /update Brigade\.app/,
  )
  await assert.rejects(
    macDesktopExec(old.computer, undefined)(['snapshot']),
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
  const running = macDesktopExec(computer, { path: '/b' })(['snapshot'], {
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
    macDesktopExec(computer, { path: '/b' })(['snapshot'], { signal: AbortSignal.abort() }),
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
      `  search) case "$*" in *brigade-bt-a*) echo 100 ;; *brigade-bt-b*) echo 200 ;; esac ;;`,
      `  getactivewindow) cat "${active}" ;;`,
      `  windowactivate) [ "$(cat "${dir}/refuse" 2>/dev/null)" = 1 ] && exit 1; echo "$3" >"${active}" ;;`,
      `  type) T=$(cat); echo "type $(cat "${active}") $T" >>"${log}"`,
      // Someone clicks another window after the first piece.
      `    [ -f "${dir}/steal" ] && echo 999 >"${active}"; true ;;`,
      `  key) echo "key $(cat "${active}") $4" >>"${log}" ;;`,
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
    writeFileSync(join(desk.dir, 'steal'), '')
    await assert.rejects(
      teammateKeyboard('bt-a').type('y'.repeat(70)),
      /could not be brought|another window/,
    )
    assert.deepEqual(desk.lines(), [`type 100 ${'y'.repeat(32)}`])
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
