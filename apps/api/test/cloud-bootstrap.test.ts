import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test("the thread helper restarts systemd-resolved when the threads' listener is missing", () => {
  // Its host_rules alone, with what it calls stubbed: systemctl's calls are logged, ss lists
  // what LISTENING says.
  const rules = /^host_rules\(\) \{$[\s\S]*?^\}$/m.exec(THREAD_HELPER)?.[0]
  assert.ok(rules)
  const dir = mkdtempSync(join(tmpdir(), 'thread-helper-'))
  const stub = (name: string, body: string) =>
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  stub('ip', 'exit 0')
  stub('iptables', 'exit 0')
  stub('systemctl', 'echo "$*" >>"$LOG"')
  stub('ss', 'printf "%s" "$LISTENING"')
  writeFileSync(join(dir, 'resolved.conf'), '')
  const restarts = (listening: string) => {
    const log = join(dir, listening ? 'listening.log' : 'missing.log')
    const result = spawnSync(
      'sh',
      ['-c', `DNS=10.231.255.254\nRESOLVED_FILE=${dir}/resolved.conf\n${rules}\nhost_rules`],
      { env: { PATH: `${dir}:/usr/bin:/bin`, LOG: log, LISTENING: listening }, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    return readFileSync(log, 'utf8').includes('restart systemd-resolved')
  }
  assert.equal(restarts(''), true)
  assert.equal(restarts('UNCONN 0 0 10.231.255.254:53 0.0.0.0:*'), false)
})
