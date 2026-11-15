import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ComputerUseError, Line, type RequestOptions } from '../src/computer-use.js'
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

test('a key for an app brings it to the front first, and says which app got it', async () => {
  const { use, calls } = computer(async (call) =>
    call.method === 'open_app'
      ? { name: 'TextEdit', active: true }
      : call.method === 'apps'
        ? {
            apps: [
              { name: 'Brigade', active: true },
              { name: 'TextEdit', active: false },
            ],
          }
        : { ok: true },
  )
  const tools = computerUseTools(use)
  assert.deepEqual(
    await tools.computer_key!.execute!({ key: 'cmd+n', app: 'TextEdit' }, options()),
    {
      ok: true,
      to: 'TextEdit',
    },
  )
  assert.deepEqual(
    calls.map((c) => [c.method, c.params]),
    [
      ['open_app', { app: 'TextEdit' }],
      ['key', { key: 'cmd+n' }],
    ],
  )
  // Without one: sent to the app in front, which the answer names.
  assert.deepEqual(await tools.computer_type!.execute!({ text: 'hi' }, options()), {
    ok: true,
    to: 'Brigade',
  })
  assert.deepEqual(
    calls.slice(2).map((c) => [c.method, c.params]),
    [
      ['apps', {}],
      ['type', { text: 'hi' }],
    ],
  )
})

test('a key for an app that does not come to the front is not pressed', async () => {
  const { use, calls } = computer(async (call) =>
    call.method === 'open_app' ? { name: 'TextEdit', active: false } : { ok: true },
  )
  await assert.rejects(
    computerUseTools(use).computer_key!.execute!(
      { key: 'cmd+s', app: 'TextEdit' },
      options(),
    ) as Promise<unknown>,
    /TextEdit did not come to the front, so nothing was sent/,
  )
  assert.deepEqual(
    calls.map((c) => c.method),
    ['open_app'],
  )
})
