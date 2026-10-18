// The runner installer, run for real against a bundle served here: whole, or in the two steps
// an updating runner takes (stage while it works, swap once its turns are handed over).
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

process.env.DATABASE_URL ??= 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { installScript } = await import('../src/routes/runner-install.js')

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'brigade-install-'))
test.after(() => rm(root, { recursive: true, force: true }))

/** A bundle as the API serves it: one top folder holding dist/index.js. */
async function bundle(name: string, version: string) {
  const dir = join(root, name)
  await mkdir(join(dir, 'package', 'dist'), { recursive: true })
  await writeFile(
    join(dir, 'package', 'dist', 'index.js'),
    `console.log(${JSON.stringify(version)})\n`,
  )
  spawnSync('tar', ['-czf', join(dir, 'bundle.tgz'), '-C', dir, 'package'])
  const bytes = readFileSync(join(dir, 'bundle.tgz'))
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

let served = await bundle('one', 'one')
const server = createServer((req, res) => {
  if (req.url !== '/runner/bundle.tgz') return res.writeHead(404).end()
  res.writeHead(200, { 'content-type': 'application/gzip', 'x-bundle-sha256': served.sha256 })
  res.end(served.bytes)
})
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
test.after(() => server.close())
const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`

const install = (dir: string, step?: 'stage' | 'swap') =>
  execFileAsync('sh', ['-c', installScript(api)], {
    env: {
      ...process.env,
      BRIGADE_INSTALL_DIR: dir,
      ...(step ? { BRIGADE_INSTALL_STEP: step } : { BRIGADE_INSTALL_STEP: '' }),
    },
  })
const stamp = (dir: string) => readFileSync(join(dir, '.bundle-sha256'), 'utf8').trim()

test('a first install puts the runner and its wrapper in place', async () => {
  const dir = join(root, 'fresh')
  await install(dir)
  assert.equal(stamp(join(dir, 'runner')), served.sha256)
  assert.ok(existsSync(join(dir, 'bin', 'brigade-runner')))
  assert.ok(!existsSync(join(dir, 'runner.new')))
})

test('an update downloads beside the running runner, then swaps it in', async () => {
  const dir = join(root, 'updating')
  await install(dir)
  const before = served.sha256
  served = await bundle('two', 'two')

  await install(dir, 'stage')
  // Staged: the running runner and its wrapper are as they were.
  assert.equal(stamp(join(dir, 'runner')), before)
  assert.equal(stamp(join(dir, 'runner.new')), served.sha256)

  await install(dir, 'swap')
  assert.equal(stamp(join(dir, 'runner')), served.sha256)
  assert.match(readFileSync(join(dir, 'runner', 'dist', 'index.js'), 'utf8'), /two/)
  assert.ok(!existsSync(join(dir, 'runner.new')))
  assert.ok(existsSync(join(dir, 'bin', 'brigade-runner')))
})

test('a swap with nothing staged changes nothing', async () => {
  const dir = join(root, 'nothing-staged')
  await install(dir)
  const before = stamp(join(dir, 'runner'))
  await assert.rejects(install(dir, 'swap'))
  assert.equal(stamp(join(dir, 'runner')), before)
})
