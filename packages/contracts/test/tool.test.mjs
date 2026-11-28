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

test("an old app's page or manifest in a .tool folder is refused; other files are not", () => {
  assert.match(retiredAppFolderRefusal('Social/tracker.tool/tool.json'), /\.webapp/)
  assert.match(retiredAppFolderRefusal('Social/tracker.tool/index.html'), /\.webapp/)
  // Anything else in a folder that happens to end in .tool saves as usual.
  assert.equal(retiredAppFolderRefusal('Exports/vendor.tool/notes.md'), null)
  assert.equal(retiredAppFolderRefusal('Social/tracker.tool/assets/index.html'), null)
  // Inside an app, a resource folder named .tool is just a folder.
  assert.equal(retiredAppFolderRefusal('a/board.webapp/vendor/widget.tool/data.json'), null)
  assert.equal(retiredAppFolderRefusal('a/board.webapp/vendor/widget.tool/index.html'), null)
  assert.equal(retiredAppFolderRefusal('Social/tracker.webapp/index.html'), null)
  assert.equal(retiredAppFolderRefusal('Social/.tool/index.html'), null)
})
