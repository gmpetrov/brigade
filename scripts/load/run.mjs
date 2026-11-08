#!/usr/bin/env node
// Load scenarios against the load test copy of the API (README.md). Needs `ws` (npm i ws).
//   node run.mjs <scenario> --api <url> --workspaces <seed.json> [options]
// Scenarios:
//   http      dashboard reads, open loop, in steps of requests per second (--steps 25,50,100)
//   sockets   a runner and dashboards per workspace; runners stream events, dashboards time them
//             (--seconds, --events per runner per second). --storm-at <s>: every socket drops then,
//             and comes back after --reconnect fixed|spread, as after a deploy.
//   files     a large library file through a direct upload, its check and its ranges; many
//             downloads at once; runner bundle downloads, while dashboard reads go on
//   signups   sign-ups through the API, then a workspace each, at the rate one address may
// Prints one JSON report per scenario on stdout; progress on stderr.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import WebSocket from 'ws'

const args = process.argv.slice(2)
const scenario = args[0]
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i > 0 ? args[i + 1] : fallback
}
const API = opt('api')
const seed = JSON.parse(readFileSync(opt('workspaces', 'workspaces.json'), 'utf8'))
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------------------------
// Measures

class Stats {
  constructor() {
    this.ms = []
    this.status = {}
    this.errors = {}
  }
  add(ms, status) {
    this.ms.push(ms)
    this.status[status] = (this.status[status] ?? 0) + 1
  }
  fail(error) {
    const key = String(error?.cause?.code ?? error?.code ?? error?.message ?? error).slice(0, 80)
    this.errors[key] = (this.errors[key] ?? 0) + 1
  }
  summary() {
    const s = [...this.ms].sort((a, b) => a - b)
    const p = (q) =>
      s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]) : null
    const total = s.length + Object.values(this.errors).reduce((a, b) => a + b, 0)
    const bad = Object.entries(this.status)
      .filter(([k]) => Number(k) >= 500 || k === '429')
      .reduce((a, [, v]) => a + v, 0)
    return {
      requests: total,
      p50: p(0.5),
      p95: p(0.95),
      p99: p(0.99),
      max: s.at(-1) ?? null,
      status: this.status,
      errors: this.errors,
      failedPct: total ? Math.round(((bad + total - s.length) / total) * 1000) / 10 : 0,
    }
  }
}

const members = seed.workspaces.flatMap((w) => w.members.map((m) => ({ ...m, workspace: w })))
const pick = (list) => list[Math.floor(Math.random() * list.length)]

async function timed(stats, url, init) {
  const start = performance.now()
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) })
    await response.arrayBuffer()
    stats.add(performance.now() - start, response.status)
    return response
  } catch (error) {
    stats.fail(error)
    return null
  }
}

/** What a dashboard asks for, as its pages do (apps/web/lib/demo/fixtures.json), weighted. */
function dashboardRead(member) {
  const thread = pick(member.workspace.threads)
  const reads = [
    '/api/threads',
    '/api/threads',
    '/api/inbox',
    '/api/home',
    '/api/me',
    '/api/projects',
    '/api/teammates',
    `/api/threads/${thread.sessionId}`,
    `/api/threads/${thread.sessionId}/events`,
  ]
  return pick(reads)
}

/** Open loop: `rps` requests a second whatever the answers, for `seconds`. */
async function openLoop(rps, seconds, stats, byPath) {
  const pending = new Set()
  const started = performance.now()
  let sent = 0
  while (performance.now() - started < seconds * 1000) {
    const due = Math.floor(((performance.now() - started) / 1000) * rps)
    while (sent < due) {
      sent++
      const member = pick(members)
      const path = dashboardRead(member)
      const key = path.replace(/[a-z0-9-]{20,}/g, ':id')
      byPath[key] ??= new Stats()
      const one = new Stats()
      const p = timed(one, API + path, { headers: { cookie: member.cookie } }).then(() => {
        for (const s of [stats, byPath[key]]) {
          s.ms.push(...one.ms)
          for (const [k, v] of Object.entries(one.status)) s.status[k] = (s.status[k] ?? 0) + v
          for (const [k, v] of Object.entries(one.errors)) s.errors[k] = (s.errors[k] ?? 0) + v
        }
      })
      pending.add(p)
      p.finally(() => pending.delete(p))
    }
    await sleep(5)
  }
  await Promise.all(pending)
}

async function http() {
  const steps = opt('steps', '25,50,100').split(',').map(Number)
  const seconds = Number(opt('seconds', 60))
  const report = []
  for (const rps of steps) {
    log(`http: ${rps} requests/s for ${seconds}s`)
    const stats = new Stats()
    const byPath = {}
    await openLoop(rps, seconds, stats, byPath)
    const summary = stats.summary()
    report.push({
      rps,
      ...summary,
      byPath: Object.fromEntries(
        Object.entries(byPath).map(([k, s]) => {
          const { p50, p95, failedPct } = s.summary()
          return [k, { p50, p95, failedPct }]
        }),
      ),
    })
    log(`  p50 ${summary.p50} ms, p95 ${summary.p95} ms, failed ${summary.failedPct}%`)
    if (summary.failedPct > 20) break
    await sleep(5000)
  }
  return { scenario: 'http', seconds, steps: report }
}

// ---------------------------------------------------------------------------------------------
// Sockets

const wsUrl = (path) => API.replace(/^http/, 'ws') + path
const PROTOCOL = 53

/** A runner's socket, as apps/runner/src/connection.ts opens it. */
function runnerSocket(workspace, counters, onOpen) {
  const ws = new WebSocket(wsUrl(`/runner/ws?workspace=${workspace.workspaceId}`), {
    headers: { authorization: `Bearer ${workspace.runnerToken}` },
    handshakeTimeout: 15_000,
  })
  const started = performance.now()
  ws.on('open', () => {
    ws.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: PROTOCOL,
        version: 'load-test',
        platform: 'linux',
      }),
    )
  })
  ws.on('message', (raw) => {
    const message = JSON.parse(String(raw))
    if (message.type === 'welcome') {
      counters.runnerConnect.add(performance.now() - started, 'welcome')
      onOpen?.(ws)
    } else if (message.type === 'ack') counters.acks++
  })
  return ws
}

function dashboardSocket(member, thread, counters, onOpen) {
  const ws = new WebSocket(wsUrl(`/api/ws?workspace=${member.workspace.workspaceId}`), {
    headers: { cookie: member.cookie, origin: 'https://loadtest.invalid' },
    handshakeTimeout: 15_000,
  })
  const started = performance.now()
  ws.on('open', () => {
    counters.dashboardConnect.add(performance.now() - started, 'open')
    ws.send(
      JSON.stringify({ type: 'subscribe', sessionId: thread.sessionId, afterSeq: thread.lastSeq }),
    )
    onOpen?.(ws)
  })
  ws.on('message', (raw) => {
    const message = JSON.parse(String(raw))
    if (message.type !== 'events') return
    for (const e of message.events) {
      const sent = /^load:(\d+(?:\.\d+)?)$/.exec(e.event?.text ?? '')
      if (sent) counters.delivery.add(Date.now() - Number(sent[1]), 'event')
    }
  })
  return ws
}

async function sockets() {
  const seconds = Number(opt('seconds', 120))
  const perSecond = Number(opt('events', 2))
  const dashboards = Number(opt('dashboards', 3))
  const stormAt = Number(opt('storm-at', 0))
  const reconnect = opt('reconnect', 'spread')
  const counters = {
    runnerConnect: new Stats(),
    dashboardConnect: new Stats(),
    delivery: new Stats(),
    acks: 0,
    closes: {},
    errors: {},
    reconnects: 0,
  }
  const every = []
  const stopAt = Date.now() + seconds * 1000
  const delay = () => (reconnect === 'fixed' ? 1000 : 1000 + Math.random() * 9000)
  const dashDelay = () => (reconnect === 'fixed' ? 2000 : 2000 + Math.random() * 4000)

  function keep(make, wait) {
    const slot = { ws: null }
    const open = () => {
      if (Date.now() > stopAt) return
      const ws = make()
      slot.ws = ws
      ws.on('close', (code) => {
        counters.closes[code] = (counters.closes[code] ?? 0) + 1
        if (slot.ws !== ws || Date.now() > stopAt) return
        counters.reconnects++
        setTimeout(open, wait())
      })
      ws.on('error', (error) => {
        const key = String(error.message).slice(0, 60)
        counters.errors[key] = (counters.errors[key] ?? 0) + 1
      })
    }
    open()
    every.push(slot)
    return slot
  }

  for (const workspace of seed.workspaces) {
    // One thread per workspace takes the events; its dashboards follow it, from where it is now.
    const thread = { ...workspace.threads[0] }
    const page = await api(workspace.members[0], `/api/threads/${thread.sessionId}/events`)
    thread.lastSeq = page.lastSeq
    let seq = thread.lastSeq
    let streaming
    keep(
      () =>
        runnerSocket(workspace, counters, (ws) => {
          clearInterval(streaming)
          streaming = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) return
            seq++
            ws.send(
              JSON.stringify({
                type: 'events',
                events: [
                  {
                    sessionId: thread.sessionId,
                    seq,
                    event: {
                      type: 'message.delta',
                      at: new Date().toISOString(),
                      id: 'load',
                      text: `load:${Date.now()}`,
                      // As runners send them: an unmasked delta's text is not passed on.
                      masked: true,
                    },
                  },
                ],
              }),
            )
          }, 1000 / perSecond)
          // Keepalive, as runners send it.
          const alive = setInterval(
            () => ws.readyState === WebSocket.OPEN && ws.send('{"type":"keepalive"}'),
            30_000,
          )
          ws.on('close', () => {
            clearInterval(streaming)
            clearInterval(alive)
          })
        }),
      delay,
    )
    for (const member of workspace.members.slice(0, dashboards))
      keep(() => dashboardSocket({ ...member, workspace }, thread, counters), dashDelay)
  }
  log(`sockets: ${every.length} open for ${seconds}s`)
  if (stormAt) {
    await sleep(stormAt * 1000)
    log(`sockets: dropping every socket (${reconnect})`)
    for (const slot of every) slot.ws?.terminate()
  }
  while (Date.now() < stopAt) {
    await sleep(5000)
    const open = every.filter((s) => s.ws?.readyState === WebSocket.OPEN).length
    log(`  ${open}/${every.length} open, ${counters.delivery.ms.length} events seen`)
  }
  for (const slot of every) slot.ws?.close()
  return {
    scenario: 'sockets',
    seconds,
    sockets: every.length,
    eventsPerRunnerPerSecond: perSecond,
    reconnect,
    stormAt,
    runnerConnect: counters.runnerConnect.summary(),
    dashboardConnect: counters.dashboardConnect.summary(),
    delivery: counters.delivery.summary(),
    acks: counters.acks,
    closes: counters.closes,
    errors: counters.errors,
    reconnects: counters.reconnects,
  }
}

// ---------------------------------------------------------------------------------------------
// Files

async function api(member, path, init = {}) {
  const response = await fetch(API + path, {
    ...init,
    headers: {
      cookie: member.cookie,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

/** `size` bytes made as they are sent, never held whole: a stream and its SHA-256 as it goes. */
function bytes(size) {
  const chunk = randomBytes(1024 * 1024)
  let sent = 0
  return new ReadableStream({
    pull(controller) {
      if (sent >= size) return controller.close()
      const n = Math.min(chunk.length, size - sent)
      controller.enqueue(chunk.subarray(0, n))
      sent += n
    },
  })
}

async function upload(member, name, size) {
  const started = performance.now()
  const target = await api(member, '/api/uploads', {
    method: 'POST',
    body: { purpose: 'library', name, size, contentType: 'application/octet-stream' },
  })
  const put = await fetch(target.url, {
    method: 'PUT',
    headers: { ...(target.headers ?? {}), 'content-length': String(size) },
    body: bytes(size),
    duplex: 'half',
  })
  if (!put.ok) throw new Error(`PUT ${put.status} ${(await put.text()).slice(0, 200)}`)
  const putMs = performance.now() - started
  const checkStarted = performance.now()
  await api(member, `/api/uploads/${target.id}/complete`, { method: 'POST' })
  const checkMs = performance.now() - checkStarted
  const file = await api(member, '/api/library/files', {
    method: 'POST',
    body: { path: `Load/${name}`, uploadId: target.id },
  })
  return { id: file.id, putMs: Math.round(putMs), checkMs: Math.round(checkMs) }
}

/** Download as a browser does, following a redirect to the bucket; bytes counted, not kept. */
async function download(member, path, stats, range) {
  const started = performance.now()
  try {
    const response = await fetch(API + path, {
      headers: { cookie: member.cookie, ...(range ? { range } : {}) },
      signal: AbortSignal.timeout(300_000),
    })
    let size = 0
    for await (const chunk of response.body) size += chunk.length
    stats.add(performance.now() - started, response.status)
    return { status: response.status, size, redirected: response.redirected }
  } catch (error) {
    stats.fail(error)
    return null
  }
}

async function files() {
  const member = members[0]
  const big = Number(opt('big-mb', 500)) * 1024 * 1024
  const report = { scenario: 'files' }
  // Dashboard reads go on meanwhile: what a large transfer costs everyone else.
  const background = new Stats()
  let reading = true
  const readers = (async () => {
    while (reading) await openLoop(Number(opt('rps', 20)), 5, background, {})
  })()

  log(`files: uploading ${big / 1048576} MB`)
  try {
    const up = await upload(member, `big-${Date.now()}.bin`, big)
    report.bigUpload = { mb: big / 1048576, ...up }
    log(`  put ${up.putMs} ms, check ${up.checkMs} ms`)
    const whole = new Stats()
    report.bigDownload = await download(member, `/api/library/${up.id}/content?download`, whole)
    report.bigDownload.ms = whole.ms[0] ? Math.round(whole.ms[0]) : null
    const ranges = new Stats()
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        download(
          member,
          `/api/library/${up.id}/content`,
          ranges,
          `bytes=${i * 1048576}-${i * 1048576 + 1048575}`,
        ),
      ),
    )
    report.bigRanges = ranges.summary()
  } catch (error) {
    report.bigError = String(error.message ?? error)
  }

  log('files: 25 MB file downloaded 20 times at once')
  try {
    const mid = await upload(member, `mid-${Date.now()}.bin`, 25 * 1024 * 1024)
    const many = new Stats()
    await Promise.all(
      Array.from({ length: 20 }, () =>
        download(pick(members), `/api/library/${mid.id}/content?download`, many),
      ),
    )
    report.parallelDownloads = many.summary()
  } catch (error) {
    report.parallelError = String(error.message ?? error)
  }

  log('files: runner bundle downloaded 30 times at once')
  const bundle = new Stats()
  const sizes = await Promise.all(
    Array.from({ length: 30 }, () => download(member, '/runner/bundle.tgz', bundle)),
  )
  report.bundle = { ...bundle.summary(), mb: Math.round((sizes[0]?.size ?? 0) / 1048576) }

  reading = false
  await readers
  report.readsMeanwhile = background.summary()
  return report
}

// ---------------------------------------------------------------------------------------------
// Sign-ups

async function signups() {
  const count = Number(opt('count', 12))
  const signup = new Stats()
  const onboarding = new Stats()
  const limited = new Stats()
  const password = `load-${randomBytes(8).toString('hex')}`
  for (let i = 0; i < count; i++) {
    const email = `signup-${seed.run}-${Date.now()}-${i}@loadtest.invalid`
    const started = performance.now()
    const response = await fetch(`${API}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://loadtest.invalid' },
      body: JSON.stringify({ email, password, name: `Load ${i}` }),
    })
    await response.arrayBuffer()
    if (response.status === 429) {
      limited.add(performance.now() - started, 429)
      await sleep(10_000)
      continue
    }
    signup.add(performance.now() - started, response.status)
    const cookie = response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .find((c) => c.includes('session_token='))
    if (cookie) {
      const member = { cookie }
      const t = performance.now()
      try {
        // As onboarding does (apps/web/app/onboarding/page.tsx): an organization, then its
        // first workspace.
        const name = `Signup ${seed.run} ${Date.now()} ${i}`
        await api(member, '/api/auth/organization/create', {
          method: 'POST',
          body: { name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') },
          headers: { origin: 'https://loadtest.invalid' },
        })
        await api(member, '/api/me')
        await api(member, '/api/workspaces', { method: 'POST', body: { name } })
        await api(member, '/api/me')
        onboarding.add(performance.now() - t, 200)
      } catch (error) {
        onboarding.fail(error)
      }
    }
    // Three a visitor per 10 seconds (better-auth's rule for sign-ups).
    if (i % 3 === 2) await sleep(10_500)
  }
  // The limit itself: a burst from one address is refused cleanly, not failed.
  const burst = await Promise.all(
    Array.from({ length: 10 }, async (_, i) => {
      const response = await fetch(`${API}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://loadtest.invalid' },
        body: JSON.stringify({
          email: `burst-${Date.now()}-${i}@loadtest.invalid`,
          password,
          name: 'Burst',
        }),
      })
      await response.arrayBuffer()
      return response.status
    }),
  )
  return {
    scenario: 'signups',
    signup: signup.summary(),
    onboarding: onboarding.summary(),
    limitedDuringRun: limited.ms.length,
    burstOf10: burst.reduce((a, s) => ({ ...a, [s]: (a[s] ?? 0) + 1 }), {}),
  }
}

const scenarios = { http, sockets, files, signups }
if (!scenarios[scenario]) {
  console.error(
    `Usage: run.mjs ${Object.keys(scenarios).join('|')} --api <url> --workspaces <json>`,
  )
  process.exit(1)
}
const report = await scenarios[scenario]()
console.log(JSON.stringify(report, null, 1))
process.exit(0)
