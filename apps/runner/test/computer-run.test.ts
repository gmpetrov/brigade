import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ComputerUseError, type RequestOptions } from '../src/computer-use.js'
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
