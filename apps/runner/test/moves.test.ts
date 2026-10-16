// A thread moving between computers: its folder handed over through the
// bucket, and its events numbered on after the API's on the computer it reaches.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'brigade-moves-'))
process.env.BRIGADE_HOME = home
const { Folders } = await import('../src/folders.js')
const { Outbox } = await import('../src/outbox.js')
const { threadFolder } = await import('../src/threads.js')
const { repairCaches } = await import('../src/repos.js')

test.after(() => rm(home, { recursive: true, force: true }))

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

/** The bucket, as files by thread and teammate. */
function bucket() {
  const archives = new Map<string, string>()
  const key = (f: { sessionId: string; teammateId: string }) => `${f.sessionId}/${f.teammateId}`
  return {
    archives,
    put: async (f: { sessionId: string; teammateId: string }, file: string) => {
      const kept = join(home, `${f.sessionId}-${f.teammateId}.tar.gz`)
      await copyFile(file, kept)
      archives.set(key(f), kept)
    },
    get: async (f: { sessionId: string; teammateId: string }, file: string) => {
      const kept = archives.get(key(f))
      if (!kept) return false
      await copyFile(kept, file)
      return true
    },
    delete: async (f: { sessionId: string; teammateId: string }) => {
      archives.delete(key(f))
    },
  }
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  })

test('a folder handed over comes back whole on arrival, in place of what was there', async () => {
  const store = bucket()
  const folders = new Folders({
    archives: store,
    inUse: () => false,
    stateFile: join(home, 'state', 'folders.json'),
    tempDir: join(home, 'state', 'folder-archives'),
  })
  const name = { sessionId: 'thread1', teammateId: 'teammate1' }
  const { workDir } = threadFolder(name.teammateId, name.sessionId)
  const repo = join(workDir, 'web')
  await mkdir(join(repo, 'node_modules', 'left-pad'), { recursive: true })
  git(repo, 'init', '-q')
  await writeFile(join(repo, '.gitignore'), 'node_modules/\n')
  await writeFile(join(repo, 'committed.txt'), 'pushed or not\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'first')
  await writeFile(join(repo, 'untracked.txt'), 'work in progress\n')
  await writeFile(join(workDir, 'notes.md'), 'what I was doing\n')

  await folders.release(name)
  assert.ok(store.archives.has('thread1/teammate1'), 'archived to the bucket')
  // A member's machine keeps its copy; it is out of date from now on.
  assert.ok(await exists(workDir))
  await writeFile(join(workDir, 'stale.txt'), 'from before\n')
  await rm(join(workDir, 'notes.md'))

  await folders.arrive(name, { at: '2026-10-16T10:00:00.000Z', from: 'the cloud computer' })
  assert.equal(await readFile(join(workDir, 'notes.md'), 'utf8'), 'what I was doing\n')
  assert.equal(await readFile(join(repo, 'untracked.txt'), 'utf8'), 'work in progress\n')
  assert.equal(git(repo, 'log', '--format=%s').toString().trim(), 'first')
  assert.equal(await exists(join(workDir, 'stale.txt')), false, 'what was here is replaced')
  assert.equal(await exists(join(repo, 'node_modules')), false, 'dependencies are installed again')
  assert.equal(store.archives.size, 0, 'the archive goes once it is back on disk')

  const note = await folders.takeNote(name, undefined)
  assert.match(note ?? '', /moved to this computer from the cloud computer, and your folder came/)
  assert.equal(await folders.takeNote(name, undefined), undefined, 'told once')

  // The same arrival again (a second message, a restart) changes nothing.
  await writeFile(join(workDir, 'later.txt'), 'written here since\n')
  await folders.arrive(name, { at: '2026-10-16T10:00:00.000Z', from: 'the cloud computer' })
  assert.ok(await exists(join(workDir, 'later.txt')))

  // Back from a computer that was offline: nothing handed over, what is here stays.
  await folders.arrive(name, { at: '2026-10-16T11:00:00.000Z', from: 'MacBook' })
  assert.ok(await exists(join(workDir, 'later.txt')))
  assert.match(
    (await folders.takeNote(name, undefined)) ?? '',
    /from MacBook, which could not hand your folder over/,
  )

  // Nothing here either: it starts empty, and says how to get the checkouts back.
  const other = { sessionId: 'thread2', teammateId: 'teammate1' }
  await folders.arrive(other, { at: '2026-10-16T12:00:00.000Z', from: 'MacBook' })
  assert.match((await folders.takeNote(other, undefined)) ?? '', /so it starts empty here/)
})

test('events go on after the last one the API has, once per arrival', async () => {
  const outbox = new Outbox(join(home, 'outbox'))
  const event = { at: new Date().toISOString(), type: 'raw', source: 'runner', value: 'x' } as const
  // Left from before the thread moved away, never acknowledged.
  outbox.push('thread1', event)
  outbox.push('thread1', event)
  assert.equal(outbox.arrive('thread1', 'arrival-1', 40), true)
  assert.equal(outbox.settled('thread1'), true, 'what was left from before is dropped')
  assert.equal(outbox.push('thread1', event).seq, 41)
  // Told again with the next message: nothing is renumbered.
  assert.equal(outbox.arrive('thread1', 'arrival-1', 40), false)
  assert.equal(outbox.push('thread1', event).seq, 42)
  // Kept across restarts.
  const again = new Outbox(join(home, 'outbox'))
  assert.equal(again.arrive('thread1', 'arrival-1', 40), false)
  assert.equal(again.push('thread1', event).seq, 43)
  assert.equal(again.arrive('thread1', 'arrival-2', 90), true)
  assert.equal(again.push('thread1', event).seq, 91)
})

test("a checkout brought from another computer borrows from this one's cache", async () => {
  // GitHub, through the proxy: a repository at <url>acme/web.git.
  const remotes = join(home, 'remotes')
  const work = join(home, 'work')
  await mkdir(work, { recursive: true })
  git(work, 'init', '-q')
  await writeFile(join(work, 'readme.md'), 'hello\n')
  git(work, 'add', '.')
  git(work, 'commit', '-qm', 'pushed')
  const origin = join(remotes, 'acme', 'web.git')
  execFileSync('git', ['clone', '-q', '--bare', work, origin])
  const url = `file://${remotes}/`
  // The other computer's cache, gone with it, and a checkout that borrowed from it.
  const theirs = join(home, 'elsewhere', 'acme', 'web.git')
  execFileSync('git', ['clone', '-q', '--bare', origin, theirs])
  const workDir = join(home, 'arrived')
  const checkout = join(workDir, 'web')
  execFileSync('git', ['clone', '-q', '--reference', theirs, `${url}acme/web.git`, checkout])
  await rm(join(home, 'elsewhere'), { recursive: true })
  assert.throws(() => git(checkout, 'log', '--oneline'), 'broken without its cache')

  const access = { url, token: 'test', author: { name: 't', email: 't@example.com' } }
  await repairCaches(workDir, access, undefined, true)
  assert.equal(git(checkout, 'log', '--format=%s').toString().trim(), 'pushed')
  assert.equal(
    (await readFile(join(checkout, '.git', 'objects', 'info', 'alternates'), 'utf8')).trim(),
    join(home, 'repos', 'acme', 'web.git', 'objects'),
  )
})
