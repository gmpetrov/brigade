// End-to-end check of child threads (src/children.ts) against the real API and
// database, with a scripted runner on the real runner socket: it answers each
// prompt with the events a runner sends and calls the child tools as a teammate
// would. It needs the preview's sample workspace (scripts/preview/setup.sh) and
// an API on its database, with nothing else connected as the cloud computer's
// runner (it takes that runner's place):
//
//   cd apps/api && PORT=3101 API_URL=http://localhost:3101 WEB_URL=http://localhost:3102 pnpm dev
//   node apps/api/scripts/children-e2e.mjs "$PWD" http://localhost:3101
//
// It takes about three minutes (one case waits for a child's wait to run out).
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const [repo, API] = process.argv.slice(2)
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
    await sleep(200)
  }
}

// --- Sign in as Ada ---------------------------------------------------------
const origin = 'http://localhost:3102'
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
const [riley] = await q(
  `select t.id, t.name from "Teammate" t where t."workspaceId" = $1 and t."archivedAt" is null and t.kind <> 'chief' order by t."createdAt" limit 1`,
  [computer.workspaceId],
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

// --- The scripted runner -----------------------------------------------------
const ws = new WebSocket(`${API.replace('http', 'ws')}/runner/ws`, {
  headers: { authorization: `Bearer ${token}` },
})
await new Promise((resolve, reject) => {
  ws.once('open', resolve)
  ws.once('error', reject)
})
const send = (m) => ws.send(JSON.stringify(m))
send({ type: 'hello', protocolVersion: 27, version: 'e2e', platform: 'linux' })

const prompts = [] // every thread.prompt: { sessionId, text, title, parent }
const seqs = new Map()
const busy = new Map() // sessionId -> promise chain: one turn at a time, as the runner does
const pendingCalls = new Map()
const scripts = [] // (prompt) => async (turn) | undefined

ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.type === 'connector.result') {
    pendingCalls.get(m.callId)?.(m)
    pendingCalls.delete(m.callId)
  } else if (m.type === 'thread.prompt') {
    const p = {
      sessionId: m.thread.sessionId,
      text: m.text,
      parent: m.thread.parent ?? null,
      teammateId: m.thread.teammate.id,
      memberId: m.memberId,
    }
    prompts.push(p)
    const chain = (busy.get(p.sessionId) ?? Promise.resolve()).then(() => turn(p))
    busy.set(
      p.sessionId,
      chain.catch((e) => console.error('turn failed', e)),
    )
  } else if (m.type === 'thread.interrupt') {
    prompts.push({ sessionId: m.sessionId, interrupt: true })
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

function op(kind, sessionId, teammateId, operation) {
  const callId = randomUUID()
  return new Promise((resolve) => {
    pendingCalls.set(callId, resolve)
    send({ type: kind, callId, sessionId, teammateId, operation })
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

const schedule = (p, operation) => op('schedule.call', p.sessionId, p.teammateId, operation)
const task = (p, operation) => op('task.call', p.sessionId, p.teammateId, operation)
const promptsTo = (id) => prompts.filter((x) => x.sessionId === id && !x.interrupt)

const results = []
const RUN = Date.now().toString(36)
async function check(name, fn) {
  try {
    await fn()
    results.push(`PASS ${name}`)
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`)
  }
}

// =============================================================================
// 1. A parent starts two awaited children; one reports, one only answers.
//    The parent is woken once, with both.
// =============================================================================
let parentId
const children = {}
await check('two awaited children wake the parent once, with both reports', async () => {
  scripts.push((p) =>
    p.text.startsWith('PARENT delegate')
      ? async (p) => {
          for (const name of ['Alpha', 'Beta']) {
            const r = await schedule(p, {
              name: 'start_child',
              title: `Child ${name}`,
              instructions: `Do ${name}`,
              wait: true,
            })
            assert.ok(r.ok, JSON.stringify(r))
            children[name] = r.output.threadId
          }
          return 'Started both.'
        }
      : undefined,
  )
  scripts.push((p) =>
    p.parent && p.text.includes('Do Alpha')
      ? async (p) => {
          await sleep(300)
          const r = await schedule(p, {
            name: 'report',
            status: 'report',
            summary: 'Alpha found the regression in canary.34',
          })
          assert.ok(r.ok, JSON.stringify(r))
          return 'Done with Alpha.'
        }
      : undefined,
  )
  scripts.push((p) =>
    p.parent && p.text.includes('Do Beta')
      ? async () => {
          await sleep(1500)
          return 'Beta: PR #99550 is still open.'
        }
      : undefined,
  )
  const thread = await call('/threads', {
    body: { teammateId: riley.id, computerId: computer.id, text: 'PARENT delegate the work' },
  })
  parentId = thread.id ?? thread.thread?.id
  assert.ok(parentId, JSON.stringify(thread))
  await until('both children', () => children.Alpha && children.Beta)
  await until('a wake-up in the parent', () => promptsTo(parentId).length >= 2, 30_000)
  await sleep(2000)
  const wakes = promptsTo(parentId).slice(1)
  assert.equal(wakes.length, 1, `parent prompted ${wakes.length} times after its first turn`)
  const note = wakes[0].text
  assert.match(note, /2 child threads you were waiting for have finished/)
  assert.match(note, /Alpha found the regression in canary\.34/)
  assert.match(note, /Beta: PR #99550 is still open\./)
  // The children: parent, origin, inherited access, reports delivered.
  const rows = await q(
    `select id, origin, "parentId", "parentTeammateId", awaited, report, "reportDeliveredAt", "startedByMemberId" from "Session" where "parentId" = $1`,
    [parentId],
  )
  assert.equal(rows.length, 2)
  for (const r of rows) {
    assert.equal(r.origin, 'child')
    assert.ok(r.reportDeliveredAt, 'delivered')
  }
  const beta = rows.find((r) => r.id === children.Beta)
  assert.equal(beta.report.fromLastMessage, true)
  // The child got its parent in its spec, so it has the report tool.
  const childPrompt = promptsTo(children.Alpha)[0]
  assert.equal(childPrompt.parent?.id, parentId)
  assert.match(childPrompt.text, /started this thread from the thread/)
})

// =============================================================================
// 2. Lists: children are out of the thread list; the parent shows them.
// =============================================================================
await check('children stay out of the thread list and show in their parent', async () => {
  const list = await call('/threads')
  assert.ok(
    list.some((t) => t.id === parentId),
    'parent listed',
  )
  assert.ok(
    !list.some((t) => t.id === children.Alpha || t.id === children.Beta),
    'children not listed',
  )
  const parent = await call(`/threads/${parentId}`)
  assert.equal(parent.children.length, 2)
  assert.equal(parent.children.find((c) => c.id === children.Alpha).report.status, 'report')
  const child = await call(`/threads/${children.Alpha}`)
  assert.equal(child.parent.id, parentId)
})

// =============================================================================
// 3. message_thread to a child: it carries on, and the parent hears back.
// =============================================================================
await check('message_thread to a child: it carries on and wakes the parent again', async () => {
  const before = promptsTo(parentId).length
  scripts.unshift((p) =>
    p.sessionId === children.Beta && p.text.includes('Check again')
      ? async (p) => {
          await schedule(p, {
            name: 'report',
            status: 'report',
            summary: 'Beta checked again: merged',
          })
          return 'checked'
        }
      : undefined,
  )
  const parentTurn = promptsTo(parentId).at(-1)
  const r = await task(parentTurn, {
    name: 'comment',
    threadId: children.Beta,
    text: 'Check again please',
  })
  assert.ok(r.ok, JSON.stringify(r))
  await until('the parent woken again', () => promptsTo(parentId).length > before, 20_000)
  const note = promptsTo(parentId).at(-1).text
  assert.match(note, /The child thread you were waiting for has finished/)
  assert.match(note, /Beta checked again: merged/)
  // A thread that is not its child is refused.
  const other = await task(parentTurn, { name: 'comment', threadId: parentId, text: 'x' })
  assert.equal(other.ok, false)
})

// =============================================================================
// 4. cancel_child: the parent stops waiting for it; the other still counts.
// =============================================================================
await check(
  'cancel_child: the others still wake the parent, without the cancelled one',
  async () => {
    const before = promptsTo(parentId).length
    const p = promptsTo(parentId).at(-1)
    scripts.unshift((x) =>
      x.parent && x.text.includes('Do Gamma')
        ? async () => {
            await sleep(60_000)
            return 'late'
          }
        : undefined,
    )
    scripts.unshift((x) =>
      x.parent && x.text.includes('Do Delta')
        ? async (x) => {
            await sleep(1500)
            await schedule(x, { name: 'report', status: 'report', summary: 'Delta done' })
            return 'delta'
          }
        : undefined,
    )
    const gamma = await schedule(p, {
      name: 'start_child',
      title: 'Child Gamma',
      instructions: 'Do Gamma',
      wait: true,
    })
    const delta = await schedule(p, {
      name: 'start_child',
      title: 'Child Delta',
      instructions: 'Do Delta',
      wait: true,
    })
    assert.ok(gamma.ok && delta.ok)
    await sleep(500)
    const cancelled = await schedule(p, { name: 'cancel_child', threadId: gamma.output.threadId })
    assert.ok(cancelled.ok, JSON.stringify(cancelled))
    await until('interrupt sent to Gamma', () =>
      prompts.some((x) => x.interrupt && x.sessionId === gamma.output.threadId),
    )
    await until('the parent woken', () => promptsTo(parentId).length > before, 20_000)
    const note = promptsTo(parentId).at(-1).text
    assert.match(note, /Delta done/)
    assert.doesNotMatch(note, /Gamma/)
    // The list says so.
    const list = await schedule(p, { name: 'list_children' })
    assert.equal(
      list.output.children.find((c) => c.threadId === gamma.output.threadId).report.status,
      'cancelled',
    )
  },
)

// =============================================================================
// 5. A child cannot start children, and report is refused outside a child.
// =============================================================================
await check('no grandchildren; report only in a child', async () => {
  const childTurn = promptsTo(children.Alpha)[0]
  const r = await schedule(childTurn, { name: 'start_child', title: 'x', instructions: 'y' })
  assert.equal(r.ok, false)
  assert.match(r.error, /child thread/)
  const parentTurn = promptsTo(parentId)[0]
  const s = await schedule(parentTurn, { name: 'report', status: 'report', summary: 'x' })
  assert.equal(s.ok, false)
})

// =============================================================================
// 6. A schedule made in the thread: a run with nothing new wakes nobody; a run
//    with something wakes the parent with its note.
// =============================================================================
await check(
  'schedule runs report to their thread: nothing wakes nobody, report wakes it',
  async () => {
    const parentTurn = promptsTo(parentId)[0]
    const created = await schedule(parentTurn, {
      name: 'create',
      title: `Watch the fix ${RUN}`,
      instructions: 'Check whether the PR is merged',
      cron: '0 9 * * 1',
      timezone: 'Europe/Paris',
    })
    assert.ok(created.ok, JSON.stringify(created))
    const [row] = await q(`select id, "parentSessionId" from "Schedule" where id = $1`, [
      created.output.scheduleId,
    ])
    assert.equal(row.parentSessionId, parentId)
    let answer = 'nothing'
    scripts.unshift((x) =>
      x.text.startsWith(`Scheduled run of "Watch the fix ${RUN}"`)
        ? async (x) => {
            assert.equal(x.parent?.id, parentId)
            await schedule(x, {
              name: 'report',
              status: answer,
              summary: answer === 'nothing' ? 'Not merged yet' : 'Merged in 16.4.3',
            })
            return 'run done'
          }
        : undefined,
    )
    const before = promptsTo(parentId).length
    const run1 = await call(`/schedules/${row.id}/run`, { method: 'POST', body: {} })
    await until('first run done', async () => {
      const [r] = await q(`select "reportDeliveredAt" from "Session" where id = $1`, [
        run1.threadId,
      ])
      return r?.reportDeliveredAt
    })
    await sleep(1500)
    assert.equal(promptsTo(parentId).length, before, 'a quiet run woke the parent')
    answer = 'report'
    const run2 = await call(`/schedules/${row.id}/run`, { method: 'POST', body: {} })
    await until(
      'the parent woken by the second run',
      () => promptsTo(parentId).length > before,
      20_000,
    )
    const note = promptsTo(parentId).at(-1).text
    assert.match(note, new RegExp(`A run of your schedule “Watch the fix ${RUN}”`))
    assert.match(note, /Merged in 16\.4\.3/)
    const [r2] = await q(`select origin, "parentId", awaited from "Session" where id = $1`, [
      run2.threadId,
    ])
    assert.deepEqual(r2, { origin: 'schedule', parentId, awaited: false })
  },
)

// =============================================================================
// 7. The wait runs out: the parent hears what is done and what is not.
// =============================================================================
await check('a wait that runs out wakes the parent with what is unfinished', async () => {
  const p = promptsTo(parentId)[0]
  scripts.unshift((x) =>
    x.parent && x.text.includes('Do Slow')
      ? async () => {
          await sleep(150_000)
          return 'slow'
        }
      : undefined,
  )
  const before = promptsTo(parentId).length
  const slow = await schedule(p, {
    name: 'start_child',
    title: 'Child Slow',
    instructions: 'Do Slow',
    wait: true,
    timeoutMinutes: 1,
  })
  assert.ok(slow.ok)
  await until('the parent woken after the wait', () => promptsTo(parentId).length > before, 150_000)
  const note = promptsTo(parentId).at(-1).text
  assert.match(note, /none has finished yet/)
  assert.match(note, /Child Slow/)
  const [row] = await q(`select awaited from "Session" where id = $1`, [slow.output.threadId])
  assert.equal(row.awaited, false)
})

// =============================================================================
// 7b. Two children finishing at the same instant wake the parent once; an
//     error ends a child as failed.
// =============================================================================
await check('the wake-up guard stops new children until a person writes', async () => {
  const p = promptsTo(parentId)[0]
  const refused = await schedule(p, { name: 'start_child', title: 'Too many', instructions: 'x' })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /times in a row/)
  await call(`/threads/${parentId}/messages`, { body: { text: 'Carry on' } })
  await until(
    'the person message stored',
    async () =>
      (
        await q(
          `select 1 from "SessionEvent" where "sessionId" = $1 and type = 'message.user' and data->>'memberId' is not null`,
          [parentId],
        )
      ).length,
  )
})

await check(
  'children finishing at once wake the parent once; an error is a failed report',
  async () => {
    const p = promptsTo(parentId)[0]
    let release
    const gate = new Promise((r) => (release = r))
    scripts.unshift((x) =>
      x.parent && /Do Twin/.test(x.text)
        ? async (x) => {
            await gate
            await schedule(x, {
              name: 'report',
              status: 'report',
              summary: `${x.text.match(/Do (Twin\w)/)[1]} done`,
            })
            return 'twin'
          }
        : undefined,
    )
    const before = promptsTo(parentId).length
    const a = await schedule(p, {
      name: 'start_child',
      title: 'Twin A',
      instructions: 'Do TwinA',
      wait: true,
    })
    const b = await schedule(p, {
      name: 'start_child',
      title: 'Twin B',
      instructions: 'Do TwinB',
      wait: true,
    })
    assert.ok(a.ok && b.ok)
    await until(
      'both twins prompted',
      () => promptsTo(a.output.threadId).length && promptsTo(b.output.threadId).length,
    )
    release()
    await until('the parent woken', () => promptsTo(parentId).length > before, 20_000)
    await sleep(2500)
    assert.equal(promptsTo(parentId).length, before + 1, 'woken more than once')
    const note = promptsTo(parentId).at(-1).text
    assert.match(note, /TwinA done/)
    assert.match(note, /TwinB done/)

    // An error event: a failed report, sent on.
    scripts.unshift((x) =>
      x.parent && x.text.includes('Do Broken') ? () => new Promise(() => {}) : undefined,
    )
    const before2 = promptsTo(parentId).length
    const c = await schedule(p, {
      name: 'start_child',
      title: 'Broken',
      instructions: 'Do Broken',
      wait: true,
    })
    await until('Broken prompted', () => promptsTo(c.output.threadId).length)
    await sleep(300)
    emit(c.output.threadId, [{ type: 'error', message: 'The computer stopped answering.' }])
    await until(
      'the parent woken by the failure',
      () => promptsTo(parentId).length > before2,
      20_000,
    )
    assert.match(
      promptsTo(parentId).at(-1).text,
      /Broken.*failed\. The computer stopped answering\./,
    )
  },
)

// =============================================================================
// 8. Deleting the parent deletes its children and pauses its schedule.
// =============================================================================
await check('deleting the parent takes its children and pauses its schedule', async () => {
  // Wait for everything to be idle (the slow child finishes at its own pace: interrupt it).
  await q(`update "Session" set status = 'idle' where "parentId" = $1 or id = $1`, [parentId])
  await call(`/threads/${parentId}`, { method: 'DELETE' })
  const left = await q(`select id from "Session" where "parentId" = $1 or id = $1`, [parentId])
  assert.equal(left.length, 0)
  const [s] = await q(`select "pausedAt", "parentSessionId" from "Schedule" where title = $1`, [
    `Watch the fix ${RUN}`,
  ])
  assert.ok(s.pausedAt)
  assert.equal(s.parentSessionId, null)
  const tickets = await q(`select title from "Ticket" where title like $1`, [
    `Schedule "Watch the fix ${RUN}" is paused%`,
  ])
  assert.equal(tickets.length, 1)
})

console.log(results.join('\n'))
ws.close()
await db.end()
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
