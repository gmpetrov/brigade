// A cloud computer's backups (BACKUP_PROTOCOL): sealed before they reach the bucket, a thread
// folder put back from its latest backup when the computer it left could not hand it over (with
// what ran in the background then), account logins written back without following a planted
// link, and what Claude Code runs in the background read from its task messages.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'brigade-backups-'))
process.env.BRIGADE_HOME = home
const { seal, unseal } = await import('../src/sealed.js')
const { Folders, pack } = await import('../src/folders.js')
const { threadFolder, backgroundTasks } = await import('../src/threads.js')
const { readLogin, writeLogin } = await import('../src/account-backups.js')

test.after(() => rm(home, { recursive: true, force: true }))

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

test('a backup is sealed with the key, and opens only with it, unchanged', async () => {
  const key = randomBytes(32)
  const plain = join(home, 'plain.bin')
  const bytes = randomBytes(200_000)
  await writeFile(plain, bytes)
  const sealed = join(home, 'sealed.bin')
  const size = await seal(plain, sealed, key)
  assert.equal(size, bytes.length + 4 + 12 + 16)
  const raw = await readFile(sealed)
  assert.equal(raw.subarray(0, 4).toString(), 'BGE1')
  assert.equal(raw.indexOf(bytes.subarray(0, 64)), -1, 'nothing of it readable')

  const back = join(home, 'back.bin')
  await unseal(sealed, back, key)
  assert.deepEqual(await readFile(back), bytes)

  await assert.rejects(unseal(sealed, join(home, 'other.bin'), randomBytes(32)))
  raw[5000] = raw[5000]! ^ 1
  await writeFile(sealed, raw)
  await assert.rejects(unseal(sealed, join(home, 'changed.bin'), key))

  // Empty, too.
  await writeFile(plain, '')
  await seal(plain, sealed, key)
  await unseal(sealed, back, key)
  assert.equal((await readFile(back)).length, 0)
})

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

test('a thread whose computer was lost comes back from its latest backup, and says what stopped', async () => {
  const name = { sessionId: 'thread1', teammateId: 'teammate1' }
  const { workDir } = threadFolder(name.teammateId, name.sessionId)
  const repo = join(workDir, 'web')
  await mkdir(repo, { recursive: true })
  git(repo, 'init', '-q')
  await writeFile(join(repo, '.gitignore'), 'node_modules/\n.env\n')
  await writeFile(join(repo, 'committed.txt'), 'pushed or not\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'first')
  await writeFile(join(repo, 'untracked.txt'), 'not committed\n')
  await writeFile(join(repo, '.env'), 'SECRET=1\n')
  await writeFile(join(workDir, 'report.md'), 'outside any repository\n')

  // The backup the computer made while it ran (pack, as folders.ts backUp does).
  const backup = join(home, 'thread1.tar.gz')
  assert.ok(await pack(workDir, backup))
  await rm(workDir, { recursive: true })

  const folders = new Folders({
    archives: {
      put: async () => undefined,
      get: async () => false,
      delete: async () => undefined,
      gone: async () => false,
    },
    backups: {
      put: async () => undefined,
      get: async (_, file) => {
        await copyFile(backup, file)
        return {
          takenAt: '2026-10-27T09:50:00.000Z',
          size: 1,
          background: [{ kind: 'command', description: 'npm run dev' }],
        }
      },
    },
    inUse: () => false,
    stateFile: join(home, 'state', 'folders.json'),
    tempDir: join(home, 'state', 'folder-archives'),
  })
  await folders.arrive(name, {
    at: '2026-10-27T10:00:00.000Z',
    from: 'the cloud computer this one replaced',
  })
  assert.equal(await readFile(join(repo, 'untracked.txt'), 'utf8'), 'not committed\n')
  assert.equal(await readFile(join(repo, '.env'), 'utf8'), 'SECRET=1\n')
  assert.equal(await readFile(join(workDir, 'report.md'), 'utf8'), 'outside any repository\n')
  assert.equal(git(repo, 'log', '--format=%s').toString().trim(), 'first')

  const note = (await folders.takeNote(name, undefined)) ?? ''
  assert.match(note, /latest backup, taken at 2026-10-27T09:50:00.000Z/)
  assert.match(note, /stopped with that computer[^]*- command: npm run dev/)
  assert.equal(await folders.takeNote(name, undefined), undefined, 'told once')
})

test("git's lock files stay out of a backup of a folder in use", async () => {
  const workDir = join(home, 'live')
  const repo = join(workDir, 'app')
  await mkdir(repo, { recursive: true })
  git(repo, 'init', '-q')
  await writeFile(join(repo, 'a.txt'), 'a\n')
  await writeFile(join(repo, '.git', 'index.lock'), '')
  const file = join(home, 'live.tar.gz')
  // GNU tar's flags: the cloud computer's. Elsewhere only the list is checked.
  const gnu = /GNU tar/.test(execFileSync('tar', ['--version']).toString())
  if (gnu) {
    assert.ok(await pack(workDir, file, undefined, { live: true }))
    const listed = execFileSync('tar', ['-tzf', file]).toString()
    assert.match(listed, /app\/a\.txt/)
    assert.doesNotMatch(listed, /index\.lock/)
  }
  assert.ok(await pack(workDir, file))
  assert.match(execFileSync('tar', ['-tzf', file]).toString(), /index\.lock/, 'an archive keeps it')
})

test('a login is written back by renaming over what is there, never through a link', async () => {
  const dir = join(home, 'accounts', 'acct1')
  await mkdir(dir, { recursive: true })
  const target = join(home, 'not-the-login.txt')
  await writeFile(target, 'keep me\n')
  // A teammate, who may write in the folder, planted a link where the login goes.
  await symlink(target, join(dir, 'auth.json'))
  assert.equal(await readLogin(dir), null, 'a link is not read as the login')

  const login = {
    files: [
      { name: 'auth.json' as const, content: Buffer.from('{"refresh":"r2"}').toString('base64') },
      { name: '.oauth-token' as const, content: Buffer.from('sk-ant-oat01-x\n').toString('base64') },
    ],
    sha256: '0'.repeat(64),
  }
  await writeLogin(dir, 'acct1', login)
  assert.equal(await readFile(target, 'utf8'), 'keep me\n')
  assert.ok((await lstat(join(dir, 'auth.json'))).isFile())
  assert.equal(await readFile(join(dir, 'auth.json'), 'utf8'), '{"refresh":"r2"}')
  assert.equal((await stat(join(dir, '.oauth-token'))).mode & 0o777, 0o600)

  const read = await readLogin(dir)
  assert.deepEqual(
    read?.files.map((f) => f.name),
    ['.oauth-token', 'auth.json'],
  )
  assert.ok(!(await exists(join(dir, '.credentials.json'))))
})

test("what a turn runs in the background, from Claude Code's task messages", () => {
  const event = (tasks: unknown) =>
    ({
      at: '',
      type: 'raw',
      source: 'harness',
      value: { type: 'system', subtype: 'background_tasks_changed', tasks },
    }) as never
  assert.deepEqual(
    backgroundTasks(
      event([
        { task_id: '1', task_type: 'local_bash', description: 'npm run dev' },
        { task_id: '2', task_type: 'monitor_mcp', description: 'tail -f log' },
        { task_id: '3', task_type: 'local_agent', description: 'review' },
        { task_id: '4', task_type: 'local_bash', description: 'ambient', ambient: true },
        { task_id: '5', task_type: 'other', description: 'x' },
      ]),
    ),
    [
      { kind: 'command', description: 'npm run dev' },
      { kind: 'command', description: 'tail -f log' },
      { kind: 'agent', description: 'review' },
    ],
  )
  assert.equal(
    backgroundTasks({ at: '', type: 'raw', source: 'harness', value: { type: 'x' } } as never),
    undefined,
  )
})
