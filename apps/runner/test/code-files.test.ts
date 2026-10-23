import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'brigade-code-'))
process.env.BRIGADE_HOME = home
const { codeFiles, matchFiles } = await import('../src/code-files.js')

const dir = join(home, 'teammates', 'riley', 'threads', 'thread1')
const web = join(dir, 'brigade', 'apps', 'web')
await mkdir(join(web, 'components', 'landing'), { recursive: true })
await mkdir(join(web, 'node_modules', 'react'), { recursive: true })
await mkdir(join(dir, 'brigade', '.git'), { recursive: true })
await writeFile(join(web, 'components', 'landing', 'plans.tsx'), '<h3>Stack your plans</h3>\n')
await writeFile(join(web, 'components', 'landing', 'hero.tsx'), '<h1>Your AI team</h1>\n')
await writeFile(join(web, 'node_modules', 'react', 'plans.js'), 'Stack your plans')
await writeFile(join(web, '.gitignore'), 'node_modules\n')
await writeFile(join(web, 'Zeta.md'), '# z\n')
await writeFile(join(dir, 'brigade', '.git', 'plans-index'), 'x')
await writeFile(join(home, 'secret.txt'), 'secret')
await symlink(home, join(dir, 'out'))

const ids = {
  type: 'thread.code' as const,
  requestId: 'r',
  sessionId: 'thread1',
  teammateId: 'riley',
}

test('a folder lists its folders first, then its files, by name', async () => {
  const web_ = await codeFiles({ ...ids, op: 'list', path: 'brigade/apps/web' })
  assert.equal(web_.ok, true)
  assert.deepEqual(web_.entries, [
    { name: 'components', dir: true },
    { name: 'node_modules', dir: true },
    { name: '.gitignore', dir: false },
    { name: 'Zeta.md', dir: false },
  ])
  const root = await codeFiles({ ...ids, op: 'list', path: '' })
  assert.deepEqual(
    root.entries?.map((e) => e.name),
    ['brigade', 'out'],
  )
})

test('nothing outside the working folder lists, links included', async () => {
  for (const path of ['..', '../..', 'out', home, 'nope'])
    assert.equal((await codeFiles({ ...ids, op: 'list', path })).ok, false, path)
  const bad = await codeFiles({ ...ids, sessionId: '../x', op: 'list', path: '' })
  assert.equal(bad.ok, false)
})

test('files by name, best first, without dependencies or git', async () => {
  const found = await codeFiles({ ...ids, op: 'find', query: 'plans' })
  assert.deepEqual(found.files, ['brigade/apps/web/components/landing/plans.tsx'])
  const words = await codeFiles({ ...ids, op: 'find', query: 'landing tsx' })
  assert.deepEqual(found.ok && words.files?.sort(), [
    'brigade/apps/web/components/landing/hero.tsx',
    'brigade/apps/web/components/landing/plans.tsx',
  ])
})

test('lines by text, case aside, leaving out what git ignores', async () => {
  const found = await codeFiles({ ...ids, op: 'grep', query: 'stack YOUR plans' })
  assert.equal(found.ok, true)
  assert.deepEqual(found.matches, [
    {
      path: 'brigade/apps/web/components/landing/plans.tsx',
      line: 1,
      preview: '<h3>Stack your plans</h3>',
    },
  ])
  assert.deepEqual((await codeFiles({ ...ids, op: 'grep', query: 'nowhere at all' })).matches, [])
})

test('hashes of open files; null once one is gone or outside', async () => {
  const path = 'brigade/apps/web/components/landing/hero.tsx'
  const sha = (t: string) => createHash('sha256').update(t).digest('hex')
  const first = await codeFiles({
    ...ids,
    op: 'hashes',
    paths: [path, 'out/secret.txt', 'nope.ts'],
  })
  assert.deepEqual(first.hashes, {
    [path]: sha('<h1>Your AI team</h1>\n'),
    'out/secret.txt': null,
    'nope.ts': null,
  })
  await rm(join(dir, path))
  assert.deepEqual((await codeFiles({ ...ids, op: 'hashes', paths: [path] })).hashes, {
    [path]: null,
  })
})

test('matchFiles: every word, the name first, shorter paths first', () => {
  const paths = [
    'a/landing/plans.tsx',
    'plans/readme.md',
    'a/b/c/plans.tsx',
    'x/myplans.ts',
    'z.ts',
  ]
  assert.deepEqual(matchFiles(paths, 'plans'), [
    'a/b/c/plans.tsx',
    'a/landing/plans.tsx',
    'x/myplans.ts',
    'plans/readme.md',
  ])
  assert.deepEqual(matchFiles(paths, 'landing plans'), ['a/landing/plans.tsx'])
  assert.deepEqual(matchFiles(paths, '  '), [])
})
