import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountFullName, fullNameOf } from '../src/system-name.js'

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
      : 'g:x:1000:1000:Georges Petrov,,,:/home/g:/bin/bash\n'
  }
  assert.equal(await accountFullName('darwin', exec), 'Georges Petrov')
  assert.equal(await accountFullName('linux', exec), 'Georges Petrov')
  assert.equal(await accountFullName('win32', exec), null)
  assert.deepEqual(calls[0], ['/usr/bin/id', '-F'])
  assert.equal(calls[1]![0], 'getent')
  assert.equal(calls.length, 2)
})
