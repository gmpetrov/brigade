import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ThreadSpec } from '@brigade/contracts'
import { pushForSubthread } from '../src/repos.js'

// start_child's `repos` (docs/sub-threads.md): the parent's runner pushes each branch to GitHub
// first, from its checkout, so that the sub-thread finds it wherever it runs. Here a bare
// repository on disk stands for GitHub behind Brigade's git proxy (its URL prefix).
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Riley',
      GIT_AUTHOR_EMAIL: 'riley@example.com',
      GIT_COMMITTER_NAME: 'Riley',
      GIT_COMMITTER_EMAIL: 'riley@example.com',
    },
  })
    .toString()
    .trim()

function setUp() {
  const root = mkdtempSync(join(tmpdir(), 'subthread-branches-'))
  const proxy = `file://${root}/proxy/`
  mkdirSync(join(root, 'proxy', 'acme'), { recursive: true })
  git(root, 'init', '--quiet', '--bare', '-b', 'main', join(root, 'proxy', 'acme', 'site.git'))
  const workDir = join(root, 'work')
  mkdirSync(workDir)
  git(workDir, 'clone', '--quiet', `${proxy}acme/site.git`, 'site')
  const site = join(workDir, 'site')
  writeFileSync(join(site, 'README.md'), '# Site\n')
  git(site, 'add', '.')
  git(site, 'commit', '--quiet', '-m', 'First')
  git(site, 'push', '--quiet', 'origin', 'HEAD:main')
  git(site, 'checkout', '--quiet', '-b', 'brigade/riley-kit')
  writeFileSync(join(site, 'kit.md'), 'The launch kit\n')
  git(site, 'add', '.')
  git(site, 'commit', '--quiet', '-m', 'Kit')
  const spec = {
    git: { url: proxy, token: 'token', author: { name: 'Riley', email: 'riley@example.com' } },
  } as unknown as ThreadSpec
  const remote = join(root, 'proxy', 'acme', 'site.git')
  return { spec, workDir, site, remote }
}

test('a branch is pushed before its sub-thread starts', async () => {
  const { spec, workDir, site, remote } = setUp()
  const out = await pushForSubthread({
    spec,
    workDir,
    repository: 'Acme/Site',
    branch: 'brigade/riley-kit',
  })
  assert.deepEqual(out, { repository: 'acme/site', branch: 'brigade/riley-kit', pushed: true })
  assert.equal(
    git(remote, 'rev-parse', 'refs/heads/brigade/riley-kit'),
    git(site, 'rev-parse', 'HEAD'),
  )
})

test('uncommitted changes on it are refused, saying so', async () => {
  const { spec, workDir, site, remote } = setUp()
  writeFileSync(join(site, 'kit.md'), 'Changed, not committed\n')
  await assert.rejects(
    pushForSubthread({ spec, workDir, repository: 'acme/site', branch: 'brigade/riley-kit' }),
    /uncommitted changes on brigade\/riley-kit \(kit\.md\): commit them/,
  )
  assert.equal(git(remote, 'branch', '--list', 'brigade/riley-kit'), '')
})

test('a branch only on GitHub is there already; one nowhere is refused', async () => {
  const { spec, workDir } = setUp()
  assert.deepEqual(
    await pushForSubthread({ spec, workDir, repository: 'acme/site', branch: 'main' }).catch(
      () => null,
    ),
    // main is checked out here too, on the branch before: pushed again, a no-op.
    { repository: 'acme/site', branch: 'main', pushed: true },
  )
  await assert.rejects(
    pushForSubthread({ spec, workDir, repository: 'acme/site', branch: 'brigade/nowhere' }),
    /neither checked out here nor on GitHub/,
  )
  await assert.rejects(
    pushForSubthread({ spec, workDir, repository: 'not a repo', branch: 'main' }),
    /owner\/name/,
  )
})

test('a new file not committed is refused too, by name', async () => {
  const { spec, workDir, site } = setUp()
  writeFileSync(join(site, 'hero.svg'), '<svg/>')
  await assert.rejects(
    pushForSubthread({ spec, workDir, repository: 'acme/site', branch: 'brigade/riley-kit' }),
    /uncommitted changes on brigade\/riley-kit \(hero\.svg\)/,
  )
})
