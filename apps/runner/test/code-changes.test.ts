import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'brigade-changes-'))
process.env.BRIGADE_HOME = home
const { codeFiles, changeStatus, parseStatus } = await import('../src/code-files.js')

const dir = join(home, 'teammates', 'riley', 'threads', 'thread1')
const repo = join(dir, 'brigade')
const landing = join(repo, 'apps', 'web', 'landing')
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  }).toString()

await mkdir(landing, { recursive: true })
await mkdir(join(dir, 'attachments'), { recursive: true })
await writeFile(join(dir, 'attachments', 'shot.txt'), 'not in a repository\n')
git('init', '-q')
await writeFile(join(landing, 'closing.tsx'), '<p>He does the work.</p>\n')
await writeFile(join(landing, 'hero.tsx'), '<h1>One team</h1>\n')
await writeFile(join(landing, 'old.tsx'), 'old\n')
await writeFile(join(landing, 'staged.tsx'), 'staged\n')
await writeFile(join(repo, '.gitignore'), 'node_modules\n')
git('add', '.')
git('commit', '-q', '-m', 'first')
await mkdir(join(repo, 'node_modules'), { recursive: true })
await writeFile(join(repo, 'node_modules', 'x.js'), 'ignored\n')

const ids = {
  type: 'thread.code' as const,
  requestId: 'r',
  sessionId: 'thread1',
  teammateId: 'riley',
}
const changes = async () => {
  const result = await codeFiles({ ...ids, op: 'changes' })
  assert.equal(result.ok, true, result.error)
  return result
}

test('the status against the last commit, from git status', () => {
  assert.equal(changeStatus('??'), 'A')
  assert.equal(changeStatus('A '), 'A')
  assert.equal(changeStatus('AM'), 'A')
  assert.equal(changeStatus('AD'), undefined)
  assert.equal(changeStatus(' M'), 'M')
  assert.equal(changeStatus('MM'), 'M')
  assert.equal(changeStatus('UU'), 'M')
  assert.equal(changeStatus(' D'), 'D')
  assert.equal(changeStatus('D '), 'D')
  assert.deepEqual(parseStatus(' M a.ts\0?? new/b.ts\0?? nested/\0', 'repo'), [
    { path: 'repo/a.ts', status: 'M' },
    { path: 'repo/new/b.ts', status: 'A' },
  ])
})

test('nothing changed: no changes, and the head of each repository', async () => {
  const result = await changes()
  assert.deepEqual(result.changes, [])
  assert.match(result.head ?? '', /^brigade:[0-9a-f]{40}$/)
})

test('changed, new, deleted and staged files show, by their path in the folder', async () => {
  await writeFile(join(landing, 'closing.tsx'), '<p>They do the work.</p>\n')
  await writeFile(join(landing, 'pebble.tsx'), 'export {}\n')
  await writeFile(join(landing, 'staged.tsx'), 'staged and changed\n')
  git('add', 'apps/web/landing/staged.tsx')
  git('rm', '-q', 'apps/web/landing/old.tsx')
  const result = await changes()
  assert.deepEqual(result.changes, [
    { path: 'brigade/apps/web/landing/closing.tsx', status: 'M' },
    { path: 'brigade/apps/web/landing/old.tsx', status: 'D' },
    { path: 'brigade/apps/web/landing/pebble.tsx', status: 'A' },
    { path: 'brigade/apps/web/landing/staged.tsx', status: 'M' },
  ])
})

test('a file as in the last commit; null when new or in no repository', async () => {
  const original = (path: string) => codeFiles({ ...ids, op: 'original', path })
  assert.equal(
    (await original('brigade/apps/web/landing/closing.tsx')).original,
    '<p>He does the work.</p>\n',
  )
  // Deleted: still there in the commit.
  assert.equal((await original('brigade/apps/web/landing/old.tsx')).original, 'old\n')
  assert.equal((await original('brigade/apps/web/landing/pebble.tsx')).original, null)
  assert.equal((await original('attachments/shot.txt')).original, null)
  for (const path of ['../x', '/etc/passwd', home])
    assert.equal((await original(path)).original ?? null, null, path)
})

test('reverting puts files back as committed, new ones gone, nothing left to commit', async () => {
  const result = await codeFiles({
    ...ids,
    op: 'revert',
    paths: [
      'brigade/apps/web/landing/closing.tsx',
      'brigade/apps/web/landing/old.tsx',
      'brigade/apps/web/landing/pebble.tsx',
      'brigade/apps/web/landing/staged.tsx',
    ],
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(await readFile(join(landing, 'closing.tsx'), 'utf8'), '<p>He does the work.</p>\n')
  assert.equal(await readFile(join(landing, 'old.tsx'), 'utf8'), 'old\n')
  assert.equal(await readFile(join(landing, 'staged.tsx'), 'utf8'), 'staged\n')
  await assert.rejects(stat(join(landing, 'pebble.tsx')))
  assert.deepEqual((await changes()).changes, [])
  assert.equal(git('status', '--porcelain'), '')
})

test('a new file staged, then reverted, leaves the index too', async () => {
  await mkdir(join(landing, 'fresh'), { recursive: true })
  await writeFile(join(landing, 'fresh', 'a.tsx'), 'a\n')
  git('add', '.')
  assert.equal((await changes()).changes?.[0]?.status, 'A')
  const result = await codeFiles({
    ...ids,
    op: 'revert',
    paths: ['brigade/apps/web/landing/fresh/a.tsx'],
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(git('status', '--porcelain'), '')
})

test('nothing outside a repository of the working folder is reverted', async () => {
  for (const path of ['attachments/shot.txt', '../x', '/etc/passwd']) {
    const result = await codeFiles({ ...ids, op: 'revert', paths: [path] })
    assert.equal(result.ok, false, path)
  }
  assert.equal(
    await readFile(join(dir, 'attachments', 'shot.txt'), 'utf8'),
    'not in a repository\n',
  )
})

test('a commit changes the head', async () => {
  const before = (await changes()).head
  await writeFile(join(landing, 'hero.tsx'), '<h1>Two teams</h1>\n')
  git('commit', '-q', '-am', 'second')
  assert.notEqual((await changes()).head, before)
})
