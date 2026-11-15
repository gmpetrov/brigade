import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  DEFAULT_DASHBOARD,
  allowedDashboard,
  dashboard,
  loadSettings,
  onDashboard,
  updateSettings,
} from '../src/settings.js'

test("reads and keeps the Tauri app's desktop.json", () => {
  const home = mkdtempSync(join(tmpdir(), 'brigade-settings-'))
  process.env.BRIGADE_HOME = home
  // As the Tauri app wrote it.
  writeFileSync(
    join(home, 'desktop.json'),
    JSON.stringify({
      dashboardUrl: null,
      loginSet: true,
      keepAwake: true,
      captureShortcut: 'ctrl+shift+s',
      newThreadShortcut: null,
      somethingNewer: 1,
    }),
  )
  assert.equal(loadSettings().captureShortcut, 'ctrl+shift+s')
  assert.equal(dashboard(), DEFAULT_DASHBOARD)
  updateSettings((s) => {
    s.dashboardUrl = 'https://brigade.example/app/'
  })
  const saved = JSON.parse(readFileSync(join(home, 'desktop.json'), 'utf8'))
  assert.equal(saved.somethingNewer, 1)
  assert.equal(saved.keepAwake, true)
  assert.equal(dashboard(), 'https://brigade.example/app')
  // A broken file is no settings, not a crash.
  writeFileSync(join(home, 'desktop.json'), '{')
  assert.deepEqual(loadSettings(), {})
  delete process.env.BRIGADE_HOME
})

test("knows the dashboard's site", () => {
  const home = 'https://www.brigade.lol/app'
  assert.ok(onDashboard('https://www.brigade.lol/app/capture', home))
  assert.ok(onDashboard('https://brigade.lol/sign-in', home))
  assert.ok(!onDashboard('https://brigade.lol.evil.test/', home))
  assert.ok(!onDashboard('http://www.brigade.lol/app', home))
  assert.ok(!onDashboard('https://api.brigade.lol/', home))
  assert.ok(!onDashboard('file:///Applications/Brigade.app', home))
  assert.ok(onDashboard('http://localhost:3000/app', 'http://localhost:3000/app'))
  assert.ok(!onDashboard('http://localhost:3001/', 'http://localhost:3000/app'))
  assert.ok(allowedDashboard('http://localhost:3000/app'))
  assert.ok(!allowedDashboard('http://brigade.test/app'))
})
