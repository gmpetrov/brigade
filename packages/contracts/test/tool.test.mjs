import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ToolManifest, toolFolderOf, toolManifestPaths, toolName } from '../dist/index.js'

test('an app is the folder its path is in, or is', () => {
  assert.equal(toolFolderOf('a/review.app/app.js'), 'a/review.app')
  assert.equal(toolFolderOf('a/review.app'), 'a/review.app')
  assert.equal(toolFolderOf('a/.app/x'), undefined)
  assert.equal(toolName('a/clip-review.app'), 'clip-review')
  assert.equal(toolName('a/plain'), 'plain')
  assert.deepEqual(toolManifestPaths('a/review.app'), [
    'a/review.app/app.json',
    'a/review.app/tool.json',
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
