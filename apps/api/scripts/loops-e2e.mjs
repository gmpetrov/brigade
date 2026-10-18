// End-to-end check of playbooks (src/loops.ts) against the real API and database: the
// support-bugs playbook installed through the API receives a mail through its Gmail trigger
// (a fake Gmail in the API's process, scripts/fake-gmail.mjs), starts a run out of the
// sidebar with only the tools of the Apps it declares, and shows in its sheet. A scripted
// runner on the real runner socket stands in for the teammate. It needs the preview's sample
// workspace (scripts/preview/setup.sh) and an API on its database, with nothing else
// connected as the cloud computer's runner (it takes that runner's place):
//
//   cd apps/api && FAKE_GMAIL=/tmp/fake-gmail.json PORT=3101 API_URL=http://localhost:3101 \
//     WEB_URL=http://localhost:3102 node --env-file=.env --import tsx --import ./scripts/fake-gmail.mjs src/index.ts
//   node apps/api/scripts/loops-e2e.mjs "$PWD" http://localhost:3101 /tmp/fake-gmail.json
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

// --- Sign in as Ada (an owner: her installation is active at once) -----------
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
async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}/api${path}`, {
    method: body && method === 'GET' ? 'POST' : method,
    headers: { cookie, origin, ...(body ? { 'content-type': 'application/json' } : {}) },
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
  for (const old of await call('/loops')) await call(`/loops/${old.id}`, { method: 'DELETE' })
  playbook = await call('/loops', {
    body: {
      loopKey: 'brigade/support-bugs',
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
  assert.equal(playbook.status, 'active')
  assert.equal(playbook.name, 'Support and bugs')
  assert.equal(playbook.actions.length, 5)
  assert.deepEqual(
    playbook.entries.map((e) => e.kind),
    ['trigger', 'schedule'],
  )
  const [trigger] = await q(`select options from "Trigger" where "loopInstallationId" = $1`, [
    playbook.id,
  ])
  assert.deepEqual(trigger.options, { query: 'to:support@acme.test' })
  const skills = await q(
    `select s.name from "Skill" s join "SkillPack" p on p.id = s."packId" where p."loopInstallationId" = $1 order by s.name`,
    [playbook.id],
  )
  assert.deepEqual(
    skills.map((s) => s.name),
    ['bug-fix', 'support-triage'],
  )
  // A playbook's schedule and trigger are changed through it only.
  const [s] = await q(`select id from "Schedule" where "loopInstallationId" = $1`, [playbook.id])
  await assert.rejects(call(`/schedules/${s.id}`, { method: 'DELETE' }), /belongs to a playbook/)
  // And they show in the playbook, not in the lists of schedules and triggers.
  assert.ok(!(await call('/schedules')).some((x) => x.id === s.id))
  assert.ok(!(await call('/triggers')).some((x) => x.loopInstallationId))
})

let runThread
await check('a mail to the support address starts a run out of the sidebar', async () => {
  scripts.push((p) =>
    p.text.includes('Hello, how do I connect WordPress?')
      ? async (p) => {
          const r = await schedule(p, {
            name: 'loop_report',
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
    `select s.origin, s."loopRunId", s."surfacedAt", r."installationId", r."rootSessionId", r."conversationKey"
     from "Session" s join "LoopRun" r on r.id = s."loopRunId" where s.id = $1`,
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
  assert.equal(spec.loop?.installationId, playbook.id)
  const skills = spec.skills.map((s) => s.name)
  assert.ok(skills.includes('support-triage') && skills.includes('bug-fix'), skills.join())
  // Elsewhere, Sam keeps every App and gets none of the playbook's skills.
  const other = await call('/threads', {
    body: { teammateId: sam.id, computerId: computer.id, text: 'An ordinary thread' },
  })
  const otherId = other.id ?? other.thread?.id
  const plain = (await until('the ordinary thread', () => promptsTo(otherId)[0])).spec
  assert.ok(plain.connectors.some((c) => c.kind === 'google_calendar'))
  assert.equal(plain.loop ?? null, null)
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

await check('loop_report records the case and outcome, shown in the sheet', async () => {
  await until('the report', async () => {
    const [r] = await q(
      `select "case", outcome, status from "LoopRun" where "rootSessionId" = $1`,
      [runThread],
    )
    return r?.outcome === 'resolved' && r
  })
  const sheet = await call(`/loops/${playbook.id}`)
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
  const runs = await q(`select status from "LoopRun" where "installationId" = $1`, [playbook.id])
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
  const [child] = await q(`select "loopRunId" from "Session" where id = $1`, [childId])
  const [root] = await q(`select "loopRunId", "surfacedAt" from "Session" where id = $1`, [
    runThread,
  ])
  assert.equal(child.loopRunId, root.loopRunId)
  const childSpec = (await until('the child prompt', () => promptsTo(childId)[0])).spec
  assert.deepEqual(childSpec.connectors.map((c) => c.kind).sort(), ['gmail', 'stripe'])
  assert.ok(root.surfacedAt, 'surfaced')
  assert.ok(
    (await call('/threads')).some((t) => t.id === runThread),
    'now in the sidebar',
  )
  const [run] = await q(`select interventions from "LoopRun" where id = $1`, [root.loopRunId])
  assert.equal(run.interventions, 1)
})

await check('past its runs a day, the event waits and the owner gets a ticket', async () => {
  await q(
    `update "LoopInstallation" set manifest = jsonb_set(manifest, '{limits,runsPerDay}', '2') where id = $1`,
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
      const runs = await q(`select id from "LoopRun" where "installationId" = $1`, [playbook.id])
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
        `select title, payload from "Ticket" where status = 'open' and payload->>'loopInstallationId' = $1`,
        [playbook.id],
      ).then((rows) => rows.length && rows),
    150_000,
  )
  assert.match(ticket.title, /reached its 2 runs a day/)
  const runs = await q(`select id from "LoopRun" where "installationId" = $1`, [playbook.id])
  assert.equal(runs.length, 2)
})

await check('pausing stops its schedule; uninstalling removes all it made', async () => {
  const paused = await call(`/loops/${playbook.id}`, { method: 'PATCH', body: { paused: true } })
  assert.equal(paused.status, 'paused')
  const [s] = await q(`select "pausedAt" from "Schedule" where "loopInstallationId" = $1`, [
    playbook.id,
  ])
  assert.ok(s.pausedAt)
  const [unsurfaced] = await q(
    `select s.id from "Session" s join "LoopRun" r on r.id = s."loopRunId" where r."installationId" = $1 and s."surfacedAt" is null and s."parentId" is null`,
    [playbook.id],
  )
  await call(`/loops/${playbook.id}`, { method: 'DELETE' })
  for (const table of ['Trigger', 'Schedule', 'SkillPack'])
    assert.equal(
      (await q(`select id from "${table}" where "loopInstallationId" = $1`, [playbook.id])).length,
      0,
      table,
    )
  const [archived] = await q(`select "archivedAt" from "Session" where id = $1`, [unsurfaced.id])
  assert.ok(archived.archivedAt, 'its unsurfaced run is archived')
  const [kept] = await q(`select "archivedAt" from "Session" where id = $1`, [runThread])
  assert.equal(kept.archivedAt, null, 'the run a person joined stays')
})

console.log(results.join('\n'))
clearInterval(heartbeat)
ws.close()
await db.end()
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
