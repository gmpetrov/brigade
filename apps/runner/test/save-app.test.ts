import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'brigade-save-app-'))
process.env.BRIGADE_HOME = home
after(() => rm(home, { recursive: true, force: true }))
const { libraryTools } = await import('../src/harness/tools.js')
const { builtinSkills } = await import('../src/instructions.js')

type Operation = { name: string; path: string }

/** The library tools of a teammate whose thread's starter has apps (`tools` in its spec), or not. */
function toolsOf(options: { tools?: boolean; manifest?: string; files?: string[] }) {
  const asked: Operation[] = []
  const tools = libraryTools({
    access: 'read_write',
    libraryDir: '/library',
    readFile: async (file) =>
      Buffer.from(
        /(app|tool)\.json$/.test(file) ? (options.manifest ?? '{"title":"Review"}') : '<p>Hi</p>',
      ),
    stageFile: async () => {
      throw new Error('not here')
    },
    listFiles: async () => options.files ?? ['index.html', 'app.json', 'app.js'],
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

test('only teammates of a thread whose starter has apps get them', () => {
  assert.equal(toolsOf({}).tools.save_app, undefined)
  assert.equal(toolsOf({ tools: false }).tools.read_app_state, undefined)
  assert.ok(toolsOf({ tools: true }).tools.save_app)
})

test('save_tool and read_tool_state, their names before the rename, still work', async () => {
  const { asked, run } = toolsOf({ tools: true })
  await run('save_tool', { folder: '/w', path: 'film/review.webapp' })
  await run('read_tool_state', { path: 'film/review.webapp' })
  assert.deepEqual(asked.at(-1), { name: 'tool_state', path: 'film/review.webapp' })
  assert.ok(asked.some((o) => o.name === 'save' && o.path === 'film/review.webapp/app.json'))
})

test('saving an app saves its folder and names it by its page', async () => {
  const { asked, run } = toolsOf({
    tools: true,
    manifest: '{"title":"Review","apps":[{"kind":"github"}]}',
  })
  const result = (await run('save_app', {
    folder: '/work/review',
    path: 'film/review.webapp/',
  })) as {
    path: string
    files: number
    mention: string
    accounts: string
  }
  assert.deepEqual(
    asked.map((o) => o.path),
    ['film/review.webapp/index.html', 'film/review.webapp/app.json', 'film/review.webapp/app.js'],
  )
  assert.equal(result.path, 'film/review.webapp')
  assert.equal(result.files, 3)
  assert.equal(result.mention, '@[film/review.webapp](document:id-index.html)')
  assert.match(result.accounts, /github/)
})

test('an app saved before the rename saves again under its .tool path, with its tool.json', async () => {
  const { asked, run } = toolsOf({ tools: true, files: ['index.html', 'tool.json'] })
  const result = (await run('save_app', { folder: '/w', path: 'film/review.tool' })) as {
    path: string
  }
  assert.equal(result.path, 'film/review.tool')
  assert.deepEqual(
    asked.map((o) => o.path),
    ['film/review.tool/index.html', 'film/review.tool/tool.json'],
  )
})

test('an app needs its path, page and a valid app.json; nothing is saved otherwise', async () => {
  for (const [options, input, error] of [
    [{}, { folder: '/w', path: 'film/review' }, /must end in "<name>\.webapp"/],
    [{}, { folder: '/w', path: 'film/.webapp' }, /must end in/],
    [{}, { folder: '/w', path: 'a.webapp/b.webapp' }, /must end in/],
    [{ files: ['index.html'] }, { folder: '/w', path: 'a.webapp' }, /no app\.json/],
    [{ files: ['app.json'] }, { folder: '/w', path: 'a.webapp' }, /no index\.html/],
    [{ manifest: '{"title": 5}' }, { folder: '/w', path: 'a.webapp' }, /app\.json is not valid/],
    [{ manifest: 'not json' }, { folder: '/w', path: 'a.webapp' }, /not valid/],
  ] as const) {
    const { asked, run } = toolsOf({ tools: true, ...options })
    await assert.rejects(run('save_app', input), error)
    assert.equal(asked.length, 0)
  }
})

test('reading an app’s state asks the API for that app', async () => {
  const { asked, run } = toolsOf({ tools: true })
  await run('read_app_state', { path: 'film/review.webapp/' })
  assert.deepEqual(asked, [{ name: 'tool_state', path: 'film/review.webapp' }])
})

test('the apps skill and section come with the feature only', () => {
  const spec = (tools: boolean) =>
    ({ tools, library: 'read_write', libraryFolders: [], designSystems: [] }) as never
  assert.ok(builtinSkills(spec(true), '/library').some((s) => s.name === 'brigade-apps'))
  assert.ok(!builtinSkills(spec(false), '/library').some((s) => s.name === 'brigade-apps'))
})
