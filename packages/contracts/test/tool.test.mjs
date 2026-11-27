import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ToolManifest,
  combinedManifest,
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

test('with both manifests, an app gets only what both allow; with one, that one', () => {
  const app = {
    title: 'New',
    reads: ['Film/clips', 'Film/secret'],
    hosts: ['https://a.example.com', 'https://b.example.com'],
    apps: [
      { kind: 'github', access: 'read_write' },
      { kind: 'notes', access: 'read' },
    ],
  }
  const legacy = {
    title: 'Old',
    reads: ['Film/clips'],
    hosts: ['https://a.example.com'],
    apps: [{ kind: 'github', access: 'read' }],
  }
  assert.deepEqual(combinedManifest(app, legacy), {
    title: 'New',
    reads: ['Film/clips'],
    hosts: ['https://a.example.com'],
    apps: [{ kind: 'github', access: 'read' }],
  })
  // Either way round: neither widens the other.
  assert.deepEqual(combinedManifest(legacy, app).apps, [{ kind: 'github', access: 'read' }])
  assert.equal(combinedManifest(app, undefined), app)
  assert.equal(combinedManifest(undefined, legacy), legacy)
  assert.equal(combinedManifest(undefined, undefined), null)
  // One there but unreadable allows nothing.
  assert.equal(combinedManifest(null, legacy), null)
  assert.deepEqual(combinedManifest(app, null).reads, [])
})
