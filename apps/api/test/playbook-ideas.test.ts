import assert from 'node:assert/strict'
import { test } from 'node:test'

// Where a playbook's ideas go (src/playbook-ideas.ts): its `ideas` setting, a library path with a
// section after #, else ideas.md in its project's folder, else at the library's root.
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

const { ideasPlace } = await import('../src/playbook-ideas.js')

test("a playbook's ideas go to its own list in its project's folder, unless its setting says", () => {
  assert.deepEqual(ideasPlace(undefined, null), { path: 'ideas.md' })
  assert.deepEqual(ideasPlace('  ', { name: 'Acme', folder: null }), {
    path: 'Projects/Acme/ideas.md',
  })
  assert.deepEqual(ideasPlace(undefined, { name: 'Acme', folder: 'Clients/Acme' }), {
    path: 'Clients/Acme/ideas.md',
  })
  assert.deepEqual(ideasPlace('Projects/Acme/backlog.md#To approve', null), {
    path: 'Projects/Acme/backlog.md',
    section: 'To approve',
  })
  // A path without its extension, or with a leading slash, is still the Markdown file.
  assert.deepEqual(ideasPlace('/Projects/Acme/backlog # Ideas ', null), {
    path: 'Projects/Acme/backlog.md',
    section: 'Ideas',
  })
  assert.deepEqual(ideasPlace('backlog.md#', null), { path: 'backlog.md' })
  // A setting that is no path at all: the default.
  assert.deepEqual(ideasPlace('#To approve', { name: 'Acme', folder: null }), {
    path: 'Projects/Acme/ideas.md',
  })
  assert.deepEqual(ideasPlace(42, null), { path: 'ideas.md' })
})
