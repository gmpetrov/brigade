import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'brigade-save-tool-'))
process.env.BRIGADE_HOME = home
after(() => rm(home, { recursive: true, force: true }))
const { libraryTools } = await import('../src/harness/tools.js')
const { builtinSkills } = await import('../src/instructions.js')

type Operation = { name: string; path: string }

/** The library tools of a teammate whose thread's starter has tools, or not. */
function toolsOf(options: { tools?: boolean; manifest?: string; files?: string[] }) {
  const asked: Operation[] = []
  const tools = libraryTools({
    access: 'read_write',
    libraryDir: '/library',
    readFile: async (file) =>
      Buffer.from(
        file.endsWith('tool.json') ? (options.manifest ?? '{"title":"Review"}') : '<p>Hi</p>',
      ),
    stageFile: async () => {
      throw new Error('not here')
    },
    listFiles: async () => options.files ?? ['index.html', 'tool.json', 'app.js'],
    renderDesign: async () => ({ screenshots: [], errors: [] }),
    call: async ({ operation }) => {
      const op = operation as Operation
      asked.push({ name: op.name, path: op.path })
      return op.name === 'save'
        ? { mention: `@[${op.path}](document:id-${op.path.split('/').pop()})` }
        : { shared: {} }
    },
    ...(options.tools !== undefined ? { tools: options.tools } : {}),
  })
  const run = (name: string, input: object) =>
    tools[name]!.execute!(input, { toolCallId: 'c1', messages: [] } as never)
  return { tools, asked, run }
}

test('only teammates of a thread whose starter has tools get them', () => {
  assert.equal(toolsOf({}).tools.save_tool, undefined)
  assert.equal(toolsOf({ tools: false }).tools.read_tool_state, undefined)
  assert.ok(toolsOf({ tools: true }).tools.save_tool)
})

test('saving a tool saves its folder and names it by its page', async () => {
  const { asked, run } = toolsOf({
    tools: true,
    manifest: '{"title":"Review","apps":[{"kind":"github"}]}',
  })
  const result = (await run('save_tool', {
    folder: '/work/review',
    path: 'film/review.tool/',
  })) as {
    path: string
    files: number
    mention: string
    accounts: string
  }
  assert.deepEqual(
    asked.map((o) => o.path),
    ['film/review.tool/index.html', 'film/review.tool/tool.json', 'film/review.tool/app.js'],
  )
  assert.equal(result.path, 'film/review.tool')
  assert.equal(result.files, 3)
  assert.equal(result.mention, '@[film/review.tool](document:id-index.html)')
  assert.match(result.accounts, /github/)
})

test('a tool needs its path, page and a valid tool.json; nothing is saved otherwise', async () => {
  for (const [options, input, error] of [
    [{}, { folder: '/w', path: 'film/review' }, /must end in/],
    [{ files: ['index.html'] }, { folder: '/w', path: 'a.tool' }, /no tool\.json/],
    [{ manifest: '{"title": 5}' }, { folder: '/w', path: 'a.tool' }, /not valid/],
    [{ manifest: 'not json' }, { folder: '/w', path: 'a.tool' }, /not valid/],
  ] as const) {
    const { asked, run } = toolsOf({ tools: true, ...options })
    await assert.rejects(run('save_tool', input), error)
    assert.equal(asked.length, 0)
  }
})

test('reading a tool’s state asks the API for that tool', async () => {
  const { asked, run } = toolsOf({ tools: true })
  await run('read_tool_state', { path: 'film/review.tool/' })
  assert.deepEqual(asked, [{ name: 'tool_state', path: 'film/review.tool' }])
})

test('the tools skill and section come with the feature only', () => {
  const spec = (tools: boolean) =>
    ({ tools, library: 'read_write', libraryFolders: [], designSystems: [] }) as never
  assert.ok(builtinSkills(spec(true), '/library').some((s) => s.name === 'brigade-tools'))
  assert.ok(!builtinSkills(spec(false), '/library').some((s) => s.name === 'brigade-tools'))
})
