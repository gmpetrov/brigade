import assert from 'node:assert/strict'
import { test } from 'node:test'
import { machineTools, type MachineRunTools } from '../src/harness/tools.js'

// run_on_machine's `library` (machine-library.ts): offered to a teammate that may save somewhere in
// the library, as save_to_library is, and refused to one that may not rather than dropped; what it
// saved comes back by its mention, for the reply.

const options = { toolCallId: 'c1', messages: [] }
const noCredentials = { env: async () => ({ file: '/dev/null' }) } as never

function fakeRuns() {
  const given: Parameters<MachineRunTools['run']>[0][] = []
  const runs: MachineRunTools = {
    run: async (input) => {
      given.push(input)
      return {
        id: 'r1',
        command: input.command,
        cwd: input.cwd ?? '.',
        status: 'succeeded',
        exitCode: 0,
        startedAt: new Date().toISOString(),
        seconds: 1,
        ...(input.library?.length
          ? {
              library: input.library.map((item) => ({
                file: `${input.cwd}/${item.from}`,
                path: item.to,
                size: '1.0 MB',
                mention: `@[${item.to}](document:d1)`,
              })),
            }
          : {}),
        notes: [],
      }
    },
    get: async () => {
      throw new Error('not here')
    },
    stop: async () => {
      throw new Error('not here')
    },
    list: () => [],
  }
  return { runs, given }
}

const schema = (tools: ReturnType<typeof machineTools>) =>
  (tools.run_on_machine!.inputSchema as unknown as { jsonSchema: { properties: object } })
    .jsonSchema.properties

test('a teammate that may save to the library saves from the machine, and is told the mention', async () => {
  const { runs, given } = fakeRuns()
  const tools = machineTools(runs, noCredentials, undefined, { library: true })
  assert.ok('library' in schema(tools))
  assert.match(
    String(tools.run_on_machine!.description),
    /goes there from the machine with `library`/,
  )
  const library = [{ from: 'renders/video.mp4', to: 'Projects/X/videos/video.mp4' }]
  const result = (await tools.run_on_machine!.execute!(
    { command: 'npx hyperframes render', cwd: 'video', library, waitMinutes: 1 },
    options,
  )) as { note: string }
  assert.deepEqual(given[0]?.library, library)
  assert.match(
    result.note,
    /Saved to the library from the machine: @\[Projects\/X\/videos\/video\.mp4\]\(document:d1\)\. Name each by its mention/,
  )
})

test('a teammate that may not save to the library is not offered it, and is refused it', async () => {
  const { runs, given } = fakeRuns()
  const tools = machineTools(runs, noCredentials)
  assert.ok(!('library' in schema(tools)))
  assert.doesNotMatch(String(tools.run_on_machine!.description), /`library`/)
  await assert.rejects(
    tools.run_on_machine!.execute!(
      { command: 'true', cwd: 'video', library: [{ from: 'a.mp4', to: 'X/a.mp4' }] },
      options,
    ),
    /You may not save to the library: name the files in `outputs`/,
  )
  assert.equal(given.length, 0)
})
