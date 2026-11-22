import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ComputerUseError, Line, type RequestOptions } from '../src/computer-use.js'
import type { AppInput } from '../src/harness/desktop-tools.js'
import { computerUseTools, type ComputerUse } from '../src/harness/tools.js'

type Call = { method: string; params: Record<string, unknown>; options?: RequestOptions }

function computer(answer: (call: Call) => Promise<unknown>) {
  const calls: Call[] = []
  const use: ComputerUse = {
    request: (method, params, _signal, options) => {
      const call = { method, params, ...(options && { options }) }
      calls.push(call)
      return answer(call)
    },
    workDir: '/work/thread',
    env: () => ({ PATH: '/opt/homebrew/bin:/usr/bin' }),
    screenshotPath: () => ({ path: 'images/x.png', absolute: '/work/thread/images/x.png' }),
    share: () => undefined,
    seen: () => undefined,
    acted: () => undefined,
  }
  return { use, calls }
}

const options = (abortSignal?: AbortSignal) =>
  ({ toolCallId: 'call-1', messages: [], abortSignal }) as never

test('computer_run asks the helper to run it, in the working directory, once, as long as it may last', async () => {
  const { use, calls } = computer(async () => ({ exitCode: 0, output: 'granted\n' }))
  const result = await computerUseTools(use).computer_run!.execute!(
    { command: 'agent-desktop permissions', cwd: 'sub', timeout: 5000 },
    options(),
  )
  assert.deepEqual(result, { exitCode: 0, output: 'granted\n' })
  assert.deepEqual(calls, [
    {
      method: 'run',
      params: {
        command: 'agent-desktop permissions',
        cwd: '/work/thread/sub',
        env: { PATH: '/opt/homebrew/bin:/usr/bin' },
        timeout: 1800,
      },
      options: { wait: 1830_000, once: true },
    },
  ])
})

test('computer_run: the default timeout, and an absolute cwd as it is', async () => {
  const { use, calls } = computer(async () => ({ exitCode: 0, output: '' }))
  await computerUseTools(use).computer_run!.execute!({ command: 'true', cwd: '/tmp' }, options())
  assert.equal(calls[0]!.params.cwd, '/tmp')
  assert.equal(calls[0]!.params.timeout, 120)
})

test('an interrupted turn cancels its command in the helper', async () => {
  const controller = new AbortController()
  const { use, calls } = computer(async (call) =>
    call.method === 'run'
      ? new Promise((_, reject) =>
          controller.signal.addEventListener('abort', () => reject(new Error('aborted'))),
        )
      : { ok: true },
  )
  const running = computerUseTools(use).computer_run!.execute!(
    { command: 'sleep 100' },
    options(controller.signal),
  )
  controller.abort()
  await assert.rejects(running as Promise<unknown>, /aborted/)
  assert.deepEqual(
    calls.map((c) => c.method),
    ['run', 'cancel'],
  )
})

test('an older helper without run: the teammate is told to update Brigade.app', async () => {
  const { use } = computer(async () => {
    throw new ComputerUseError('unknown_method', 'unknown method run')
  })
  await assert.rejects(
    computerUseTools(use).computer_run!.execute!(
      { command: 'true' },
      options(),
    ) as Promise<unknown>,
    /update Brigade\.app/,
  )
})

test('commands wait their turn in the line rather than being refused, in the order asked', async () => {
  const line = new Line()
  const order: string[] = []
  let releaseFirst!: () => void
  const first = line.run(async () => {
    order.push('first starts')
    await new Promise<void>((resolve) => (releaseFirst = resolve))
    order.push('first ends')
    return 1
  })
  const second = line.run(async () => {
    order.push('second')
    return 2
  })
  const third = line.run(async () => {
    order.push('third')
    return 3
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(order, ['first starts'])
  releaseFirst()
  assert.deepEqual(await Promise.all([first, second, third]), [1, 2, 3])
  assert.deepEqual(order, ['first starts', 'first ends', 'second', 'third'])
})

test('a command whose turn was interrupted, or that waited too long, leaves the line without running', async () => {
  const line = new Line(50)
  let releaseFirst!: () => void
  const first = line.run(() => new Promise<void>((resolve) => (releaseFirst = resolve)))
  const controller = new AbortController()
  let ran = 0
  const interrupted = line.run(async () => void ran++, controller.signal)
  controller.abort()
  await assert.rejects(interrupted, /aborted/)
  await assert.rejects(
    line.run(async () => void ran++),
    (error: unknown) => error instanceof ComputerUseError && error.code === 'busy',
  )
  // The one after still waits for the one running, then runs.
  const later = line.run(async () => void ran++)
  releaseFirst()
  await first
  await later
  assert.equal(ran, 1)
})

/** A fake helper: version 3 checks a named app is in front as it sends, as main.swift does. */
function helper(version: string, state: { front: string }) {
  const deliveries: string[] = []
  const { use, calls } = computer(async (call) => {
    if (call.method === 'status') return { version }
    if (call.method === 'apps') return { apps: [{ name: state.front, active: true }] }
    if (call.method === 'open_app') {
      await new Promise((resolve) => setTimeout(resolve, 5))
      state.front = call.params.app as string
      return { name: state.front, active: true }
    }
    if (call.method === 'key') {
      const app = call.params.app as string | undefined
      if (app && app !== state.front)
        throw new ComputerUseError(
          'not_front',
          `${app} is not in front (${state.front} is), so nothing was sent`,
        )
      deliveries.push(`${call.params.key as string} -> ${state.front}`)
    }
    return { ok: true }
  })
  return { use, calls, deliveries }
}

test('a key for a named app is checked and sent by the helper in one go, to what has the keyboard', async () => {
  // Cody's interleaving (review of #856): two named keys in parallel, each bringing its app forward.
  const state = { front: 'Finder' }
  const { use, calls, deliveries } = helper('3', state)
  const tools = computerUseTools(use)
  const answers = await Promise.all([
    tools.computer_key!.execute!({ app: 'TextEdit', key: 'cmd+a', front: true }, options()),
    tools.computer_key!.execute!({ app: 'Calculator', key: 'escape', front: true }, options()),
  ])
  assert.deepEqual(answers, [
    { to: 'TextEdit', broughtToFront: true },
    { to: 'Calculator', broughtToFront: true },
  ])
  assert.deepEqual(deliveries, ['cmd+a -> TextEdit', 'escape -> Calculator'])
  // The keyboard's key with its app, which the helper checks: a save sheet's Cmd+Shift+G reaches
  // the panel, which runs in a process of its own.
  assert.deepEqual(
    calls.filter((c) => c.method === 'key').map((c) => c.params),
    [
      { key: 'cmd+a', app: 'TextEdit' },
      { key: 'escape', app: 'Calculator' },
    ],
  )
})

test('another app coming to the front between the check and the key: nothing is sent', async () => {
  // Cody's case (review of #874): computer_open_app for Calculator after computer_key's check.
  const state = { front: 'TextEdit' }
  const { use, deliveries } = helper('3', state)
  const tools = computerUseTools(use)
  const realRequest = use.request
  use.request = async (method, params, signal, options) => {
    if (method === 'key') state.front = 'Calculator'
    return realRequest(method, params, signal, options)
  }
  await assert.rejects(
    tools.computer_key!.execute!({ app: 'TextEdit', key: 'cmd+w' }, options()) as Promise<unknown>,
    /TextEdit is not in front \(Calculator is\), so nothing was sent: another app came to the front/,
  )
  assert.deepEqual(deliveries, [])
})

test("with an older helper, a named key goes to the app's process, and says what it misses", async () => {
  const state = { front: 'TextEdit' }
  const { use, calls } = helper('2', state)
  const pressed: string[] = []
  const appInput: AppInput = {
    press: async (app, key) => {
      pressed.push(`${key} -> ${app}`)
      return { delivery: 'delivered_unverified' }
    },
    type: async () => ({}),
    windows: async () => [],
  }
  const answer = (await computerUseTools(use, appInput).computer_key!.execute!(
    { app: 'TextEdit', key: 'cmd+b' },
    options(),
  )) as Record<string, string>
  assert.equal(answer.delivery, 'delivered_unverified')
  assert.match(
    answer.note!,
    /Open and Save panels don't get keys this way until Brigade.app is updated/,
  )
  assert.deepEqual(pressed, ['cmd+b -> TextEdit'])
  assert.ok(calls.every((c) => c.method !== 'key'))
})

test('a key for an app behind another is refused, unless front: true brings it forward first', async () => {
  const state = { front: 'Google Chrome' }
  const { use, calls, deliveries } = helper('3', state)
  const tools = computerUseTools(use)
  await assert.rejects(
    tools.computer_key!.execute!({ key: 'cmd+s', app: 'TextEdit' }, options()) as Promise<unknown>,
    /TextEdit is behind Google Chrome.*nothing was sent.*front: true/s,
  )
  assert.deepEqual(
    calls.map((c) => c.method),
    ['apps'],
  )
  assert.deepEqual(
    await tools.computer_key!.execute!({ key: 'cmd+s', app: 'TextEdit', front: true }, options()),
    { to: 'TextEdit', broughtToFront: true },
  )
  assert.deepEqual(deliveries, ['cmd+s -> TextEdit'])
  // Already in front (by its bundle id here): sent as it is.
  const inFront = computer(async (call) =>
    call.method === 'status'
      ? { version: '3' }
      : { apps: [{ name: 'TextEdit', bundleId: 'com.apple.TextEdit', active: true }] },
  )
  assert.deepEqual(
    await computerUseTools(inFront.use).computer_key!.execute!(
      { key: 'cmd+b', app: 'com.apple.textedit' },
      options(),
    ),
    { to: 'com.apple.textedit' },
  )
})

test('opening an app answers once a window of it is there, with its windows', async () => {
  let asked = 0
  const appInput: AppInput = {
    press: async () => ({}),
    type: async () => ({}),
    windows: async () => (++asked < 3 ? [] : [{ id: 'w-1', title: 'Open' }]),
  }
  const { use } = computer(async () => ({ name: 'TextEdit', active: true }))
  assert.deepEqual(
    await computerUseTools(use, appInput).computer_open_app!.execute!(
      { app: 'TextEdit' },
      options(),
    ),
    { name: 'TextEdit', active: true, windows: [{ id: 'w-1', title: 'Open' }] },
  )
  assert.equal(asked, 3)
})

test('a key without an app goes to the app in front, which the answer names', async () => {
  const { use, calls } = computer(async (call) =>
    call.method === 'apps'
      ? {
          apps: [
            { name: 'Brigade', active: true },
            { name: 'TextEdit', active: false },
          ],
        }
      : { ok: true },
  )
  assert.deepEqual(
    await computerUseTools(use).computer_key!.execute!({ key: 'return' }, options()),
    { ok: true, front: 'Brigade' },
  )
  assert.deepEqual(
    calls.map((c) => [c.method, c.params]),
    [
      ['apps', {}],
      ['key', { key: 'return' }],
    ],
  )
})

test('opening an app: a Stop while waiting for its window ends the call with the Stop', async () => {
  let asked = 0
  const appInput: AppInput = {
    press: async () => ({}),
    type: async () => ({}),
    windows: async () => {
      asked++
      throw new ComputerUseError(
        'stopped',
        'The person pressed Stop on the computer-use indicator.',
      )
    },
  }
  const { use } = computer(async () => ({ name: 'TextEdit', active: true }))
  await assert.rejects(
    computerUseTools(use, appInput).computer_open_app!.execute!(
      { app: 'TextEdit' },
      options(),
    ) as Promise<unknown>,
    (error: unknown) => error instanceof ComputerUseError && error.code === 'stopped',
  )
  assert.equal(asked, 1)
})

test('text for a named app goes into its focused field from behind, and nothing through the keyboard', async () => {
  const typed: string[] = []
  const appInput: AppInput = {
    press: async () => ({}),
    type: async (app, text) => {
      typed.push(`${app}:${text}`)
      return { delivery: 'delivered_verified' }
    },
    windows: async () => [],
  }
  const { use, calls } = computer(async () => ({ ok: true }))
  assert.deepEqual(
    await computerUseTools(use, appInput).computer_type!.execute!(
      { app: 'TextEdit', text: 'hi' },
      options(),
    ),
    { to: 'TextEdit', delivery: 'delivered_verified' },
  )
  assert.deepEqual(typed, ['TextEdit:hi'])
  assert.deepEqual(calls, [])
})
