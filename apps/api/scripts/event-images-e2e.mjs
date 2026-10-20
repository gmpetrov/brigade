// End-to-end check of images kept apart from events (src/event-images.ts) against the
// real API and database, with a scripted runner on the real runner socket: its turn
// returns a screenshot the way Claude Code's Read tool, the harness's own copy and a
// browser tool do. It checks the stored events name the images instead of holding
// them, the bucket has each once, the thread serves them, and deleting the thread
// deletes them. It needs the preview's sample workspace (scripts/preview/setup.sh) and
// an API on its database without R2 (the bucket is then apps/api/.bucket), with
// nothing else connected as the cloud computer's runner (it takes that runner's place):
//
//   cd apps/api && PORT=3101 API_URL=http://localhost:3101 WEB_URL=http://localhost:3102 pnpm dev
//   node apps/api/scripts/event-images-e2e.mjs "$PWD" http://localhost:3101
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { deflateSync } from 'node:zlib'
import assert from 'node:assert/strict'

const [repo, API] = process.argv.slice(2)
const require = createRequire(`${repo}/apps/api/package.json`)
const WebSocket = createRequire(`${repo}/apps/runner/package.json`)('ws')
const pg = require('pg')
const env = Object.fromEntries(
  readFileSync(`${repo}/apps/api/.env`, 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]),
)
assert.ok(!env.R2_BUCKET, 'run it on an API without R2: it reads the bucket from apps/api/.bucket')
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

// --- A real PNG of random pixels: it does not compress, so it is as big as a screenshot's start.
function png(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc(body), body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8) // 8-bit RGB
  const rows = Buffer.concat(
    Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), randomBytes(width * 3)])),
  )
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const read = png(64, 64)
const captured = png(48, 48)
const nameOf = (bytes) => `${createHash('sha256').update(bytes).digest('hex')}.png`

// --- Sign in as Ada ---------------------------------------------------------
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
const [riley] = await q(
  `select t.id from "Teammate" t where t."workspaceId" = $1 and t."archivedAt" is null and t.kind <> 'chief' order by t."createdAt" limit 1`,
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
send({ type: 'hello', protocolVersion: 28, version: 'e2e', platform: 'linux' })
// Without heartbeats the API forgets the runner after 90 s.
const beat = setInterval(() => send({ type: 'heartbeat' }), 20_000)

const seqs = new Map()
function emit(sessionId, events) {
  send({
    type: 'events',
    events: events.map((event) => {
      const seq = (seqs.get(sessionId) ?? 0) + 1
      seqs.set(sessionId, seq)
      return { sessionId, seq, event: { at: new Date().toISOString(), ...event } }
    }),
  })
}

ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.type !== 'thread.prompt') return
  const sessionId = m.thread.sessionId
  const t = m.thread.teammate.id
  const data = read.toString('base64')
  emit(sessionId, [
    { type: 'message.user', text: m.text, memberId: m.memberId ?? null },
    { type: 'turn.started', teammateId: t, accountId: 'x', turnId: randomUUID() },
    // Claude Code's Read of a PNG, as production stores it.
    {
      type: 'tool.started',
      teammateId: t,
      toolCallId: 'c1',
      toolName: 'read',
      input: { file_path: 'shot.png' },
    },
    {
      type: 'tool.finished',
      teammateId: t,
      toolCallId: 'c1',
      toolName: 'read',
      isError: false,
      output: {
        type: 'image',
        file: { type: 'image/png', base64: data, originalSize: read.length, dimensions: {} },
      },
    },
    // The harness's own copy of the same result.
    {
      type: 'raw',
      teammateId: t,
      source: 'harness',
      value: {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'c1',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
              ],
            },
          ],
        },
      },
    },
    // A browser tool's screenshot.
    {
      type: 'tool.started',
      teammateId: t,
      toolCallId: 'c2',
      toolName: 'mcp__browser__browser_take_screenshot',
      input: {},
    },
    {
      type: 'tool.finished',
      teammateId: t,
      toolCallId: 'c2',
      toolName: 'mcp__browser__browser_take_screenshot',
      isError: false,
      output: [
        { type: 'text', text: 'Took the screenshot.' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: captured.toString('base64') },
        },
      ],
    },
    { type: 'message.done', id: randomUUID(), text: 'Here is what I saw.', teammateId: t },
    { type: 'turn.completed', finishReason: 'stop', teammateId: t },
  ])
})

let failed = false
const check = async (what, fn) => {
  try {
    await fn()
    console.log(`ok - ${what}`)
  } catch (error) {
    failed = true
    console.log(`not ok - ${what}\n  ${error.message}`)
  }
}

const thread = await call('/threads', {
  body: { teammateId: riley.id, computerId: computer.id, text: 'Take a screenshot' },
})
const threadId = thread.id ?? thread.thread?.id
assert.ok(threadId, JSON.stringify(thread))
await until('the turn stored', async () => {
  const [s] = await q(`select "lastSeq", status from "Session" where id = $1`, [threadId])
  return s.lastSeq >= 9 && s.status !== 'running' && s.status !== 'starting'
})

const folder = `${repo}/apps/api/.bucket/${computer.organizationId}/${computer.workspaceId}/thread-images/${threadId}`
const stored = await q(
  `select seq, type, data from "SessionEvent" where "sessionId" = $1 order by seq`,
  [threadId],
)
const text = JSON.stringify(stored.map((r) => r.data))

await check('no event holds an image any more', () => {
  assert.ok(!text.includes(read.toString('base64').slice(0, 200)))
  assert.ok(!text.includes(captured.toString('base64').slice(0, 200)))
})
await check("the Read result, the harness's copy and the screenshot name their images", () => {
  const readResult = stored.find((r) => r.data.toolCallId === 'c1' && r.type === 'tool.finished')
  assert.equal(readResult.data.output.file.base64, `brigade-image:${nameOf(read)}`)
  assert.equal(readResult.data.output.file.type, 'image/png')
  const copy = stored.find((r) => r.type === 'raw')
  assert.equal(
    copy.data.value.message.content[0].content[0].source.data,
    `brigade-image:${nameOf(read)}`,
  )
  const shot = stored.find((r) => r.data.toolCallId === 'c2' && r.type === 'tool.finished')
  assert.equal(shot.data.output[1].source.data, `brigade-image:${nameOf(captured)}`)
  assert.equal(shot.data.output[0].text, 'Took the screenshot.')
})
await check('the bucket has each image once, byte for byte', () => {
  assert.deepEqual(readdirSync(folder).sort(), [nameOf(read), nameOf(captured)].sort())
  assert.deepEqual(readFileSync(`${folder}/${nameOf(read)}`), read)
})
await check('the page of the thread gets the names, not the images', async () => {
  const page = await call(`/threads/${threadId}/events`)
  const json = JSON.stringify(page)
  assert.ok(json.includes(`brigade-image:${nameOf(read)}`))
  assert.ok(!json.includes(read.toString('base64').slice(0, 200)))
})
await check('the thread serves its images to a member who sees it', async () => {
  const res = await fetch(`${API}/api/threads/${threadId}/images/${nameOf(captured)}`, {
    headers: { cookie, origin },
  })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), captured)
})
await check('a name that is not a stored image is refused; a missing one is 404', async () => {
  const bad = await fetch(`${API}/api/threads/${threadId}/images/..%2F..%2Fsecret.png`, {
    headers: { cookie, origin },
  })
  assert.ok([400, 404].includes(bad.status), String(bad.status))
  const missing = await fetch(`${API}/api/threads/${threadId}/images/${'0'.repeat(64)}.png`, {
    headers: { cookie, origin },
  })
  assert.equal(missing.status, 404)
})
await check('without a session, nothing is served', async () => {
  const res = await fetch(`${API}/api/threads/${threadId}/images/${nameOf(read)}`)
  assert.ok([401, 403].includes(res.status), String(res.status))
})
await check('deleting the thread deletes its images', async () => {
  await call(`/threads/${threadId}`, { method: 'DELETE' })
  assert.ok(!existsSync(folder) || readdirSync(folder).length === 0)
})

clearInterval(beat)
ws.close()
await db.end()
process.exit(failed ? 1 : 0)
