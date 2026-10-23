import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'brigade-files-'))
process.env.BRIGADE_HOME = home
const { findSource, fragments, rank, readThreadFile, writeThreadFile } =
  await import('../src/files.js')

const dir = join(home, 'teammates', 'riley', 'threads', 'thread1')
const app = join(dir, 'brigade', 'apps', 'web')
const hero = `export function Plans() {
  return (
    <h2 id="plans-title">
      Your Claude and ChatGPT plans,
      <br /> working as a team.
    </h2>
  )
}
`
await mkdir(join(app, 'components'), { recursive: true })
await mkdir(join(app, 'node_modules', 'lib'), { recursive: true })
await writeFile(join(app, 'components', 'plans.tsx'), hero)
await writeFile(join(app, 'components', 'plans.test.tsx'), "expect('working as a team')")
await writeFile(join(app, 'node_modules', 'lib', 'index.js'), "'working as a team'")
await writeFile(join(app, '.gitignore'), 'node_modules\n')
await writeFile(join(home, 'outside.txt'), 'secret')
await symlink(join(home, 'outside.txt'), join(dir, 'link.txt'))

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const ids = { requestId: 'r', sessionId: 'thread1' }

test('a text file of the working folder reads with its hash', async () => {
  const read = await readThreadFile({
    type: 'thread.file.read',
    ...ids,
    teammateIds: ['riley'],
    path: 'brigade/apps/web/components/plans.tsx',
  })
  assert.equal(read.ok, true)
  assert.equal(read.text, hero)
  assert.equal(read.hash, sha(hero))
})

test('a save writes the file while it is as it was read, and refuses once it changed', async () => {
  const path = 'brigade/apps/web/components/plans.tsx'
  const edited = hero.replace('working as a team', 'working together')
  const saved = await writeThreadFile({
    type: 'thread.file.write',
    ...ids,
    teammateId: 'riley',
    path,
    text: edited,
    base: sha(hero),
  })
  assert.deepEqual(saved, {
    type: 'thread.file.written',
    requestId: 'r',
    ok: true,
    hash: sha(edited),
  })
  assert.equal(await readFile(join(dir, path), 'utf8'), edited)

  const stale = await writeThreadFile({
    type: 'thread.file.write',
    ...ids,
    teammateId: 'riley',
    path,
    text: 'lost',
    base: sha(hero),
  })
  assert.equal(stale.ok, false)
  assert.equal(stale.conflict, true)
  assert.equal(await readFile(join(dir, path), 'utf8'), edited)

  // Without a base: over whatever is there.
  const forced = await writeThreadFile({
    type: 'thread.file.write',
    ...ids,
    teammateId: 'riley',
    path,
    text: hero,
  })
  assert.equal(forced.ok, true)
  assert.equal(await readFile(join(dir, path), 'utf8'), hero)
})

test('saves of one file from the same base: one is written, the others conflict', async () => {
  const path = 'race.txt'
  await writeFile(join(dir, path), 'original')
  for (let round = 0; round < 10; round++) {
    await writeFile(join(dir, path), 'original')
    const results = await Promise.all(
      ['Alice', 'Bob', 'Carol'].map((text, i) =>
        writeThreadFile({
          type: 'thread.file.write',
          requestId: String(i),
          sessionId: 'thread1',
          teammateId: 'riley',
          path,
          text,
          base: sha('original'),
        }),
      ),
    )
    // One at a time, in whatever order they reach the file: one is written, the others
    // find it changed, and the file is the one written, whole.
    const won = results.filter((r) => r.ok)
    assert.equal(won.length, 1)
    assert.ok(results.filter((r) => !r.ok).every((r) => r.conflict))
    const winner = ['Alice', 'Bob', 'Carol'][results.indexOf(won[0]!)]
    assert.equal(await readFile(join(dir, path), 'utf8'), winner)
  }
})

test('a save never leaves the working folder, nor makes a file', async () => {
  for (const path of ['../../../../outside.txt', join(home, 'outside.txt'), 'link.txt', 'new.ts']) {
    const result = await writeThreadFile({
      type: 'thread.file.write',
      ...ids,
      teammateId: 'riley',
      path,
      text: 'x',
    })
    assert.equal(result.ok, false, path)
  }
  assert.equal(await readFile(join(home, 'outside.txt'), 'utf8'), 'secret')
  const sneaky = await writeThreadFile({
    type: 'thread.file.write',
    requestId: 'r',
    sessionId: '../thread1',
    teammateId: 'riley',
    path: 'brigade/apps/web/components/plans.tsx',
    text: 'x',
  })
  assert.equal(sneaky.ok, false)
})

test("an element's text is found in the source, tests and ignored folders last or left out", async () => {
  const result = await findSource({
    type: 'thread.source.find',
    ...ids,
    teammateId: 'riley',
    cwd: 'brigade/apps/web',
    // As the page shows it: on one line, uppercased by CSS.
    text: 'YOUR CLAUDE AND CHATGPT PLANS, WORKING AS A TEAM.',
    components: ['Page', 'Plans'],
  })
  assert.equal(result.ok, true)
  assert.deepEqual(
    result.matches?.map((m) => `${m.path}:${m.line}`),
    ['brigade/apps/web/components/plans.tsx:4'],
  )
  assert.equal(result.matches?.[0]?.preview, 'Your Claude and ChatGPT plans,')

  const outside = await findSource({
    type: 'thread.source.find',
    ...ids,
    teammateId: 'riley',
    cwd: '..',
    text: 'secret',
  })
  assert.equal(outside.ok, false)
})

test('fragments: the whole text, then its clauses, longest first', () => {
  assert.deepEqual(fragments('Your Claude and ChatGPT plans, working as a team.'), [
    'Your Claude and ChatGPT plans, working as a team.',
    'Your Claude and ChatGPT plans',
    'working as a team',
  ])
  assert.deepEqual(fragments('Stack your plans'), ['Stack your plans'])
})

test('rank: source files first, then those named after a component', () => {
  const m = (path: string) => ({ path, line: 1, preview: '' })
  assert.deepEqual(
    rank(
      [m('docs/a.md'), m('src/x.test.tsx'), m('src/hero.tsx'), m('src/plans.tsx')],
      ['Plans'],
    ).map((x) => x.path),
    ['src/plans.tsx', 'src/hero.tsx', 'docs/a.md', 'src/x.test.tsx'],
  )
})
