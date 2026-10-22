import assert from 'node:assert/strict'
import { test } from 'node:test'
import { asTeammate, dockerSocket } from '../src/thread-net.js'

test("a teammate's command runs in its thread's network when the thread has one", () => {
  assert.deepEqual(asTeammate('bt-ada', { thread: 'cmthread1', address: '10.231.0.6' }), {
    file: 'sudo',
    args: ['-n', '-E', '/usr/local/sbin/brigade-thread', 'run', 'cmthread1', 'bt-ada'],
  })
  // With its own /tmp, processes and IPC too: in all of its namespaces.
  assert.deepEqual(
    asTeammate('bt-ada', { thread: 'cmthread1', address: '10.231.0.6', isolated: true }),
    {
      file: 'sudo',
      args: ['-n', '-E', '/usr/local/sbin/brigade-thread', 'enter', 'cmthread1', 'bt-ada'],
    },
  )
  // Without one, as before: the teammate's user on the computer's network.
  assert.deepEqual(asTeammate('bt-ada', null), {
    file: 'sudo',
    args: ['-n', '-E', '-u', 'bt-ada', '--'],
  })
})

test("a teammate's Docker socket in a thread is where the helper puts it", () => {
  assert.equal(
    dockerSocket('cmthread1', 'bt-ada'),
    '/run/brigade-docker/cmthread1/bt-ada/docker.sock',
  )
})
