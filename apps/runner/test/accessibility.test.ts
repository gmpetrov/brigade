import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ACCESSIBILITY_SETTINGS,
  accessibility,
  responsibleApp,
  type AccessibilityDeps,
  type Responsible,
} from '../src/accessibility.js'
import { accessibilityTools } from '../src/harness/tools.js'

function deps(granted: boolean, responsible: Responsible) {
  const opened: string[] = []
  const d: AccessibilityDeps = {
    granted: async () => granted,
    responsible: () => responsible,
    open: async (url) => {
      opened.push(url)
    },
  }
  return { d, opened }
}

test('the app macOS asks for: Brigade.app, an older one, or the terminal', () => {
  assert.equal(responsibleApp({ BRIGADE_DESKTOP_APP: '/Applications/Brigade.app/x' }), 'brigade')
  assert.equal(
    responsibleApp({ BRIGADE_COMPUTER_USE_APP: '/x/Brigade Computer Use.app' }),
    'brigade-old',
  )
  assert.equal(responsibleApp({}), 'terminal')
})

test('granted: nothing is opened, even with request', async () => {
  const { d, opened } = deps(true, 'brigade')
  assert.equal((await accessibility(d, true)).accessibility, 'granted')
  assert.deepEqual(opened, [])
})

test('missing, without request: only says so', async () => {
  const { d, opened } = deps(false, 'brigade')
  const answer = await accessibility(d, false)
  assert.equal(answer.accessibility, 'denied')
  assert.equal('requested' in answer, false)
  assert.deepEqual(opened, [])
})

test('missing, with request: Brigade.app asks, and the person gets one line to act on', async () => {
  const { d, opened } = deps(false, 'brigade')
  const answer = await accessibility(d, true)
  assert.deepEqual(opened, ['brigade://accessibility'])
  assert.ok(
    'ask' in answer && /Turn on Brigade/.test(answer.ask) && /take it back/.test(answer.ask),
  )
})

test('an older Brigade.app: System Settings opens, and the line says to add Brigade', async () => {
  const { d, opened } = deps(false, 'brigade-old')
  const answer = await accessibility(d, true)
  assert.deepEqual(opened, [ACCESSIBILITY_SETTINGS])
  assert.ok('ask' in answer && /add Brigade/.test(answer.ask))
})

test('a runner started in a terminal: nothing to ask of Brigade', async () => {
  const { d, opened } = deps(false, 'terminal')
  const answer = await accessibility(d, true)
  assert.equal(answer.accessibility, 'denied')
  assert.equal('app' in answer && answer.app, 'terminal')
  assert.deepEqual(opened, [])
})

test('accessibility_permission passes request through', async () => {
  const seen: boolean[] = []
  const tools = accessibilityTools(async (request) => {
    seen.push(request)
    return {}
  })
  const options = { toolCallId: 'call-1', messages: [] } as never
  await tools.accessibility_permission!.execute!({}, options)
  await tools.accessibility_permission!.execute!({ request: true }, options)
  assert.deepEqual(seen, [false, true])
})
