import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { parseMentions } from '@brigade/contracts'

const home = await mkdtemp(join(tmpdir(), 'brigade-search-workspace-'))
process.env.BRIGADE_HOME = home
after(() => rm(home, { recursive: true, force: true }))
const { libraryTools } = await import('../src/harness/tools.js')

/** search_workspace over what the API found: what the teammate gets. */
async function search(hits: Record<string, unknown>[]) {
  const tools = libraryTools({
    access: 'read',
    libraryDir: '/library',
    readFile: async () => Buffer.from(''),
    stageFile: async () => {
      throw new Error('not here')
    },
    listFiles: async () => [],
    renderDesign: async () => ({ screenshots: [], errors: [] }),
    call: async () => hits,
  })
  return (await tools.search_workspace!.execute!({ query: 'project library' }, {
    toolCallId: 'c1',
    messages: [],
  } as never)) as Record<string, unknown>[]
}

test("a thread found by its summary comes with its mention, which the dashboard shows as the thread's link", async () => {
  const [found] = await search([
    {
      kind: 'thread_summary',
      path: 'threads/cmvfn0172000bpsp7mr4edpls.md',
      documentId: 'd1',
      sessionId: 'cmvfn0172000bpsp7mr4edpls',
      title: 'Thread: Structurer les specs techniques du projet',
      snippet: 'le skill «project-library»',
    },
  ])
  assert.equal(
    found!.mention,
    '@[Structurer les specs techniques du projet](thread:cmvfn0172000bpsp7mr4edpls)',
  )
  assert.deepEqual(parseMentions(found!.mention as string), [
    {
      kind: 'thread',
      id: 'cmvfn0172000bpsp7mr4edpls',
      label: 'Structurer les specs techniques du projet',
    },
  ])
  // What the API found stays as it was.
  assert.equal(found!.title, 'Thread: Structurer les specs techniques du projet')
})

test('a title that would break the mention is made safe, and a thread with none is named by its id', async () => {
  const [bracket, untitled] = await search([
    {
      kind: 'thread_summary',
      path: 'threads/t1.md',
      sessionId: 't1',
      title: 'Thread: Fix [beta] flag',
    },
    { kind: 'thread_summary', path: 'threads/t2.md', sessionId: 't2', title: 'Thread: ' },
  ])
  assert.equal(bracket!.mention, '@[Fix [beta  flag](thread:t1)')
  assert.equal(parseMentions(bracket!.mention as string).length, 1)
  assert.equal(untitled!.mention, '@[t2](thread:t2)')
})

test('only threads get a mention: a library file gets its path here, memory nothing', async () => {
  const [file, memory, archived] = await search([
    {
      kind: 'library',
      path: 'Projects/Brigade/specs.md',
      sessionId: null,
      title: 'Projects/Brigade/specs.md',
    },
    { kind: 'workspace_memory', path: 'workspace.md', sessionId: null, title: 'Workspace memory' },
    {
      kind: 'archived_memory',
      path: 'workspace.md',
      sessionId: 't3',
      title: 'Archived from workspace memory on 2026-11-01: replaced',
    },
  ])
  assert.equal(file!.file, '/library/Projects/Brigade/specs.md')
  for (const hit of [file, memory, archived]) assert.equal(hit!.mention, undefined)
})
