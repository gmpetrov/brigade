import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { activeIn, allIn, BASE, homeForLinkIn, setActiveIn, validKey } from '../src/workspaces.js'

const temp = () => mkdtempSync(join(tmpdir(), 'brigade-workspaces-'))

function link(home: string, name: string, config: Record<string, unknown>) {
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'runner.json'), JSON.stringify({ ...config, workspaceName: name }))
}

test('the first link goes to the base home', () => {
  assert.deepEqual(homeForLinkIn(temp(), 'ws_a', 'https://api.test'), { key: BASE, created: false })
})

test('the same workspace keeps its home', () => {
  const base = temp()
  link(base, 'Acme', { apiUrl: 'https://api.test', workspaceId: 'ws_a', token: 'ws_a.x' })
  link(join(base, 'workspaces', 'w1'), 'Beta', {
    apiUrl: 'https://api.test/',
    token: 'ws_b.secret',
  })
  assert.deepEqual(homeForLinkIn(base, 'ws_a', 'https://api.test/'), { key: BASE, created: false })
  // Its id from the token, for a runner linked before runner.json kept it.
  assert.deepEqual(homeForLinkIn(base, 'ws_b', 'https://api.test'), { key: 'w1', created: false })
})

test('another workspace gets a new home', () => {
  const base = temp()
  link(base, 'Acme', { apiUrl: 'https://api.test', workspaceId: 'ws_a' })
  const { key, created } = homeForLinkIn(base, 'ws_c', 'https://api.test', () => 100)
  assert.equal(key, 'w100')
  assert.ok(created && validKey(key) && statSync(join(base, 'workspaces', key)).isDirectory())
  // The same workspace on another API is another workspace.
  assert.equal(homeForLinkIn(base, 'ws_a', 'https://other.test', () => 100).key, 'w100-1')
})

test('links at once get homes of their own', () => {
  const base = temp()
  link(base, 'Acme', { apiUrl: 'https://api.test', workspaceId: 'ws_a' })
  const keys = Array.from({ length: 8 }, (_, i) =>
    homeForLinkIn(base, `ws_${i}`, 'https://api.test', () => 5),
  )
  assert.equal(new Set(keys.map((k) => k.key)).size, 8)
  assert.ok(keys.every((k) => k.created))
})

test('a link without an id relinks the active home', () => {
  const base = temp()
  link(base, 'Acme', { apiUrl: 'https://api.test' })
  link(join(base, 'workspaces', 'w1'), 'Beta', { apiUrl: 'https://api.test' })
  setActiveIn(base, 'w1')
  assert.deepEqual(homeForLinkIn(base, undefined, 'https://api.test'), {
    key: 'w1',
    created: false,
  })
})

test('lists and activates workspaces', () => {
  const base = temp()
  link(base, 'Zeta', { apiUrl: 'https://api.test' })
  link(join(base, 'workspaces', 'w2'), 'beta', { apiUrl: 'https://api.test' })
  link(join(base, 'workspaces', 'w1'), 'Alpha', { apiUrl: 'https://api.test' })
  // A folder that was never linked is no workspace.
  mkdirSync(join(base, 'workspaces', 'w3'), { recursive: true })
  assert.deepEqual(
    allIn(base).map((w) => w.name),
    ['Zeta', 'Alpha', 'beta'],
  )
  assert.equal(activeIn(base), BASE)
  setActiveIn(base, 'w2')
  assert.equal(activeIn(base), 'w2')
  // Nothing outside workspaces/, and a home removed falls back to ~/.brigade.
  setActiveIn(base, '../elsewhere')
  assert.equal(activeIn(base), BASE)
  setActiveIn(base, 'w9')
  assert.equal(activeIn(base), BASE)
})
