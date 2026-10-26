import assert from 'node:assert/strict'
import { test } from 'node:test'
import { idleBrowsers, isBrowserTool, stopIdle } from '../src/browsers.js'
import { chromeLogErrors } from '../src/chrome-log.js'

const MIN = 60_000

test('browser tools, as each harness names them, start the browser; others do not', () => {
  assert.equal(isBrowserTool('mcp__browser__browser_navigate'), true)
  assert.equal(isBrowserTool('browser.browser_snapshot'), true)
  assert.equal(isBrowserTool('browser_click'), true)
  assert.equal(isBrowserTool('mcp__harness-tools__start_preview'), false)
  assert.equal(isBrowserTool('Bash'), false)
  assert.equal(isBrowserTool('mcp__harness-tools__fill_credential'), false)
})

test('a browser nobody used for the idle time is stopped, one in use is not', () => {
  const used = new Map([
    ['bt-a', 0],
    ['bt-b', 10 * MIN],
  ])
  assert.deepEqual(
    idleBrowsers(['bt-a', 'bt-b'], used, 15 * MIN, () => false, 15 * MIN),
    ['bt-a'],
  )
  // Used again since: it stays.
  used.set('bt-a', 14 * MIN)
  assert.deepEqual(
    idleBrowsers(['bt-a', 'bt-b'], used, 16 * MIN, () => false, 15 * MIN),
    [],
  )
})

test('a browser the runner never saw used is counted from when it first sees it', () => {
  const used = new Map<string, number>()
  assert.deepEqual(
    idleBrowsers(['bt-a'], used, 100 * MIN, () => false, 15 * MIN),
    [],
  )
  assert.equal(used.get('bt-a'), 100 * MIN)
  assert.deepEqual(
    idleBrowsers(['bt-a'], used, 115 * MIN, () => false, 15 * MIN),
    ['bt-a'],
  )
})

test('a browser a person has control of is never idle, and is counted from when they hand back', () => {
  const used = new Map([['bt-a', 0]])
  let controlled = true
  assert.deepEqual(
    idleBrowsers(['bt-a'], used, 60 * MIN, () => controlled, 15 * MIN),
    [],
  )
  controlled = false
  assert.deepEqual(
    idleBrowsers(['bt-a'], used, 70 * MIN, () => controlled, 15 * MIN),
    [],
  )
  assert.deepEqual(
    idleBrowsers(['bt-a'], used, 75 * MIN, () => controlled, 15 * MIN),
    ['bt-a'],
  )
})

test('a stopped browser is forgotten', () => {
  const used = new Map([['bt-a', 0]])
  assert.deepEqual(
    idleBrowsers([], used, 60 * MIN, () => false, 15 * MIN),
    [],
  )
  assert.equal(used.has('bt-a'), false)
})

test("Chrome's last errors, without the ones repeated inside later ones", () => {
  const log = [
    '[1:2:0101/000000.000:INFO:x.cc(1)] fine',
    '[1:2:0101/000000.000:ERROR:ozone.cc(10)] Missing X server or $DISPLAY',
    '[1:2:0101/000000.000:ERROR:browser.cc(20)] Unable to show message box: Missing X server or $DISPLAY',
    '[1:2:0101/000000.000:FATAL:main.cc(30)] The platform failed to initialize.  Exiting.',
  ].join('\n')
  assert.equal(
    chromeLogErrors(log),
    'Missing X server or $DISPLAY / The platform failed to initialize.  Exiting.',
  )
  assert.equal(chromeLogErrors(''), '')
})

test('a browser used or taken control of while another one stops is not stopped', async () => {
  let clock = 20 * MIN
  const used = new Map([
    ['bt-a', 0],
    ['bt-b', 0],
    ['bt-c', 0],
  ])
  const controlled = new Set<string>()
  const stopped: string[] = []
  await stopIdle(
    ['bt-a', 'bt-b', 'bt-c'],
    used,
    (user) => controlled.has(user),
    async (user) => {
      stopped.push(user)
      // The stop takes a while: meanwhile b is used, and a person takes control of c.
      clock += 10_000
      used.set('bt-b', clock)
      controlled.add('bt-c')
    },
    () => clock,
    15 * MIN,
  )
  assert.deepEqual(stopped, ['bt-a'])
})
