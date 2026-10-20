// Thread folders on a member's own machine: those of threads quiet for days lose
// their dependency and build folders, and their Compose project's containers in
// the member's Docker, once their preview's archive script ran; the rest stays.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'brigade-member-folders-'))
process.env.BRIGADE_HOME = home
delete process.env.BRIGADE_CLOUD
// The member's Docker, as a script: what it was asked, and a container, volume and network of
// thread "quiet"'s Compose project.
const bin = join(home, 'bin')
const dockerLog = join(home, 'docker.log')
await mkdir(bin, { recursive: true })
await writeFile(
  join(bin, 'docker'),
  `#!/bin/sh\necho "$*" >> '${dockerLog}'\n` +
    'case "$*" in *"project=tquiet"*) case "$1" in ps) echo c1 ;; volume) echo tquiet_db ;; network) echo tquiet_default ;; esac ;; esac\n',
)
await chmod(join(bin, 'docker'), 0o755)
process.env.PATH = `${bin}:${process.env.PATH}`
const { Folders } = await import('../src/folders.js')
const { threadFolder } = await import('../src/threads.js')

test.after(() => rm(home, { recursive: true, force: true }))

const DAY = 24 * 60 * 60_000
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )
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

/** A thread folder with a checkout holding dependencies, a build and work, its git last used `ago` ms ago. */
async function folder(sessionId: string, ago: number) {
  const { workDir } = threadFolder('tm1', sessionId)
  const app = join(workDir, 'app')
  await mkdir(join(app, 'node_modules', 'left-pad'), { recursive: true })
  await mkdir(join(app, 'dist'), { recursive: true })
  await writeFile(join(app, 'node_modules', 'left-pad', 'index.js'), '')
  await writeFile(join(app, 'dist', 'out.js'), '')
  await writeFile(join(app, '.gitignore'), 'node_modules\ndist\n.env\n')
  await writeFile(join(app, '.env'), 'SECRET=1\n')
  await writeFile(join(app, 'index.js'), 'work\n')
  git(app, 'init', '-q')
  git(app, 'add', '.')
  git(app, 'commit', '-qm', 'start')
  const then = new Date(Date.now() - ago)
  await utimes(join(app, '.git', 'index'), then, then)
  return { workDir, app }
}

test('a thread quiet for days loses what a reinstall makes again, and its teammate is told; others keep theirs', async () => {
  const quiet = await folder('quiet', 4 * DAY)
  const recent = await folder('recent', 4 * DAY)
  const busy = await folder('busy', 4 * DAY)
  const unseen = await folder('unseen', 4 * DAY)
  // When the runner last saw each used: unseen never was, so far as it knows.
  const stateFile = join(home, 'state', 'folders.json')
  await mkdir(join(home, 'state'), { recursive: true })
  await writeFile(
    stateFile,
    JSON.stringify({
      active: {
        [quiet.workDir]: Date.now() - 4 * DAY,
        [recent.workDir]: Date.now() - 2 * 60 * 60_000,
        [busy.workDir]: Date.now() - 4 * DAY,
      },
    }),
  )
  const folders = new Folders({
    archives: {
      put: () => Promise.reject(new Error('nothing is archived from a member’s machine')),
      get: async () => false,
      delete: async () => undefined,
      gone: async () => false,
    },
    inUse: (sessionId) => sessionId === 'busy',
    quiet: async (name) => {
      archived.push(name.sessionId)
    },
    stateFile,
    tempDir: join(home, 'tmp'),
  })
  const archived: string[] = []
  await folders.check()
  assert.deepEqual(archived, ['quiet'])
  const asked = (await readFile(dockerLog, 'utf8')).trim().split('\n')
  assert.deepEqual(asked, [
    'ps -aq --filter label=com.docker.compose.project=tquiet',
    'rm --force --volumes c1',
    'volume ls -q --filter label=com.docker.compose.project=tquiet',
    'volume rm tquiet_db',
    'network ls -q --filter label=com.docker.compose.project=tquiet',
    'network rm tquiet_default',
  ])

  assert.equal(await exists(join(quiet.app, 'node_modules')), false)
  assert.equal(await exists(join(quiet.app, 'dist')), false)
  // Work, ignored files that are not folders, and the checkout itself stay.
  assert.equal(await exists(join(quiet.app, 'index.js')), true)
  assert.equal(await exists(join(quiet.app, '.env')), true)
  assert.equal(await exists(join(quiet.app, '.git')), true)
  for (const { app } of [recent, busy, unseen])
    assert.equal(await exists(join(app, 'node_modules')), true, app)

  const note = await folders.takeNote({ sessionId: 'quiet', teammateId: 'tm1' }, undefined)
  assert.match(note ?? '', /dependency and build folders/)
  // Once.
  assert.equal(
    await folders.takeNote({ sessionId: 'quiet', teammateId: 'tm1' }, undefined),
    undefined,
  )
  assert.equal(
    await folders.takeNote({ sessionId: 'recent', teammateId: 'tm1' }, undefined),
    undefined,
  )
})

test('a git command in a checkout counts as use', async () => {
  const worked = await folder('worked', 0)
  const stateFile = join(home, 'state', 'folders-2.json')
  await writeFile(stateFile, JSON.stringify({ active: { [worked.workDir]: Date.now() - 4 * DAY } }))
  const folders = new Folders({
    archives: {
      put: async () => undefined,
      get: async () => false,
      delete: async () => undefined,
      gone: async () => false,
    },
    inUse: () => false,
    stateFile,
    tempDir: join(home, 'tmp'),
  })
  await folders.check()
  assert.equal(await exists(join(worked.app, 'node_modules')), true)
})
