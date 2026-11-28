import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ToolManifest,
  retiredAppFolderRefusal,
  toolFolderOf,
  toolManifestPath,
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
  assert.equal(toolManifestPath('a/review.webapp'), 'a/review.webapp/app.json')
})

test('a folder of another suffix is not an app', () => {
  assert.equal(toolFolderOf('a/review.tool/app.js'), undefined)
  assert.equal(toolFolderOf('a/b.design/index.html'), undefined)
})

test('app.json is lenient: a bad entry is left out, not the manifest', () => {
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

test('a teammate save into a .tool folder is refused: apps are .webapp folders now', () => {
  assert.match(retiredAppFolderRefusal('Social/tracker.tool/index.html'), /\.webapp/)
  assert.match(retiredAppFolderRefusal('a/tracker.tool/assets/x.png'), /\.webapp/)
  assert.equal(retiredAppFolderRefusal('Social/tracker.webapp/index.html'), null)
  assert.equal(retiredAppFolderRefusal('Social/notes.tool'), null)
  assert.equal(retiredAppFolderRefusal('Social/.tool/x'), null)
})
