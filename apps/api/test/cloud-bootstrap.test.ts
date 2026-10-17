import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import {
  bootstrapScript,
  setupScript,
  TEAMMATE_HELPER,
  THREAD_HELPER,
} from '../src/cloud-bootstrap.js'

/** sh -n: the script parses, with the template's escapes resolved as the computer gets them. */
const parses = (script: string) => {
  const result = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

test('the helpers and the setup the computer runs are valid shell', () => {
  parses(TEAMMATE_HELPER)
  parses(THREAD_HELPER)
  parses(setupScript())
  parses(bootstrapScript({ apiUrl: 'https://api.example.com', code: 'abc' }))
})

test('the thread helper reads its command from its first argument', () => {
  // A JavaScript template turns an unescaped ${1:-} into "undefined"; the helper must not.
  assert.match(THREAD_HELPER, /case "\$\{1:-\}" in/)
  assert.doesNotMatch(THREAD_HELPER, /undefined/)
  assert.match(setupScript(), /NOPASSWD:SETENV: \/usr\/local\/sbin\/brigade-thread$/m)
})
