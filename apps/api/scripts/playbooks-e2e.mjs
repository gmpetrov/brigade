// End-to-end check of playbooks (src/playbooks.ts) against the real API and database: the
// support-bugs playbook installed through the API receives a mail through its Gmail trigger
// (a fake Gmail in the API's process, scripts/fake-gmail.mjs), starts a run out of the
// sidebar with only the tools of the Apps it declares, and shows in its sheet. Then it is
// installed from a chat (src/playbook-chat.ts), tried in a dry run on the mailbox's past mails
// with nothing sent (src/playbook-dry-runs.ts), and activated: by an owner at once, and for a
// member through one ticket an owner approves. A scripted runner on the real runner socket
// stands in for the teammate. It needs the preview's sample
// workspace (scripts/preview/setup.sh) and an API on its database, with nothing else
// connected as the cloud computer's runner (it takes that runner's place):
//
//   cd apps/api && FAKE_GMAIL=/tmp/fake-gmail.json PORT=3101 API_URL=http://localhost:3101 \
//     WEB_URL=http://localhost:3102 node --env-file=.env --import tsx --import ./scripts/fake-gmail.mjs src/index.ts
//   node apps/api/scripts/playbooks-e2e.mjs "$PWD" http://localhost:3101 /tmp/fake-gmail.json
//
// Gmail is polled every minute, so it takes a few minutes.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const [repo, API, mailbox] = process.argv.slice(2)
const require = createRequire(`${repo}/apps/api/package.json`)
const WebSocket = createRequire(`${repo}/apps/runner/package.json`)('ws')
const pg = require('pg')
const env = Object.fromEntries(
  require('node:fs')
    .readFileSync(`${repo}/apps/api/.env`, 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]),
)
const db = new pg.Client({ connectionString: env.DATABASE_URL })
await db.connect()
const q = async (sql, args = []) => (await db.query(sql, args)).rows

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(what, check, ms = 20_000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await check()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(300)
  }
}

// --- The mailbox: mails arrive when written here ------------------------------
const mails = []
const receive = (mail) => {
  mails.push({ ...mail, historyId: Date.now() })
  writeFileSync(mailbox, JSON.stringify({ mails }))
}
writeFileSync(mailbox, JSON.stringify({ mails }))

// --- Sign in as Ada (an owner: she activates what she installs) -------------
const origin = process.env.WEB_URL ?? 'http://localhost:3102'
const signIn = await fetch(`${API}/api/auth/sign-in/email`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin },
  body: JSON.stringify({ email: 'ada@example.com', password: 'correct-horse-battery' }),
})
assert.equal(signIn.status, 200, await signIn.clone().text())
const cookie = signIn.headers
  .getSetCookie()
  .map((c) => c.split(';')[0])
  .join('; ')
async function call(path, { method = 'GET', body, as = cookie } = {}) {
  const res = await fetch(`${API}/api${path}`, {
    method: body && method === 'GET' ? 'POST' : method,
    headers: { cookie: as, origin, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

// --- A runner for the workspace's cloud computer ------------------------------
const [computer] = await q(
  `select c.id, c."organizationId", c."workspaceId" from "Computer" c join "Organization" o on o.id = c."organizationId"
   where c.kind = 'cloud' and c.status <> 'destroyed' and o.name = 'Acme' limit 1`,
)
const token = randomBytes(24).toString('hex')
await q(`delete from "Runner" where "computerId" = $1`, [computer.id])
await q(
  `insert into "Runner" (id, "organizationId", "workspaceId", "computerId", "tokenHash") values ($1,$2,$3,$4,$5)`,
  [
    `e2e${Date.now()}`,
    computer.organizationId,
    computer.workspaceId,
    computer.id,
    createHash('sha256').update(token).digest('hex'),
  ],
)
{
  const r = await fetch(`${API}/api/auth/organization/set-active`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ organizationId: computer.organizationId }),
  })
  assert.equal(r.status, 200, await r.text())
}
await call('/workspaces/switch', { body: { workspaceId: computer.workspaceId } })
const inWs = [computer.organizationId, computer.workspaceId]

// Sam answers support: Gmail and Stripe (sample), and here also a Calendar the playbook does
// not declare, whose tools its threads must not get.
const [sam] = await q(`select id from "Teammate" where "workspaceId" = $1 and name = 'Sam'`, [
  computer.workspaceId,
])
const [gmail] = await q(
  `select id from "Connection" where "workspaceId" = $1 and kind = 'gmail' and "externalAccount" = 'support@acme.test'`,
  [computer.workspaceId],
)
const [stripe] = await q(
  `select id from "Connection" where "workspaceId" = $1 and kind = 'stripe' limit 1`,
  [computer.workspaceId],
)
const [ada] = await q(
  `select m.id from "Member" m join "User" u on u.id = m."userId" where u.email = 'ada@example.com' and m."organizationId" = $1`,
  [computer.organizationId],
)
let [calendarApp] = await q(
  `select id from "App" where "workspaceId" = $1 and key = 'google_calendar'`,
  [computer.workspaceId],
)
if (!calendarApp) {
  calendarApp = { id: `e2eapp${Date.now()}` }
  await q(
    `insert into "App" (id, "organizationId", "workspaceId", key, "createdByMemberId", "updatedAt") values ($1,$2,$3,'google_calendar',$4, now())`,
    [calendarApp.id, ...inWs, ada.id],
  )
}
const calendar = { id: `e2econn${Date.now()}` }
await q(
  `insert into "Connection" (id, "organizationId", "workspaceId", "appId", kind, label, "externalAccount", "createdByMemberId", "updatedAt")
   values ($1,$2,$3,$4,'google_calendar','Team calendar','team@acme.test',$5, now())`,
  [calendar.id, ...inWs, calendarApp.id, ada.id],
)
await q(
  `insert into "Grant" (id, "organizationId", "workspaceId", "teammateId", "connectionId", scope) values ($1,$2,$3,$4,$5,'read_write')`,
  [`e2egrant${Date.now()}`, ...inWs, sam.id, calendar.id],
)

// --- The scripted runner -----------------------------------------------------
const ws = new WebSocket(`${API.replace('http', 'ws')}/runner/ws`, {
  headers: { authorization: `Bearer ${token}` },
})
await new Promise((resolve, reject) => {
  ws.once('open', resolve)
  ws.once('error', reject)
})
const send = (m) => ws.send(JSON.stringify(m))
send({ type: 'hello', protocolVersion: 31, version: 'e2e', platform: 'linux' })
// A runner says it is there every 30 s, or the API forgets it.
const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 30_000)

const prompts = [] // every thread.prompt: { sessionId, text, spec }
const seqs = new Map()
const busy = new Map()
const pendingCalls = new Map()
const scripts = []

ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.type === 'connector.result') {
    pendingCalls.get(m.callId)?.(m)
    pendingCalls.delete(m.callId)
  } else if (m.type === 'thread.prompt') {
    const p = {
      sessionId: m.thread.sessionId,
      text: m.text,
      spec: m.thread,
      teammateId: m.thread.teammate.id,
      memberId: m.memberId,
    }
    prompts.push(p)
    const chain = (busy.get(p.sessionId) ?? Promise.resolve()).then(() => turn(p))
    busy.set(
      p.sessionId,
      chain.catch((e) => console.error('turn failed', e)),
    )
  }
})

function emit(sessionId, events) {
  const out = events.map((event) => {
    const seq = (seqs.get(sessionId) ?? 0) + 1
    seqs.set(sessionId, seq)
    return { sessionId, seq, event: { at: new Date().toISOString(), ...event } }
  })
  send({ type: 'events', events: out })
}

function op(message) {
  const callId = randomUUID()
  return new Promise((resolve) => {
    pendingCalls.set(callId, resolve)
    send({ ...message, callId })
  })
}

async function turn(p) {
  const t = p.teammateId
  emit(p.sessionId, [
    { type: 'message.user', text: p.text, memberId: p.memberId ?? null },
    { type: 'turn.started', teammateId: t, accountId: 'x', turnId: randomUUID() },
  ])
  const script = scripts.map((s) => s(p)).find(Boolean)
  const said = (await script?.(p)) ?? 'ok'
  emit(p.sessionId, [
    { type: 'message.done', id: randomUUID(), text: said, teammateId: t },
    { type: 'turn.completed', finishReason: 'stop', teammateId: t },
  ])
}

const schedule = (p, operation) =>
  op({ type: 'schedule.call', sessionId: p.sessionId, teammateId: p.teammateId, operation })
const connector = (p, connectionId, operation, input) =>
  op({
    type: 'connector.call',
    sessionId: p.sessionId,
    teammateId: p.teammateId,
    connectionId,
    operation,
    input,
  })
const promptsTo = (id) => prompts.filter((x) => x.sessionId === id)

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push(`PASS ${name}`)
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`)
  }
}

// =============================================================================
let playbook
await check('installed through the API: its triggers, schedule, skills and actions', async () => {
  // Whatever an earlier run left.
  for (const old of await call('/playbooks'))
    await call(`/playbooks/${old.id}`, { method: 'DELETE' })
  playbook = await call('/playbooks', {
    body: {
      playbookKey: 'brigade/support-bugs',
      teammateId: sam.id,
      settings: {
        product: 'Acme',
        inbox: gmail.id,
        address: 'support@acme.test',
        docs: 'https://docs.acme.test',
        repo: 'acme/web',
      },
    },
  })
  // In setup until activated: Ada is an owner, so the Activate button turns it on.
  assert.equal(playbook.status, 'setup')
  assert.equal(playbook.ready, true)
  playbook = (await call(`/playbooks/${playbook.id}/activate`, { body: {} })).playbook
  assert.equal(playbook.status, 'active')
  assert.equal(playbook.name, 'Support and bugs')
  assert.equal(playbook.actions.length, 5)
  assert.deepEqual(
    playbook.entries.map((e) => e.kind),
    ['trigger', 'schedule'],
  )
  const [trigger] = await q(`select options from "Trigger" where "playbookInstallationId" = $1`, [
    playbook.id,
  ])
  assert.deepEqual(trigger.options, { query: 'to:support@acme.test' })
  const skills = await q(
    `select s.name from "Skill" s join "SkillPack" p on p.id = s."packId" where p."playbookInstallationId" = $1 order by s.name`,
    [playbook.id],
  )
  assert.deepEqual(
    skills.map((s) => s.name),
    ['bug-fix', 'support-triage'],
  )
  // A playbook's schedule and trigger are changed through it only.
  const [s] = await q(`select id from "Schedule" where "playbookInstallationId" = $1`, [
    playbook.id,
  ])
  await assert.rejects(call(`/schedules/${s.id}`, { method: 'DELETE' }), /belongs to a playbook/)
  // And they show in the playbook, not in the lists of schedules and triggers.
  assert.ok(!(await call('/schedules')).some((x) => x.id === s.id))
  assert.ok(!(await call('/triggers')).some((x) => x.playbookInstallationId))
})

let runThread
await check('a mail to the support address starts a run out of the sidebar', async () => {
  scripts.push((p) =>
    p.text.includes('Hello, how do I connect WordPress?')
      ? async (p) => {
          const r = await schedule(p, {
            name: 'playbook_report',
            case: 'documented_question',
            outcome: 'resolved',
          })
          assert.ok(r.ok, JSON.stringify(r))
          return 'Answered from the docs.'
        }
      : undefined,
  )
  receive({
    id: `m${Date.now()}a`,
    threadId: 't-wordpress',
    from: 'Jane <jane@customer.test>',
    to: 'support@acme.test',
    subject: 'WordPress',
    body: 'Hello, how do I connect WordPress?',
  })
  const p = await until(
    'the run’s first prompt',
    () => prompts.find((x) => x.text.includes('Hello, how do I connect WordPress?')),
    150_000,
  )
  runThread = p.sessionId
  const [row] = await q(
    `select s.origin, s."playbookRunId", s."surfacedAt", r."installationId", r."rootSessionId", r."conversationKey"
     from "Session" s join "PlaybookRun" r on r.id = s."playbookRunId" where s.id = $1`,
    [runThread],
  )
  assert.equal(row.origin, 'trigger')
  assert.equal(row.installationId, playbook.id)
  assert.equal(row.rootSessionId, runThread)
  assert.equal(row.conversationKey, 't-wordpress')
  assert.equal(row.surfacedAt, null)
  assert.ok(!(await call('/threads')).some((t) => t.id === runThread), 'not in the sidebar')
})

await check('its thread has only the tools of the Apps the playbook declares', async () => {
  const { spec } = promptsTo(runThread)[0]
  const tools = Object.fromEntries(spec.connectors.map((c) => [c.kind, c.scope]))
  assert.deepEqual(tools, { gmail: 'read_write', stripe: 'read' }, JSON.stringify(tools))
  assert.equal(spec.playbook?.installationId, playbook.id)
  const skills = spec.skills.map((s) => s.name)
  assert.ok(skills.includes('support-triage') && skills.includes('bug-fix'), skills.join())
  // Elsewhere, Sam keeps every App and gets none of the playbook's skills.
  const other = await call('/threads', {
    body: { teammateId: sam.id, computerId: computer.id, text: 'An ordinary thread' },
  })
  const otherId = other.id ?? other.thread?.id
  const plain = (await until('the ordinary thread', () => promptsTo(otherId)[0])).spec
  assert.ok(plain.connectors.some((c) => c.kind === 'google_calendar'))
  assert.equal(plain.playbook ?? null, null)
  assert.ok(!plain.skills.some((s) => s.name === 'support-triage'))
})

await check(
  'the API refuses an App the playbook does not declare, and a write it only reads',
  async () => {
    const p = promptsTo(runThread)[0]
    const cal = await connector(p, calendar.id, 'calendar_list_calendars', {})
    assert.equal(cal.ok, false)
    assert.match(cal.error, /does not use/)
    const refund = await connector(p, stripe.id, 'stripe_refund', { chargeId: 'ch_123' })
    assert.equal(refund.ok, false)
    assert.match(refund.error, /only reads/)
  },
)

await check('playbook_report records the case and outcome, shown in the sheet', async () => {
  await until('the report', async () => {
    const [r] = await q(
      `select "case", outcome, status from "PlaybookRun" where "rootSessionId" = $1`,
      [runThread],
    )
    return r?.outcome === 'resolved' && r
  })
  const sheet = await call(`/playbooks/${playbook.id}`)
  const run = sheet.recentRuns.find((r) => r.threadId === runThread)
  assert.ok(run, 'in recent runs')
  assert.equal(run.case, 'documented_question')
  assert.equal(run.status, 'done')
  assert.equal(sheet.runsThisWeek, 1)
})

await check('a reply in the same Gmail thread continues the run', async () => {
  receive({
    id: `m${Date.now()}b`,
    threadId: 't-wordpress',
    from: 'Jane <jane@customer.test>',
    to: 'support@acme.test',
    subject: 'Re: WordPress',
    body: 'Thanks, and for Webflow?',
  })
  await until('the second prompt', () => promptsTo(runThread).length >= 2, 150_000)
  const runs = await q(`select status from "PlaybookRun" where "installationId" = $1`, [
    playbook.id,
  ])
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'running')
})

await check('a child of the run is part of it', async () => {
  let childId
  scripts.unshift((p) =>
    p.sessionId === runThread && p.text.includes('fix it')
      ? async (p) => {
          const r = await schedule(p, {
            name: 'start_child',
            title: 'Fix the export',
            instructions: 'Fix the export bug',
            wait: false,
          })
          assert.ok(r.ok, JSON.stringify(r))
          childId = r.output.threadId
          return 'Started the fix.'
        }
      : undefined,
  )
  // A member writing in it: it joins their Threads, and counts as stepping in.
  await call(`/threads/${runThread}/messages`, { body: { text: 'Please fix it' } })
  await until('the child', () => childId, 30_000)
  const [child] = await q(`select "playbookRunId" from "Session" where id = $1`, [childId])
  const [root] = await q(`select "playbookRunId", "surfacedAt" from "Session" where id = $1`, [
    runThread,
  ])
  assert.equal(child.playbookRunId, root.playbookRunId)
  const childSpec = (await until('the child prompt', () => promptsTo(childId)[0])).spec
  assert.deepEqual(childSpec.connectors.map((c) => c.kind).sort(), ['gmail', 'stripe'])
  assert.ok(root.surfacedAt, 'surfaced')
  assert.ok(
    (await call('/threads')).some((t) => t.id === runThread),
    'now in the sidebar',
  )
  const [run] = await q(`select interventions from "PlaybookRun" where id = $1`, [
    root.playbookRunId,
  ])
  assert.equal(run.interventions, 1)
})

await check('past its runs a day, the event waits and the owner gets a ticket', async () => {
  await q(
    `update "PlaybookInstallation" set manifest = jsonb_set(manifest, '{limits,runsPerDay}', '2') where id = $1`,
    [playbook.id],
  )
  receive({
    id: `m${Date.now()}c`,
    threadId: 't-export',
    from: 'Bob <bob@customer.test>',
    to: 'support@acme.test',
    subject: 'Export',
    body: 'Export fails with a 500',
  })
  await until(
    'the second run',
    async () => {
      const runs = await q(`select id from "PlaybookRun" where "installationId" = $1`, [
        playbook.id,
      ])
      return runs.length === 2
    },
    150_000,
  )
  receive({
    id: `m${Date.now()}d`,
    threadId: 't-billing',
    from: 'Eve <eve@customer.test>',
    to: 'support@acme.test',
    subject: 'Invoice',
    body: 'Where is my invoice?',
  })
  const [ticket] = await until(
    'the ticket',
    () =>
      q(
        `select title, payload from "Ticket" where status = 'open' and payload->>'playbookInstallationId' = $1`,
        [playbook.id],
      ).then((rows) => rows.length && rows),
    150_000,
  )
  assert.match(ticket.title, /reached its 2 runs a day/)
  const runs = await q(`select id from "PlaybookRun" where "installationId" = $1`, [playbook.id])
  assert.equal(runs.length, 2)
})

await check('pausing stops its schedule; uninstalling removes all it made', async () => {
  const paused = await call(`/playbooks/${playbook.id}`, {
    method: 'PATCH',
    body: { paused: true },
  })
  assert.equal(paused.status, 'paused')
  const [s] = await q(`select "pausedAt" from "Schedule" where "playbookInstallationId" = $1`, [
    playbook.id,
  ])
  assert.ok(s.pausedAt)
  const [unsurfaced] = await q(
    `select s.id from "Session" s join "PlaybookRun" r on r.id = s."playbookRunId" where r."installationId" = $1 and s."surfacedAt" is null and s."parentId" is null`,
    [playbook.id],
  )
  await call(`/playbooks/${playbook.id}`, { method: 'DELETE' })
  for (const table of ['Trigger', 'Schedule', 'SkillPack'])
    assert.equal(
      (await q(`select id from "${table}" where "playbookInstallationId" = $1`, [playbook.id]))
        .length,
      0,
      table,
    )
  const [archived] = await q(`select "archivedAt" from "Session" where id = $1`, [unsurfaced.id])
  assert.ok(archived.archivedAt, 'its unsurfaced run is archived')
  const [kept] = await q(`select "archivedAt" from "Session" where id = $1`, [runThread])
  assert.equal(kept.archivedAt, null, 'the run a person joined stays')
})

// =============================================================================
// Installed from the chat, tried in a dry run, then activated
// =============================================================================

// Sam needs GitHub too (the playbook fixes bugs); the sample has none.
let [githubApp] = await q(`select id from "App" where "workspaceId" = $1 and key = 'github'`, [
  computer.workspaceId,
])
if (!githubApp) {
  githubApp = { id: `e2egh${Date.now()}` }
  await q(
    `insert into "App" (id, "organizationId", "workspaceId", key, "createdByMemberId", "updatedAt") values ($1,$2,$3,'github',$4, now())`,
    [githubApp.id, ...inWs, ada.id],
  )
}
const github = { id: `e2eghc${Date.now()}` }

// The mailbox's past: four mails to the support address over three days, and one elsewhere.
const day = 24 * 3600_000
const past = [
  { subject: 'WordPress', body: 'How do I connect WordPress?', ago: 3 * day },
  { subject: 'Export broken', body: 'The CSV export fails with a 500', ago: 2 * day },
  { subject: 'Pricing', body: 'Do you have a yearly plan?', ago: day },
  { subject: 'Login', body: 'I cannot log in since yesterday', ago: 0 },
]
for (const [i, m] of past.entries())
  receive({
    id: `p${Date.now()}${i}`,
    threadId: `tp${Date.now()}${i}`,
    from: `Customer ${i} <c${i}@customer.test>`,
    to: 'support@acme.test',
    subject: m.subject,
    body: m.body,
    at: Date.now() - m.ago,
  })
receive({
  id: `p${Date.now()}x`,
  threadId: `tpx${Date.now()}`,
  from: 'Newsletter <news@vendor.test>',
  to: 'ada@acme.test',
  subject: 'Not for support',
  body: 'Unrelated',
  at: Date.now(),
})

let installThread
let installationId
const dryRunPrompts = []
const said = {}
await check('installed from the chat: its card, then its settings one by one', async () => {
  scripts.unshift((p) =>
    p.text.startsWith('Install the playbook')
      ? async (p) => {
          const shown = await schedule(p, {
            name: 'show_playbook',
            playbookKey: 'brigade/support-bugs',
          })
          assert.ok(shown.ok, JSON.stringify(shown))
          assert.equal(shown.output.playbook.name, 'Support and bugs')
          assert.equal(shown.output.playbook.source, 'brigade')
          // The first answer: a new installation in setup, the next question, and GitHub missing.
          const first = await schedule(p, {
            name: 'configure_playbook',
            playbookKey: 'brigade/support-bugs',
            settings: { product: 'Acme' },
          })
          assert.ok(first.ok, JSON.stringify(first))
          said.first = first.output
          // A wrong answer is refused by its type.
          const bad = await schedule(p, {
            name: 'configure_playbook',
            installationId: first.output.installationId,
            settings: { docs: 'not a url' },
          })
          said.bad = bad
          // GitHub connected meanwhile (the ticket the teammate would open).
          await q(
            `insert into "Connection" (id, "organizationId", "workspaceId", "appId", kind, label, "externalAccount", "createdByMemberId", "updatedAt")
             values ($1,$2,$3,$4,'github','acme','acme',$5, now())`,
            [github.id, ...inWs, githubApp.id, ada.id],
          )
          await q(
            `insert into "Grant" (id, "organizationId", "workspaceId", "teammateId", "connectionId", scope) values ($1,$2,$3,$4,$5,'read_write')`,
            [`e2eghg${Date.now()}`, ...inWs, sam.id, github.id],
          )
          // The rest; the inbox by its address, as a person says it.
          const rest = await schedule(p, {
            name: 'configure_playbook',
            installationId: first.output.installationId,
            settings: {
              inbox: 'support@acme.test',
              address: 'Support@Acme.test',
              docs: 'https://docs.acme.test',
              repo: 'https://github.com/acme/web',
            },
          })
          assert.ok(rest.ok, JSON.stringify(rest))
          said.rest = rest.output
          const started = await schedule(p, {
            name: 'start_dry_run',
            installationId: first.output.installationId,
            last: 4,
          })
          assert.ok(started.ok, JSON.stringify(started))
          said.started = started.output
          return 'The dry run is going; I will tell you what it finds.'
        }
      : undefined,
  )
  // Its runs: work as for real, a reply each (simulated), and a report.
  scripts.unshift((p) =>
    p.spec.playbook?.dryRun
      ? async (p) => {
          dryRunPrompts.push(p)
          await sleep(1500)
          const sent = await connector(p, gmail.id, 'gmail_send', {
            to: ['c@customer.test'],
            subject: 'Re: your question',
            body: `Hello, about "${p.text.match(/Subject: (.*)/)?.[1]}": here is how.`,
          })
          assert.ok(sent.ok, JSON.stringify(sent))
          assert.equal(sent.output.simulated, true)
          const r = await schedule(p, {
            name: 'playbook_report',
            case: 'documented_question',
            outcome: 'resolved',
            summary: 'Answered from the docs.',
          })
          assert.ok(r.ok, JSON.stringify(r))
          return 'Answered.'
        }
      : undefined,
  )
  const thread = await call('/threads', {
    body: {
      teammateId: sam.id,
      computerId: computer.id,
      text: 'Install the playbook “Support and bugs” (brigade/support-bugs).',
    },
  })
  installThread = thread.id ?? thread.thread?.id
  await until('the settings', () => said.started, 30_000)
  installationId = said.first.installationId
  assert.equal(said.first.status, 'setup')
  assert.equal(said.first.missing[0].key, 'inbox')
  assert.deepEqual(
    said.first.missing.map((m) => m.key),
    ['inbox', 'address', 'docs', 'repo'],
  )
  assert.equal(said.first.apps.find((a) => a.kind === 'github').status, 'missing')
  assert.match(said.first.next, /scope the playbook declares/)
  assert.equal(said.bad.ok, false)
  assert.match(said.bad.error, /web address/)
  assert.deepEqual(said.rest.missing, [])
  assert.equal(said.rest.apps.find((a) => a.kind === 'github').status, 'ready')
  const [row] = await q(`select settings from "PlaybookInstallation" where id = $1`, [
    installationId,
  ])
  assert.equal(row.settings.inbox, gmail.id)
  assert.equal(row.settings.address, 'support@acme.test')
  assert.equal(row.settings.repo, 'acme/web')
  assert.equal(row.settings.signature, 'The Acme team')
  // Made, and waiting: its schedule does not fire.
  const [s] = await q(`select "pausedAt" from "Schedule" where "playbookInstallationId" = $1`, [
    installationId,
  ])
  assert.ok(s.pausedAt)
})

await check('the dry run replays the mails its search matches, nothing sent', async () => {
  assert.equal(said.started.events, 4)
  await until('the four runs', () => dryRunPrompts.length >= 4, 60_000)
  const subjects = dryRunPrompts.map((p) => p.text.match(/Subject: (.*)/)?.[1]).sort()
  assert.deepEqual(subjects, ['Export broken', 'Login', 'Pricing', 'WordPress'])
  for (const p of dryRunPrompts) {
    assert.equal(p.spec.playbook.dryRun, true)
    assert.deepEqual(p.spec.connectors.map((c) => c.kind).sort(), ['github', 'gmail', 'stripe'])
  }
  const calls = await until(
    'their replies',
    () =>
      q(
        `select c.simulated, c.result, c.input from "ConnectionCall" c join "Session" s on s.id = c."sessionId"
         join "PlaybookRun" r on r.id = s."playbookRunId" where r."installationId" = $1 and c.operation = 'gmail_send'`,
        [installationId],
      ).then((rows) => rows.length === 4 && rows),
    30_000,
  )
  assert.ok(calls.every((c) => c.simulated && c.result === 'ok' && c.input.subject))
  // Its threads stay out of the sidebar.
  const listed = await call('/threads')
  assert.ok(!dryRunPrompts.some((p) => listed.some((t) => t.id === p.sessionId)))
})

await check('the thread is woken with the report: per event, cost and a week', async () => {
  const wake = await until(
    'the wake-up',
    () => promptsTo(installThread).find((p) => p.text.startsWith('The dry run of the playbook')),
    60_000,
  )
  assert.match(wake.text, /Nothing was sent/)
  const report = await schedule(wake, { name: 'dry_run_report', installationId })
  assert.ok(report.ok, JSON.stringify(report))
  const r = report.output
  assert.equal(r.status, 'done')
  assert.equal(r.events.length, 4)
  assert.equal(r.finished, 4)
  for (const e of r.events) {
    assert.equal(e.case, 'documented_question')
    assert.equal(e.summary, 'Answered from the docs.')
    assert.equal(e.writes.length, 1)
    assert.equal(e.writes[0].action, 'Reply to the customer')
    assert.ok(e.threadId)
    assert.ok(e.minutes > 0, `minutes ${e.minutes}`)
  }
  // Oldest first, the order they came in.
  assert.equal(r.events[0].title.includes('WordPress'), true, r.events[0].title)
  // Four mails over three days: three gaps of a day, so seven a week.
  assert.equal(r.week?.events, 7, JSON.stringify(r.week))
  assert.ok(r.week.minutes >= 0)
  const sheet = await call(`/playbooks/${installationId}`)
  assert.equal(sheet.status, 'dry_run')
  assert.equal(sheet.dryRun.id, r.id)
  // Dry runs do not count as its runs.
  assert.equal(sheet.runsThisWeek, 0)
})

await check('activate_playbook, then an owner’s Activate turns it on', async () => {
  const p = promptsTo(installThread).at(-1)
  const shown = await schedule(p, { name: 'activate_playbook', installationId })
  assert.ok(shown.ok, JSON.stringify(shown))
  assert.match(shown.output.next, /owner or admin: their click activates it/)
  assert.ok(
    shown.output.actions.every((a) =>
      a.label === 'Reply to the customer' ? a.level === 'ask' : true,
    ),
  )
  const { playbook: active, ticketId } = await call(`/playbooks/${installationId}/activate`, {
    body: { threadId: installThread },
  })
  assert.equal(ticketId, null)
  assert.equal(active.status, 'active')
  const [s] = await q(
    `select "pausedAt", "nextRunAt" from "Schedule" where "playbookInstallationId" = $1`,
    [installationId],
  )
  assert.equal(s.pausedAt, null)
  assert.ok(s.nextRunAt)
})

await check('a member asks an owner or admin in one ticket, which activates it', async () => {
  const carolIn = await fetch(`${API}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email: 'carol@example.com', password: 'correct-horse-battery' }),
  })
  assert.equal(carolIn.status, 200)
  const carol = carolIn.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
  {
    const r = await fetch(`${API}/api/auth/organization/set-active`, {
      method: 'POST',
      headers: { cookie: carol, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: computer.organizationId }),
    })
    assert.equal(r.status, 200, await r.text())
  }
  await call('/workspaces/switch', { body: { workspaceId: computer.workspaceId }, as: carol })
  const mine = await call('/playbooks', {
    as: carol,
    body: {
      playbookKey: 'brigade/support-bugs',
      teammateId: sam.id,
      settings: {
        product: 'Acme',
        inbox: gmail.id,
        address: 'support@acme.test',
        docs: 'https://docs.acme.test',
        repo: 'acme/web',
      },
    },
  })
  assert.equal(mine.status, 'setup')
  await assert.rejects(
    call(`/playbooks/${mine.id}`, { method: 'PATCH', body: { paused: false }, as: carol }),
    /Only an owner or admin/,
  )
  const first = await call(`/playbooks/${mine.id}/activate`, { body: {}, as: carol })
  const again = await call(`/playbooks/${mine.id}/activate`, { body: {}, as: carol })
  assert.ok(first.ticketId)
  assert.equal(again.ticketId, first.ticketId, 'one ticket')
  assert.equal(again.playbook.status, 'setup')
  assert.equal(again.playbook.activationTicketId, first.ticketId)
  // Carol cannot approve it herself; Ada, an owner, can.
  await assert.rejects(
    call(`/tickets/${first.ticketId}/resolve`, { body: { approved: true }, as: carol }),
    /Only an owner or admin/,
  )
  await call(`/tickets/${first.ticketId}/resolve`, { body: { approved: true } })
  const sheet = await call(`/playbooks/${mine.id}`)
  assert.equal(sheet.status, 'active')
  assert.equal(sheet.activationTicketId, null)
  await call(`/playbooks/${mine.id}`, { method: 'DELETE' })
})

await check('uninstalled, its dry run goes with it', async () => {
  await call(`/playbooks/${installationId}`, { method: 'DELETE' })
  assert.equal(
    (await q(`select id from "PlaybookDryRun" where "installationId" = $1`, [installationId]))
      .length,
    0,
  )
  await q(`delete from "Connection" where id = $1`, [github.id])
})

// =============================================================================
// Autonomy per action, grouped approvals, follow_thread
// =============================================================================

let live
const sends = {}
// A run's mail: it sorts the mail as `case`, then replies; what the reply call returned is kept.
const replying = (marker, cas) =>
  scripts.unshift((p) =>
    p.text.includes(marker)
      ? async (p) => {
          const t = await schedule(p, { name: 'playbook_triage', case: cas })
          assert.ok(t.ok, JSON.stringify(t))
          sends[marker] = await connector(p, gmail.id, 'gmail_send', {
            to: ['kim@customer.test'],
            subject: `Re: ${marker}`,
            body: 'Thanks for writing. Here is how.',
          })
          return 'Replied.'
        }
      : undefined,
  )
const mail = (marker) =>
  receive({
    id: `a${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    threadId: `ta-${marker.replace(/\W+/g, '-')}`,
    from: 'Kim <kim@customer.test>',
    to: 'support@acme.test',
    subject: marker,
    body: marker,
  })
const openApproval = (runMarker) =>
  until(
    `the approval for “${runMarker}”`,
    async () =>
      (
        await q(
          `select t.id, t.payload from "Ticket" t join "Session" s on s.id = t."sessionId"
           where t.status = 'open' and t.payload->>'playbookInstallationId' = $1 and s.title like $2`,
          [live.id, `%${runMarker}%`],
        )
      )[0],
    150_000,
  )

await check(
  'a reply asks first; its approval waits in the playbook’s group, decided in bulk',
  async () => {
    live = await call('/playbooks', {
      body: {
        playbookKey: 'brigade/support-bugs',
        teammateId: sam.id,
        settings: {
          product: 'Acme',
          inbox: gmail.id,
          address: 'support@acme.test',
          docs: 'https://docs.acme.test',
          repo: 'acme/web',
        },
      },
    })
    live = (await call(`/playbooks/${live.id}/activate`, { body: {} })).playbook
    assert.equal(live.actions.find((a) => a.key === 'reply').level, 'ask')
    // The mailbox's events held back by the earlier cap reach this playbook first: wait until a
    // fresh mail of its own has started a run, so the checks below see their runs in time.
    const warmUp = `Warm-up ${Date.now()}`
    mail(warmUp)
    await until(
      'the inbox to catch up',
      async () =>
        (await q(`select id from "Session" where title like $1`, [`%${warmUp}%`])).length > 0,
      900_000,
    )
    replying('Can I pay yearly?', 'documented_question')
    mail('Can I pay yearly?')
    const ticket = await openApproval('Can I pay yearly?')
    assert.equal(ticket.payload.playbookActionKey, 'reply')
    assert.ok(ticket.payload.playbookRunId)
    // One group for the playbook, listing the draft.
    const group = await call(`/playbooks/${live.id}/approvals`)
    const item = group.items.find((i) => i.ticketId === ticket.id)
    assert.ok(item, 'in the group')
    assert.equal(item.action.key, 'reply')
    assert.ok(item.canDecide)
    const listed = (await call('/tickets')).find((t) => t.id === ticket.id)
    assert.equal(listed?.playbook?.id, live.id)
    // Approved in bulk: it goes, and does not count toward letting it reply alone.
    const decided = await call(`/playbooks/${live.id}/approvals/decide`, {
      body: { ticketIds: [ticket.id], approve: true },
    })
    assert.deepEqual(decided.decided, [ticket.id])
    await until('the reply', () => sends['Can I pay yearly?'], 30_000)
    assert.ok(sends['Can I pay yearly?'].ok, JSON.stringify(sends['Can I pay yearly?']))
    const [after] = await q(`select payload from "Ticket" where id = $1`, [ticket.id])
    assert.equal(after.payload.decidedInBulk, true)
    const reply = (await call(`/playbooks/${live.id}`)).actions.find((a) => a.key === 'reply')
    assert.equal(reply.approved, 0, 'a bulk approval is not counted')
  },
)

await check(
  'on its own for documented questions: replies alone there, asks elsewhere; flagged, it asks again',
  async () => {
    const set = await call(`/playbooks/${live.id}/actions/reply`, {
      method: 'PATCH',
      body: { level: 'auto', conditions: { cases: ['documented_question'] } },
    })
    assert.equal(set.actions.find((a) => a.key === 'reply').level, 'auto')
    // A documented question: no ticket, the reply goes.
    replying('Where are your docs?', 'documented_question')
    mail('Where are your docs?')
    await until('the reply alone', () => sends['Where are your docs?'], 150_000)
    assert.ok(sends['Where are your docs?'].ok, JSON.stringify(sends['Where are your docs?']))
    const tickets = await q(
      `select t.id from "Ticket" t join "Session" s on s.id = t."sessionId"
       where s.title like '%Where are your docs?%' and t.payload->>'playbookInstallationId' = $1`,
      [live.id],
    )
    assert.equal(tickets.length, 0, 'nobody was asked')
    // Another case: it asks; denied, nothing is sent.
    replying('My account is locked', 'account_problem')
    mail('My account is locked')
    const ticket = await openApproval('My account is locked')
    await call(`/tickets/${ticket.id}/resolve`, { body: { approved: false } })
    await until('the denied reply', () => sends['My account is locked'], 30_000)
    assert.equal(sends['My account is locked'].ok, false)
    // The sheet lists what it did alone; marked as wrong, the reply asks again.
    const sheet = await call(`/playbooks/${live.id}`)
    const alone = sheet.autoCalls.find((c) => c.actionKey === 'reply')
    assert.ok(alone, 'listed under Done on its own')
    const flagged = await call(`/playbooks/${live.id}/calls/${alone.id}/flag`, { body: {} })
    const back = (flagged.actions ?? (await call(`/playbooks/${live.id}`)).actions).find(
      (a) => a.key === 'reply',
    )
    assert.equal(back.level, 'ask')
    assert.equal(back.demotedReason, 'flagged')
  },
)

await check('two runs wait on one fix: the second follows it and hears its report', async () => {
  const ids = {}
  scripts.unshift((p) =>
    p.text.includes('Export fails for us')
      ? async (p) => {
          await schedule(p, { name: 'playbook_triage', case: 'bug' })
          const r = await schedule(p, {
            name: 'start_child',
            title: 'Fix the CSV export',
            instructions: 'Fix the CSV export that fails with a 500 for every customer.',
            wait: false,
          })
          assert.ok(r.ok, JSON.stringify(r))
          ids.fix = r.output.threadId
          ids.first = p.sessionId
          return 'A fix is on its way.'
        }
      : undefined,
  )
  // The fix finishes only once the second run follows it.
  scripts.unshift((p) =>
    p.text.includes('Fix the CSV export that fails')
      ? async () => {
          await until('the follow', () => ids.followed, 150_000)
          return 'Fixed in acme/web#12: the export streams its rows now.'
        }
      : undefined,
  )
  scripts.unshift((p) =>
    p.text.includes('Export is broken here too')
      ? async (p) => {
          await schedule(p, { name: 'playbook_triage', case: 'bug' })
          const listed = await schedule(p, { name: 'list_children' })
          assert.ok(listed.ok, JSON.stringify(listed))
          ids.listed = listed.output.fromOtherRuns.some((c) => c.threadId === ids.fix)
          const f = await schedule(p, { name: 'follow_thread', threadId: ids.fix })
          assert.ok(f.ok, JSON.stringify(f))
          ids.second = p.sessionId
          ids.followed = true
          return 'Following the fix another conversation started.'
        }
      : undefined,
  )
  mail('Export fails for us')
  await until('the fix', () => ids.fix, 150_000)
  mail('Export is broken here too')
  await until('the follow', () => ids.followed, 150_000)
  assert.ok(ids.listed, 'list_children shows the other run’s fix')
  const woken = await until(
    'the follower woken by the report',
    () => promptsTo(ids.second).find((x) => x.text.includes('The thread you follow')),
    60_000,
  )
  assert.match(woken.text, /Fix the CSV export/)
  const view = await call(`/threads/${ids.fix}`)
  assert.ok(
    view.followers?.some((f) => f.id === ids.second),
    'shown as followed',
  )
  await call(`/playbooks/${live.id}`, { method: 'DELETE' })
})

console.log(results.join('\n'))
clearInterval(heartbeat)
ws.close()
await db.end()
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
