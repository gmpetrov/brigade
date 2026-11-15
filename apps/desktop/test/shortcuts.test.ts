import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accelerator, chosen, choices, kinds } from '../src/shortcuts.js'

test('keeps the shortcuts picked in the Tauri app', () => {
  assert.equal(
    chosen('screenshot', { captureShortcut: 'ctrl+alt+cmd+b' }, 'darwin'),
    'ctrl+alt+cmd+b',
  )
  assert.equal(chosen('newThread', { newThreadShortcut: null }, 'darwin'), 'cmd+shift+1')
  assert.equal(chosen('newThread', { newThreadShortcut: 'off' }, 'darwin'), 'off')
  // One a Mac offers is no choice elsewhere: the default there.
  assert.equal(chosen('newThread', { newThreadShortcut: 'cmd+shift+1' }, 'linux'), 'ctrl+shift+1')
})

test('writes them as Electron does', () => {
  assert.equal(accelerator('cmd+shift+2'), 'Command+Shift+2')
  assert.equal(accelerator('ctrl+alt+cmd+n'), 'Control+Alt+Command+N')
  assert.equal(accelerator('alt+space'), 'Alt+Space')
  assert.equal(accelerator('off'), undefined)
})

test('screenshots on macOS only, and no shortcut offered twice', () => {
  assert.deepEqual(kinds('darwin'), ['screenshot', 'newThread'])
  assert.deepEqual(kinds('linux'), ['newThread'])
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    const ids = kinds(platform).flatMap((k) => choices(k, platform).map((c) => c.id))
    const real = ids.filter((id) => id !== 'off')
    assert.equal(new Set(real).size, real.length)
  }
})
