import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { test } from 'node:test'
import { asTeammate, dockerSocket } from '../src/thread-net.js'

// What runs as a teammate finds the runner's Node first: sudo's PATH has only the system's.
const withNode = [
  '/bin/sh',
  '-c',
  'PATH="$0${PATH:+:$PATH}"; export PATH; exec "$@"',
  dirname(process.execPath),
]

test("a teammate's command runs in its thread's network when the thread has one", () => {
  assert.deepEqual(asTeammate('bt-ada', { thread: 'cmthread1', address: '10.231.0.6' }), {
    file: 'sudo',
    args: ['-n', '-E', '/usr/local/sbin/brigade-thread', 'run', 'cmthread1', 'bt-ada', ...withNode],
  })
  // With its own /tmp, processes and IPC too: in all of its namespaces.
  assert.deepEqual(
    asTeammate('bt-ada', { thread: 'cmthread1', address: '10.231.0.6', isolated: true }),
    {
      file: 'sudo',
      args: ['-n', '-E', '/usr/local/sbin/brigade-thread', 'enter', 'cmthread1', 'bt-ada', ...withNode],
    },
  )
  // Without one, as before: the teammate's user on the computer's network.
  assert.deepEqual(asTeammate('bt-ada', null), {
    file: 'sudo',
    args: ['-n', '-E', '-u', 'bt-ada', '--', ...withNode],
  })
})

test("a teammate's Docker socket in a thread is where the helper puts it", () => {
  assert.equal(
    dockerSocket('cmthread1', 'bt-ada'),
    '/run/brigade-docker/cmthread1/bt-ada/docker.sock',
  )
})

test("a teammate's command finds the runner's Node first, then sudo's PATH", () => {
  // The wrapper the teammate's command runs through, here without sudo.
  const { args } = asTeammate('bt-ada', null, '/opt/brigade/node/bin')
  const wrapper = args.slice(args.indexOf('--') + 1)
  assert.equal(wrapper[0], '/bin/sh')
  const out = execFileSync(
    wrapper[0]!,
    [...wrapper.slice(1), 'sh', '-c', 'printf %s "$PATH"'],
    { env: { PATH: '/usr/bin:/bin' } },
  ).toString()
  assert.equal(out, '/opt/brigade/node/bin:/usr/bin:/bin')
  // Its arguments reach it untouched.
  const echoed = execFileSync(
    wrapper[0]!,
    [...wrapper.slice(1), 'sh', '-c', 'printf "%s|" "$@"', 'sh', 'a b', '$HOME', ''],
    { env: { PATH: '/usr/bin:/bin' } },
  ).toString()
  assert.equal(echoed, 'a b|$HOME||')
})
