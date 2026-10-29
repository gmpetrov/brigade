import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'brigade-save-design-'))
process.env.BRIGADE_HOME = home
after(() => rm(home, { recursive: true, force: true }))
const { libraryTools } = await import('../src/harness/tools.js')

type Operation = { name: string; path: string }

/** save_design over a library holding these folders: what it asked the API, and its result. */
async function save(path: string, library: string[]) {
  const asked: Operation[] = []
  const tools = libraryTools({
    access: 'read_write',
    libraryDir: '/library',
    readFile: async (file) =>
      Buffer.from(file.endsWith('design.json') ? '{"title":"Landing"}' : '<p>Hi</p>'),
    listFiles: async () => ['index.html', 'design.json', 'thumbnail.png'],
    renderDesign: async () => ({ screenshots: [], errors: [] }),
    call: async ({ operation }) => {
      const op = operation as Operation
      asked.push({ name: op.name, path: op.path })
      if (op.name === 'design_edits') return []
      if (op.name === 'delete' && !library.includes(op.path))
        throw new Error(`Nothing in the library at ${op.path}.`)
      return {}
    },
  })
  const result = await tools.save_design!.execute!({ folder: '/work/landing', path }, {
    toolCallId: 'c1',
    messages: [],
  } as never)
  return { asked, result: result as { path: string; files: number; optionsTrashed?: string } }
}

test('saving a design sends the options offered for it to the trash', async () => {
  const { asked, result } = await save('acme/landing.design', ['acme/landing.options'])
  assert.deepEqual(asked.at(-1), { name: 'delete', path: 'acme/landing.options' })
  assert.equal(asked.filter((o) => o.name === 'save').length, 3)
  assert.deepEqual(result, {
    path: 'acme/landing.design',
    files: 3,
    optionsTrashed: 'acme/landing.options',
  })
})

test('a design with no options left is saved as before', async () => {
  const { result } = await save('acme/landing.design', [])
  assert.deepEqual(result, { path: 'acme/landing.design', files: 3 })
})

test('saving an option leaves the other options alone', async () => {
  const { asked, result } = await save('acme/landing.options/a-bold.design', [
    'acme/landing.options',
  ])
  assert.ok(!asked.some((o) => o.name === 'delete' && o.path === 'acme/landing.options'))
  assert.equal(result.optionsTrashed, undefined)
})
