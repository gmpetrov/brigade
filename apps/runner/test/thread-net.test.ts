import assert from 'node:assert/strict'
import { test } from 'node:test'
import { asTeammate, dockerSocket, dockerUnit, threadsOfUnits } from '../src/thread-net.js'

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

test("the threads of a teammate's running Docker units, and no one else's", () => {
  const listing = [
    `${dockerUnit('cmthread1', 'bt-ada')} loaded active running /usr/bin/dockerd-rootless.sh`,
    `${dockerUnit('cm-with-dashes', 'bt-ada')} loaded active running /usr/bin/dockerd-rootless.sh`,
    `${dockerUnit('cmthread1', 'bt-bob')} loaded active running /usr/bin/dockerd-rootless.sh`,
    'brigade-runner.service loaded active running Brigade runner',
    '',
  ].join('\n')
  assert.deepEqual(threadsOfUnits(listing, 'bt-ada'), ['cmthread1', 'cm-with-dashes'])
  assert.deepEqual(threadsOfUnits(listing, 'bt-bob'), ['cmthread1'])
  assert.deepEqual(threadsOfUnits('', 'bt-ada'), [])
  assert.equal(
    dockerSocket('cmthread1', 'bt-ada'),
    '/run/brigade-docker/cmthread1/bt-ada/docker.sock',
  )
})
