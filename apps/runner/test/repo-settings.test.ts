// A repository's own settings for Brigade: its preview in .brigade/settings.toml,
// one person's over the team's, and the files .worktreeinclude has a member's
// machine copy from the member's own clone.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { PreviewRecipe } from '@brigade/contracts'

const home = await mkdtemp(join(tmpdir(), 'brigade-repo-settings-'))
process.env.BRIGADE_HOME = join(home, '.brigade')
delete process.env.BRIGADE_CLOUD
const {
  copyIncluded,
  findClones,
  includedPaths,
  LOCAL_SETTINGS,
  readRepoPreview,
  SETTINGS,
  settingsText,
  writeRepoPreview,
} = await import('../src/repo-settings.js')
const { pack } = await import('../src/folders.js')

test.after(() => rm(home, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  }).toString()
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

const recipe: PreviewRecipe = {
  setup: 'pnpm install\ndocker compose up -d db\npnpm db:migrate "with \\"quotes\\"" C:\\path',
  command: 'pnpm dev --port $PORT --host $HOST',
  cwd: 'apps/web',
  port: 3000,
  ports: [4000],
  env: { NEXTAUTH_URL: '${BRIGADE_PREVIEW_URL}', DEBUG: 'app:*' },
  envFile: '.env.local',
  credentials: ['vault-1'],
  paths: ['/', '/login'],
  timeoutSeconds: 600,
  passed: true,
  archive: 'docker compose down -v',
}

async function checkout(name: string) {
  const dir = join(home, 'checkouts', name)
  await mkdir(dir, { recursive: true })
  return dir
}

test('a recipe written to .brigade/settings.toml reads back the same, scripts as they read', async () => {
  const dir = await checkout('roundtrip')
  const written = await writeRepoPreview(dir, recipe)
  assert.deepEqual(written, { file: SETTINGS, changed: true, local: false })
  const text = await readFile(join(dir, SETTINGS), 'utf8')
  // A script over several lines stays one, unescaped.
  assert.match(text, /^setup = '''\npnpm install\ndocker compose up -d db\n/m)
  assert.match(text, /^\[preview\.env\]\nNEXTAUTH_URL = "\$\{BRIGADE_PREVIEW_URL\}"/m)
  // Not the workspace's credentials, nor Brigade's own bookkeeping.
  assert.doesNotMatch(text, /vault-1|passed/)
  assert.equal(
    await readFile(join(dir, '.brigade', '.gitignore'), 'utf8'),
    '/settings.local.toml\n',
  )

  const read = await readRepoPreview(dir)
  assert.ok(read.found && 'recipe' in read)
  const { credentials: _c, passed: _p, ...expected } = recipe
  assert.deepEqual(read.recipe, { ...expected, setup: `${recipe.setup}\n`, credentials: [] })
  assert.deepEqual(read.files, [SETTINGS])
})

test('saving the same start again leaves the file as people wrote it', async () => {
  const dir = await checkout('unchanged')
  const text =
    '# Our preview.\n[preview]\ncommand = "pnpm dev"\nport = 3000\n# The pages people check.\npages = ["/"]\n'
  await mkdir(join(dir, '.brigade'))
  await writeFile(join(dir, SETTINGS), text)
  const saved = await writeRepoPreview(dir, {
    command: 'pnpm dev',
    cwd: '',
    port: 3000,
    ports: [],
    env: {},
    credentials: [],
    paths: ['/'],
  })
  assert.equal(saved.changed, false)
  assert.equal(await readFile(join(dir, SETTINGS), 'utf8'), text)
})

test("the file's other tables stay when its preview is written", async () => {
  const text = settingsText(
    recipe,
    '[other]\nkept = true\n\n[preview]\ncommand = "old"\nport = 1\n',
  )
  assert.match(text, /^\[other\]\nkept = true$/m)
  assert.equal(text.match(/^\[preview\]$/gm)?.length, 1)
  assert.doesNotMatch(text, /"old"/)
})

test("a person's settings come over the team's, their env merged", async () => {
  const dir = await checkout('local')
  await writeRepoPreview(dir, recipe)
  await writeFile(
    join(dir, LOCAL_SETTINGS),
    '[preview]\nport = 3005\n\n[preview.env]\nDEBUG = "*"\nMINE = "1"\n',
  )
  const read = await readRepoPreview(dir)
  assert.ok(read.found && 'recipe' in read)
  assert.equal(read.recipe.port, 3005)
  assert.equal(read.recipe.command, recipe.command)
  assert.deepEqual(read.recipe.env, {
    NEXTAUTH_URL: '${BRIGADE_PREVIEW_URL}',
    DEBUG: '*',
    MINE: '1',
  })
  assert.deepEqual(read.files, [SETTINGS, LOCAL_SETTINGS])
  assert.equal((await writeRepoPreview(dir, read.recipe)).local, true)
})

test('settings that cannot start a preview say why, in the keys people wrote', async () => {
  const dir = await checkout('broken')
  await mkdir(join(dir, '.brigade'))
  const cases: [string, RegExp][] = [
    ['[preview\n', /not valid TOML/],
    ['[preview]\ncommand = "x"\nport = 3000\nwhatever = 1\n', /has no whatever/],
    [
      '[preview]\ncommand = "x"\nport = "3000"\npages = ["no-slash"]\n',
      /preview\.port: .*preview\.pages\.0/,
    ],
    ['preview = 3\n', /not a table/],
  ]
  for (const [text, error] of cases) {
    await writeFile(join(dir, SETTINGS), text)
    const read = await readRepoPreview(dir)
    assert.ok(read.found && 'error' in read, text)
    assert.match(read.error, error)
  }
  // No [preview]: nothing to say about it.
  await writeFile(join(dir, SETTINGS), '[other]\nx = 1\n')
  assert.deepEqual(await readRepoPreview(dir), { found: false })
  assert.deepEqual(await readRepoPreview(await checkout('none')), { found: false })
})

test('.worktreeinclude names literal paths inside the repository only', () => {
  assert.deepEqual(
    includedPaths(
      [
        '# settings',
        '.env',
        './apps/web/.env.local',
        'secrets/',
        'config\\local.json',
        '',
        '*.pem',
        '!keep',
        '/etc/passwd',
        '../outside',
        'a/../b',
        '.git/config',
        'C:/x',
        '.env',
      ].join('\n'),
    ),
    ['.env', 'apps/web/.env.local', 'secrets', 'config/local.json'],
  )
})

test("a member's clones are found under their home, never in folders macOS keeps private", async () => {
  const me = join(home, 'me')
  const clone = async (path: string, remote?: string) => {
    await mkdir(join(me, path), { recursive: true })
    git(join(me, path), 'init', '-q')
    if (remote) git(join(me, path), 'remote', 'add', 'origin', remote)
  }
  await clone('workspace/app', 'git@github.com:Acme/App.git')
  await clone('code/team/api', 'https://github.com/acme/api.git')
  await clone('Documents/secret', 'https://github.com/acme/secret.git')
  await clone('a/b/c/too-deep', 'https://github.com/acme/deep.git')
  await clone('workspace/no-remote')
  // A worktree: its .git is a file. Not the member's clone.
  await mkdir(join(me, 'workspace', 'worktree'), { recursive: true })
  await writeFile(join(me, 'workspace', 'worktree', '.git'), 'gitdir: /elsewhere\n')
  const clones = await findClones(me)
  assert.deepEqual(Object.fromEntries(clones), {
    'acme/app': join(me, 'workspace/app'),
    'acme/api': join(me, 'code/team/api'),
  })
})

test("a checkout gets what .worktreeinclude names from the member's clone, where git ignores it there", async () => {
  const clone = join(home, 'clones', 'shop')
  await mkdir(join(clone, 'secrets'), { recursive: true })
  await writeFile(join(clone, '.gitignore'), '.env\nsecrets/\n')
  await writeFile(
    join(clone, '.worktreeinclude'),
    '.env\nsecrets\nREADME.md\nmissing.txt\n../escape\n',
  )
  await writeFile(join(clone, 'README.md'), 'tracked\n')
  git(clone, 'init', '-q')
  git(clone, 'add', '.')
  git(clone, 'commit', '-qm', 'start')
  git(clone, 'remote', 'add', 'origin', 'https://github.com/acme/shop.git')
  await writeFile(join(clone, '.env'), 'KEY=member\n')
  await writeFile(join(clone, 'secrets', 'key.txt'), 'shh\n')
  await mkdir(process.env.BRIGADE_HOME!, { recursive: true })
  await writeFile(
    join(process.env.BRIGADE_HOME!, 'clones.json'),
    JSON.stringify({ 'acme/shop': clone }),
  )

  const work = join(home, 'thread')
  await mkdir(work, { recursive: true })
  const dir = join(work, 'shop')
  execFileSync('git', ['clone', '-q', clone, dir])
  assert.deepEqual(await copyIncluded(dir, 'Acme/Shop'), ['.env', 'secrets'])
  assert.equal(await readFile(join(dir, '.env'), 'utf8'), 'KEY=member\n')
  assert.equal(await readFile(join(dir, 'secrets', 'key.txt'), 'utf8'), 'shh\n')
  assert.equal(await readFile(join(dir, '.git', 'brigade-copied'), 'utf8'), '.env\nsecrets\n')
  // What the checkout has is left as it is.
  await writeFile(join(dir, '.env'), 'KEY=thread\n')
  assert.deepEqual(await copyIncluded(dir, 'acme/shop'), [])
  assert.equal(await readFile(join(dir, '.env'), 'utf8'), 'KEY=thread\n')
  assert.equal(await exists(join(work, 'escape')), false)

  // A branch's link never takes a copy elsewhere, nor the settings file.
  const outside = join(home, 'outside')
  await mkdir(outside)
  await mkdir(join(clone, 'conf'))
  await writeFile(join(clone, 'conf', 'local.json'), '{}')
  await writeFile(join(clone, '.gitignore'), '.env\nsecrets/\nconf/\n')
  await writeFile(join(dir, '.worktreeinclude'), 'conf/local.json\n')
  await symlink(outside, join(dir, 'conf'))
  assert.deepEqual(await copyIncluded(dir, 'acme/shop'), [])
  assert.equal(await exists(join(outside, 'local.json')), false)
  await symlink(outside, join(dir, '.brigade'))
  await assert.rejects(writeRepoPreview(dir, recipe), /goes through a link/)
  assert.equal(await exists(join(outside, 'settings.toml')), false)
  await rm(join(dir, '.brigade'))
  await rm(join(dir, 'conf'))
  await writeFile(join(dir, '.worktreeinclude'), '.env\nsecrets\n')

  // Theirs: never packed for another computer, unlike the checkout's own ignored files.
  await writeFile(join(dir, '.env.thread'), 'MADE=here\n')
  await writeFile(join(dir, '.gitignore'), '.env\nsecrets/\n.env.thread\n')
  const archive = join(home, 'thread.tgz')
  await pack(work, archive)
  const packed = execFileSync('tar', ['-tzf', archive]).toString().split('\n')
  assert.ok(
    packed.includes('./shop/.env.thread') || packed.includes('shop/.env.thread'),
    packed.join(' '),
  )
  assert.ok(!packed.some((p) => /shop\/(\.env|secrets)(\/|$)/.test(p)), packed.join(' '))
})
