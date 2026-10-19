import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PLAYBOOK_TEMPLATES } from '../src/generated/playbooks.js'

// playbooks.ts reads the API's config when imported; nothing here reaches a database or the vault.
process.env.DATABASE_URL ??= 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { fill, readTemplate, templates } = await import('../src/playbooks.js')

const SKILL = '---\nname: triage\ndescription: Sort one mail\n---\n\nSteps.\n'

/** A small valid template, changed by each case. */
const template = (change: (m: Record<string, any>) => void = () => {}) => {
  const manifest: Record<string, any> = {
    id: 'brigade/inbox',
    name: 'Inbox',
    version: '1.0.0',
    description: 'Answers the inbox.',
    apps: [{ kind: 'gmail', access: 'read_write' }],
    settings: [
      { key: 'inbox', type: 'account', app: 'gmail', ask: 'Which inbox?' },
      { key: 'address', type: 'email' },
    ],
    entries: [
      {
        trigger: 'gmail.email_received',
        account: '{{inbox}}',
        options: { query: 'to:{{address}}' },
      },
      { schedule: '0 8 * * 1', instructions: 'Review the week of {{address}}.' },
    ],
    skills: ['skills/triage'],
    actions: [
      { key: 'reply', label: 'Reply', tools: ['gmail_send'], start: 'ask', ceiling: 'auto' },
    ],
    limits: { runsPerDay: 10 },
  }
  change(manifest)
  return {
    manifest,
    files: { 'skills/triage/SKILL.md': SKILL, 'skills/triage/cases.md': '# Cases' },
  }
}

test('every playbook shipped with the API loads', () => {
  assert.ok(Object.keys(PLAYBOOK_TEMPLATES).length > 0)
  const all = templates()
  assert.equal(all.size, Object.keys(PLAYBOOK_TEMPLATES).length)
  const support = all.get('brigade/support-bugs')
  assert.ok(support)
  assert.deepEqual(
    support.skills.map((s) => s.name),
    ['support-triage', 'bug-fix'],
  )
})

test('reads a template: its manifest with defaults, its skills and their files', () => {
  const { manifest, skills } = readTemplate('inbox', template())
  assert.deepEqual(manifest.promotion, { decisions: 30, approvedRate: 0.95 })
  assert.deepEqual(manifest.actions[0]!.conditions, [])
  assert.deepEqual(skills, [
    {
      folder: 'skills/triage',
      name: 'triage',
      description: 'Sort one mail',
      instructions: 'Steps.',
      files: [{ path: 'cases.md', content: '# Cases' }],
    },
  ])
})

const rejects = (name: string, change: (m: Record<string, any>) => void, why: RegExp) =>
  test(`rejects ${name}`, () => assert.throws(() => readTemplate('inbox', template(change)), why))

rejects('an id that is not its folder', (m) => (m.id = 'brigade/other'), /must be brigade\/inbox/)
rejects('a version that is not semver', (m) => (m.version = 'v1'), /semver/)
rejects(
  'an App Brigade does not have',
  (m) => m.apps.push({ kind: 'fax', access: 'read' }),
  /no App fax/,
)
rejects(
  'a trigger the App does not have',
  (m) => (m.entries[0].trigger = 'gmail.email_deleted'),
  /gmail has no trigger email_deleted/,
)
rejects(
  'a trigger option the catalog does not have',
  (m) => (m.entries[0].options = { folder: 'x' }),
  /has no option folder/,
)
rejects(
  'a trigger on an App it does not declare',
  (m) => (m.entries[0].trigger = 'stripe.payment_received'),
  /stripe is not among its apps/,
)
rejects('a cron that does not run', (m) => (m.entries[1].schedule = '61 * * * *'), /entries\.1/)
rejects(
  'a {{setting}} it does not have',
  (m) => (m.entries[1].instructions = '{{product}}'),
  /\{\{product\}\} is not a setting/,
)
rejects(
  'an action whose tool none of its Apps has',
  (m) => (m.actions[0].tools = ['stripe_refund']),
  /no App of it has the tool stripe_refund/,
)
rejects(
  'an action that starts above its ceiling',
  (m) => (m.actions[0].start = 'auto') && (m.actions[0].ceiling = 'ask'),
  /start is above ceiling/,
)
rejects(
  'two actions with the same key',
  (m) => m.actions.push({ ...m.actions[0] }),
  /two actions are called reply/,
)
rejects(
  'an account setting of an App it does not declare',
  (m) => (m.settings[0].app = 'stripe'),
  /stripe is not among its apps/,
)
rejects(
  'a skill folder with no SKILL.md',
  (m) => m.skills.push('skills/missing'),
  /skills\/missing has no SKILL\.md/,
)
rejects('no entries', (m) => (m.entries = []), /entries/)

test('fill puts settings in, and leaves unknown ones', () => {
  assert.equal(fill('to:{{ address }} {{other}}', { address: 'a@b.c' }), 'to:a@b.c {{other}}')
})

const { withDefaults } = await import('../src/playbooks.js')
const { pushRefusal } = await import('../src/git.js')
const { gmail } = await import('../src/connectors/gmail.js')
const { childNote, DRY_RUN_HEAD } = await import('@brigade/contracts')

test('withDefaults fills defaults from the answers, and names what still lacks one', () => {
  const { manifest } = readTemplate(
    'inbox',
    template((m) =>
      m.settings.push(
        { key: 'product', type: 'text' },
        { key: 'signature', type: 'text', default: 'The {{product}} team' },
        { key: 'extra', type: 'text', optional: true },
      ),
    ),
  )
  assert.deepEqual(withDefaults(manifest, { product: 'Acme' }), {
    values: { product: 'Acme', signature: 'The Acme team' },
    missing: ['inbox', 'address'],
  })
})

test('a dry run refuses every push, before any branch is named', () => {
  const request = (dryRun: boolean) =>
    ({
      session: { id: 's', origin: 'trigger', dryRun },
      teammate: { id: 't', name: 'Sam', caps: {}, permissionPolicy: {} },
      fullName: 'acme/web',
      via: { connectionId: 'c', installationId: 1, write: true },
    }) as never
  assert.match(pushRefusal(request(true)) ?? '', /dry run, so nothing is pushed/)
  assert.equal(pushRefusal(request(false)), null)
})

test('Gmail replays the latest mails its search matches, as the inbox reader hands them', async () => {
  const asked: string[] = []
  const message = (id: string, at: number) => ({
    id,
    threadId: `t${id}`,
    internalDate: String(at),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'Jane <jane@customer.test>' },
        { name: 'Subject', value: `Mail ${id}` },
        { name: 'Message-ID', value: `<${id}@x>` },
      ],
      body: { data: Buffer.from(`Body ${id}`).toString('base64url') },
    },
  })
  const fetch = async (url: string) => {
    asked.push(url)
    const u = new URL(url)
    if (u.pathname.endsWith('/messages'))
      return Response.json({ messages: [{ id: 'b' }, { id: 'a' }] })
    const id = u.pathname.split('/').pop()!
    return Response.json(message(id, id === 'a' ? 1_700_000_000_000 : 1_700_000_360_000))
  }
  const events = await gmail.triggers!.email_received!.replay!(
    { query: 'to:support@acme.test' },
    { fetch: fetch as never },
    2,
  )
  const search = new URL(asked[0]!).searchParams
  assert.equal(search.get('q'), '(to:support@acme.test) in:inbox -in:sent -in:drafts')
  assert.equal(search.get('maxResults'), '2')
  assert.deepEqual(
    events.map((e) => [e.id, e.type, e.at, e.payload.subject, e.payload.rfcMessageId]),
    [
      ['b', 'email', new Date(1_700_000_360_000).toISOString(), 'Mail b', '<b@x>'],
      ['a', 'email', new Date(1_700_000_000_000).toISOString(), 'Mail a', '<a@x>'],
    ],
  )
})

test("the dry run's closing note shows as Brigade's, not as a person's message", () => {
  assert.equal(childNote(`${DRY_RUN_HEAD}Support and bugs is done: 3 events`), 'dry_run')
})
