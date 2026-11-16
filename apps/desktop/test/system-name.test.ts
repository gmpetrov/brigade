import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountFullName, fullNameOf } from '../src/system-name.js'

const georges = { username: 'georges', uid: 501 }

test('a full name worth greeting by, and nothing else', () => {
  assert.equal(fullNameOf('Georges Petrov', 'georges'), 'Georges Petrov')
  assert.equal(fullNameOf('Ada Lovelace,Room 1,555', 'ada'), 'Ada Lovelace')
  assert.equal(fullNameOf('georges', 'georges'), null)
  assert.equal(fullNameOf('Admin', 'admin2'), null)
  assert.equal(fullNameOf('ada@example.com', 'ada'), null)
  assert.equal(fullNameOf('User 2', 'u'), null)
  assert.equal(fullNameOf('', 'ada'), null)
  assert.equal(fullNameOf(undefined, 'ada'), null)
})

test('macOS asks id -F, Linux its passwd entry, Windows nothing', async () => {
  const calls: string[][] = []
  const exec = async (file: string, args: string[]) => {
    calls.push([file, ...args])
    return file === '/usr/bin/id'
      ? 'Georges Petrov\n'
      : 'georges:x:501:501:Georges Petrov,,,:/home/georges:/bin/bash\n'
  }
  assert.equal(await accountFullName('darwin', exec, georges), 'Georges Petrov')
  assert.equal(await accountFullName('linux', exec, georges), 'Georges Petrov')
  assert.equal(await accountFullName('win32', exec, georges), null)
  assert.deepEqual(calls, [
    ['/usr/bin/id', '-F'],
    ['getent', 'passwd', '501'],
  ])
})

test('never throws: no account, a failing or missing command, an odd entry', async () => {
  const fails = async () => {
    throw new Error('spawn getent ENOENT')
  }
  assert.equal(await accountFullName('linux', fails, georges), null)
  assert.equal(await accountFullName('darwin', fails, georges), null)
  assert.equal(await accountFullName('linux', async () => '', georges), null)
  assert.equal(await accountFullName('linux', async () => 'garbage', georges), null)
  assert.equal(await accountFullName('linux', async () => 'x', null), null)
  assert.equal(await accountFullName('linux', async () => 'x', { username: 'g', uid: -1 }), null)
  // On this machine, whatever it is: an answer or none, never an error.
  const here = await accountFullName()
  assert.ok(here === null || typeof here === 'string')
})
