import assert from 'node:assert/strict'
import { test } from 'node:test'

// The alert's text alone (src/computer-abuse.ts): its module reads the API's config.
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { abuseAlert } = await import('../src/computer-abuse.js')

const quiet = { smtp: 0, metadata: 0, scan: 0, mining: 0 }

test('an abuse alert names the workspace and what was stopped, and is critical', () => {
  const alert = abuseAlert(
    {
      type: 'abuse',
      blocked: { ...quiet, smtp: 12 },
      miners: [
        {
          user: 'bt-ada',
          pid: 42,
          command: './xmrig -o pool:3333',
          evidence: 'name',
          killed: true,
        },
      ],
      cpu: [],
    },
    'cmcomputer',
    'Acme',
  )
  assert.equal(alert.key, 'abuse:cmcomputer')
  assert.equal(alert.severity, 'critical')
  assert.match(alert.title, /Acme/)
  assert.match(alert.detail, /port 25\): 12 packet/)
  assert.match(alert.detail, /bt-ada pid 42 \(killed\): \.\/xmrig/)
  assert.doesNotMatch(alert.detail, /CPU kept/)
})

test('CPU kept for long alone is a warning', () => {
  const alert = abuseAlert(
    {
      type: 'abuse',
      blocked: quiet,
      miners: [],
      cpu: [{ user: 'bt-ada', share: 0.93, minutes: 45 }],
    },
    'cmcomputer',
    'Acme',
  )
  assert.equal(alert.severity, 'warning')
  assert.match(alert.detail, /bt-ada: 93% of all cores for 45 min/)
})

test("a pool only in a process's arguments is a warning, and says it was left running", () => {
  const alert = abuseAlert(
    {
      type: 'abuse',
      blocked: quiet,
      miners: [
        {
          user: 'bt-ada',
          pid: 7,
          command: './tool stratum+tcp://p:1',
          evidence: 'arguments',
          killed: false,
        },
      ],
      cpu: [],
    },
    'cmcomputer',
    'Acme',
  )
  assert.equal(alert.severity, 'warning')
  assert.match(alert.detail, /left running/)
})
