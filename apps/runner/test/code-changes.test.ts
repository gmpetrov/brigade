import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
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
  assert.equal(changeStatus('AD'), 'A')
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

test('a staged file deleted from the folder still shows, and reverting leaves the index', async () => {
  await writeFile(join(landing, 'staged-gone.tsx'), 'gone\n')
  git('add', 'apps/web/landing/staged-gone.tsx')
  await rm(join(landing, 'staged-gone.tsx'))
  assert.deepEqual((await changes()).changes, [
    { path: 'brigade/apps/web/landing/staged-gone.tsx', status: 'A' },
  ])
  const result = await codeFiles({
    ...ids,
    op: 'revert',
    paths: ['brigade/apps/web/landing/staged-gone.tsx'],
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(git('status', '--porcelain'), '')
})

test('a new link leading nowhere is reverted: gone', async () => {
  await symlink(join(landing, 'nowhere'), join(landing, 'dangling.tsx'))
  assert.deepEqual((await changes()).changes, [
    { path: 'brigade/apps/web/landing/dangling.tsx', status: 'A' },
  ])
  const result = await codeFiles({
    ...ids,
    op: 'revert',
    paths: ['brigade/apps/web/landing/dangling.tsx'],
  })
  assert.equal(result.ok, true, result.error)
  await assert.rejects(lstat(join(landing, 'dangling.tsx')))
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

test('on a branch off the default branch: what changed since it left, committed or not', async () => {
  // The default branch, as last fetched, where the branch leaves it.
  const left = git('rev-parse', 'HEAD').trim()
  git('update-ref', 'refs/remotes/origin/main', left)
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  git('checkout', '-q', '-b', 'brigade/riley')
  await writeFile(join(landing, 'hero.tsx'), '<h1>Three teams</h1>\n')
  await writeFile(join(landing, 'committed.tsx'), 'committed\n')
  git('add', '.')
  git('commit', '-q', '-m', 'on the branch')
  await writeFile(join(landing, 'closing.tsx'), '<p>Not yet committed.</p>\n')
  await writeFile(join(landing, 'untracked.tsx'), 'untracked\n')
  const result = await changes()
  assert.equal(result.base, 'main')
  assert.deepEqual(result.changes, [
    { path: 'brigade/apps/web/landing/closing.tsx', status: 'M' },
    { path: 'brigade/apps/web/landing/committed.tsx', status: 'A' },
    { path: 'brigade/apps/web/landing/hero.tsx', status: 'M' },
    { path: 'brigade/apps/web/landing/untracked.tsx', status: 'A' },
  ])
  assert.match(result.head ?? '', new RegExp(`:${left}$`))
  // As on the default branch, not as in the branch's last commit.
  const original = await codeFiles({
    ...ids,
    op: 'original',
    path: 'brigade/apps/web/landing/hero.tsx',
  })
  assert.equal(original.original, '<h1>Two teams</h1>\n')

  const reverted = await codeFiles({
    ...ids,
    op: 'revert',
    paths: ['brigade/apps/web/landing/hero.tsx', 'brigade/apps/web/landing/committed.tsx'],
  })
  assert.equal(reverted.ok, true, reverted.error)
  assert.equal(reverted.base, 'main')
  assert.equal(await readFile(join(landing, 'hero.tsx'), 'utf8'), '<h1>Two teams</h1>\n')
  await assert.rejects(stat(join(landing, 'committed.tsx')))
  assert.deepEqual(
    (await changes()).changes?.map((c) => c.path),
    ['brigade/apps/web/landing/closing.tsx', 'brigade/apps/web/landing/untracked.tsx'],
  )

  // With nothing to compare to, the last commit again.
  git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD')
  git('update-ref', '-d', 'refs/remotes/origin/main')
  const alone = await changes()
  assert.equal(alone.base, undefined)
  assert.deepEqual(
    alone.changes?.map((c) => c.path),
    [
      'brigade/apps/web/landing/closing.tsx',
      'brigade/apps/web/landing/committed.tsx',
      'brigade/apps/web/landing/hero.tsx',
      'brigade/apps/web/landing/untracked.tsx',
    ],
  )
})

test('several repositories: their base said only when each compares to one', async () => {
  const other = join(dir, 'other')
  const inOther = (...args: string[]) =>
    execFileSync('git', ['-C', other, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    }).toString()
  await mkdir(other, { recursive: true })
  inOther('init', '-q')
  await writeFile(join(other, 'a.txt'), 'a\n')
  inOther('add', '.')
  inOther('commit', '-q', '-m', 'first')
  inOther('update-ref', 'refs/remotes/origin/main', inOther('rev-parse', 'HEAD').trim())
  inOther('checkout', '-q', '-b', 'brigade/riley')
  // brigade/ has no default branch since the test before: its last commit.
  assert.equal((await changes()).base, undefined)
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD~1').trim())
  assert.equal((await changes()).base, 'main')
})
