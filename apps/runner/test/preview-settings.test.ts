// Where a thread's preview starts from: its checkout's .brigade/settings.toml
// (that branch's), else the recipe saved in Brigade; and the archive script a
// preview last started with, run once its thread goes quiet.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { PreviewOperation, PreviewRecipe } from '@brigade/contracts'

const home = await mkdtemp(join(tmpdir(), 'brigade-preview-settings-'))
process.env.BRIGADE_HOME = home
delete process.env.BRIGADE_CLOUD
const { Previews } = await import('../src/previews.js')
const { SETTINGS } = await import('../src/repo-settings.js')

test.after(() => rm(home, { recursive: true, force: true }))

const work = join(home, 'work')
const app = join(work, 'app')
await mkdir(app, { recursive: true })
execFileSync('git', ['-C', app, 'init', '-q'])
execFileSync('git', ['-C', app, 'remote', 'add', 'origin', 'https://github.com/acme/app.git'])

const saved: PreviewRecipe = {
  command: 'pnpm dev',
  cwd: '',
  port: 3000,
  ports: [],
  env: {},
  credentials: ['vault-1'],
  paths: ['/'],
  passed: true,
}
let stored: PreviewRecipe | null = saved

function previews(stateFile = join(home, 'state', 'previews.json')) {
  return new Previews({
    emit: () => undefined,
    expose: null,
    viewUrl: null,
    recipes: async (_sessionId: string, _teammateId: string, operation: PreviewOperation) =>
      operation.name === 'get' ? { recipe: stored } : { env: {}, secrets: [] },
    seat: (sessionId, teammateId) => ({ sessionId, teammateId, workDir: work }),
    stateFile,
  })
}

test("a checkout's .brigade/settings.toml comes before the recipe saved in Brigade", async () => {
  const control = previews().forSeat({ sessionId: 's1', teammateId: 'tm1', workDir: work })

  assert.deepEqual(await control.saved('Acme/App'), {
    recipe: saved,
    checkout: 'app',
    from: 'brigade',
  })

  // The same start in the branch's file: the vault credentials and the passed check carry over.
  await mkdir(join(app, '.brigade'), { recursive: true })
  await writeFile(join(app, SETTINGS), '[preview]\ncommand = "pnpm dev"\nport = 3000\n')
  const same = await control.saved('acme/app')
  assert.deepEqual(same?.from, [SETTINGS])
  assert.deepEqual(same?.recipe.credentials, ['vault-1'])
  assert.equal(same?.recipe.passed, true)

  // Another start: its check has not passed as it is.
  await writeFile(
    join(app, SETTINGS),
    '[preview]\ncommand = "pnpm dev"\nport = 3001\narchive = "docker compose down -v"\n',
  )
  const changed = await control.saved('acme/app')
  assert.equal(changed?.recipe.port, 3001)
  assert.equal(changed?.recipe.passed, undefined)
  assert.equal(changed?.recipe.archive, 'docker compose down -v')

  // Nothing saved in Brigade: the file alone.
  stored = null
  assert.deepEqual((await control.saved('acme/app'))?.recipe.credentials, [])

  // A file that cannot start it says so, for the teammate to fix.
  await writeFile(join(app, SETTINGS), '[preview]\ncommand = "pnpm dev"\n')
  await assert.rejects(control.saved('acme/app'), /preview\.port.*Fix it in app/)

  await rm(join(app, '.brigade'), { recursive: true })
  assert.equal(await control.saved('acme/app'), null)
  stored = saved
})

test('a quiet thread runs the archive script its preview last started with, in its own Compose project', async () => {
  const stateFile = join(home, 'state-archive', 'previews.json')
  await mkdir(join(home, 'state-archive'), { recursive: true })
  const seat = { sessionId: 'Quiet-1', teammateId: 'tm1', workDir: work }
  await writeFile(
    stateFile,
    JSON.stringify([
      [
        'Quiet-1',
        {
          seat,
          input: {
            command: 'pnpm dev',
            cwd: 'app',
            port: 3000,
            env: { FROM_RECIPE: 'yes' },
            archive: 'echo "$COMPOSE_PROJECT_NAME $FROM_RECIPE $(basename "$PWD")" > archived.txt',
          },
        },
      ],
      ['Other', { seat: { ...seat, sessionId: 'Other' }, input: { command: 'x', port: 1 } }],
    ]),
  )
  const kept = previews(stateFile)
  await kept.archive('Quiet-1')
  assert.equal(await readFile(join(app, 'archived.txt'), 'utf8'), 'tquiet1 yes app\n')
  // No archive script: nothing to run.
  await kept.archive('Other')
  await kept.archive('never-started')

  await writeFile(
    stateFile,
    JSON.stringify([
      ['Fails', { seat, input: { command: 'x', port: 1, archive: 'echo nope >&2; exit 3' } }],
    ]),
  )
  await assert.rejects(previews(stateFile).archive('Fails'), /nope/)
})
