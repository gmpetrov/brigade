import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ToolManifest,
  newestManifest,
  toolFolderOf,
  toolManifestPaths,
  toolName,
} from '../dist/index.js'

test('an app is the folder its path is in, or is', () => {
  assert.equal(toolFolderOf('a/review.webapp/app.js'), 'a/review.webapp')
  assert.equal(toolFolderOf('a/review.webapp'), 'a/review.webapp')
  assert.equal(toolFolderOf('a/.webapp/x'), undefined)
  assert.equal(toolName('a/clip-review.webapp'), 'clip-review')
  assert.equal(toolName('a/plain'), 'plain')
  // A folder ending in .app (a macOS bundle, or a domain such as acme.app) is not one.
  assert.equal(toolFolderOf('Sites/acme.app/index.html'), undefined)
  assert.deepEqual(toolManifestPaths('a/review.webapp'), [
    'a/review.webapp/app.json',
    'a/review.webapp/tool.json',
  ])
})

test('an app saved as a tool before the rename is still one', () => {
  assert.equal(toolFolderOf('a/review.tool/app.js'), 'a/review.tool')
  assert.equal(toolFolderOf('a/review.tool'), 'a/review.tool')
  assert.equal(toolFolderOf('review.tool/x/y.png'), 'review.tool')
  assert.equal(toolFolderOf('a/.tool/x'), undefined)
  assert.equal(toolFolderOf('a/b.design/index.html'), undefined)
  assert.equal(toolName('a/clip-review.tool'), 'clip-review')
})

test('tool.json is lenient: a bad entry is left out, not the manifest', () => {
  const parsed = ToolManifest.parse({
    title: 'Review',
    reads: ['Film/clips', '../etc', 7],
    apps: [{ kind: 'github' }, { access: 'read' }, { kind: 'posthog', access: 'read_write' }],
    hosts: ['https://api.example.com', 'http://plain.example.com', 'https://x.com/path'],
  })
  assert.deepEqual(parsed.reads, ['Film/clips'])
  assert.deepEqual(parsed.apps, [
    { kind: 'github', access: 'read' },
    { kind: 'posthog', access: 'read_write' },
  ])
  assert.deepEqual(parsed.hosts, ['https://api.example.com'])
})

test('of an app.json and a tool.json, the one saved last counts; app.json when saved at once', () => {
  const at = (path, ms) => ({ path, updatedAt: new Date(ms) })
  const app = at('a.webapp/app.json', 1)
  assert.equal(
    newestManifest('a.webapp', [app, at('a.webapp/tool.json', 2)]).path,
    'a.webapp/tool.json',
  )
  assert.equal(
    newestManifest('a.webapp', [at('a.webapp/tool.json', 1), app]).path,
    'a.webapp/app.json',
  )
  assert.equal(newestManifest('a.webapp', [at('a.webapp/other.json', 9)]), undefined)
})
