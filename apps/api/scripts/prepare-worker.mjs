#!/usr/bin/env node
// Before `wrangler deploy` (or dev) of the API: put the runner bundle in the
// Worker's static assets (dist-worker/assets), served by GET /runner/bundle.tgz,
// and print its SHA-256, which the deploy passes as RUNNER_BUNDLE_SHA256.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assets = join(root, 'dist-worker/assets/runner')
rmSync(join(root, 'dist-worker'), { recursive: true, force: true })
mkdirSync(assets, { recursive: true })

const bundle = join(root, '../runner/bundle/brigade-runner.tgz')
if (!existsSync(bundle)) {
  console.error('No runner bundle: build it with pnpm --filter @brigade/runner bundle')
  process.exit(1)
}
copyFileSync(bundle, join(assets, 'brigade-runner.tgz'))
console.log(createHash('sha256').update(readFileSync(bundle)).digest('hex'))
