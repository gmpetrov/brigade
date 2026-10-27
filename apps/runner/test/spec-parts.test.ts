import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { ThreadSpec } from '@brigade/contracts'
import { NotTaken } from '../src/connection.js'
import { SpecParts } from '../src/spec-parts.js'

// A thread spec's parts named by hash (SPEC_PARTS_PROTOCOL): filled in from the API once, then
// from the disk, one fetch for specs naming the same part at once; a part that does not match its
// hash is never used, one the API refuses is not asked for again; a disk that will not keep it
// does not stop the command; a welcome goes on without a spec that did not come.
const connectors = [
  {
    connectionId: 'c1',
    kind: 'gmail',
    label: 'Gmail',
    externalAccount: null,
    scope: 'read',
    operations: [{ name: 'search', description: 'Search', write: false, inputSchema: {} }],
  },
]
const text = JSON.stringify(connectors)
const hash = createHash('sha256').update(text).digest('hex')
const tampered = 'f'.repeat(64)
const missing = 'e'.repeat(64)

let server: Server
let dir: string
let requests = 0
let apiUrl: string

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spec-parts-'))
  server = createServer((req, res) => {
    requests++
    if (req.headers.authorization !== 'Bearer token') return res.writeHead(401).end()
    if (req.url === `/runner/spec-parts/${hash}`) return res.end(text)
    if (req.url === `/runner/spec-parts/${tampered}`) return res.end(text)
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  server.close()
  await rm(dir, { recursive: true, force: true })
})

const spec = (parts?: Record<string, string>) =>
  ThreadSpec.parse({
    sessionId: 's1',
    teammate: { id: 't1', name: 'Kai', instructions: '', harness: 'claude_code', model: null },
    permissionMode: 'allow-all',
    account: { id: 'a1', provider: 'claude_code', source: 'brigade' },
    fallbacks: [],
    ...(parts ? { parts } : {}),
  })

test('a prompt is filled from the API once, then from the disk', async () => {
  requests = 0
  const prompt = {
    type: 'thread.prompt' as const,
    commandId: 'c',
    thread: spec({ connectors: hash }),
    then: [spec({ connectors: hash })],
    text: 'hi',
    memberId: null,
    attachments: [],
  }
  const filled = await new SpecParts({ apiUrl, token: 'token' }, dir).fill(prompt)
  assert.deepEqual(filled.thread.connectors, connectors)
  assert.equal(filled.thread.parts, undefined)
  assert.deepEqual(filled.then[0]!.connectors, connectors)
  assert.equal(requests, 1)
  assert.deepEqual(await readdir(dir), [`${hash}.json`])

  // Another process: from the disk, nothing asked.
  const again = await new SpecParts({ apiUrl, token: 'token' }, dir).spec(
    spec({ connectors: hash }),
  )
  assert.deepEqual(again.connectors, connectors)
  assert.equal(requests, 1)
})

test('a spec without parts, and a command without a spec, are as they came', async () => {
  const parts = new SpecParts({ apiUrl, token: 'token' }, dir)
  const whole = spec()
  assert.equal(await parts.spec(whole), whole)
  const interrupt = { type: 'thread.interrupt' as const, commandId: 'c', sessionId: 's1' }
  assert.equal(await parts.fill(interrupt), interrupt)
})

test('a part that does not match its hash is refused, after trying again', async () => {
  requests = 0
  const parts = new SpecParts({ apiUrl, token: 'token' }, dir, [1, 1])
  await assert.rejects(parts.spec(spec({ connectors: tampered })), /changed on the way/)
  assert.equal(requests, 3)
})

test('specs naming the same part at once wait for one fetch', async () => {
  requests = 0
  const fresh = await mkdtemp(join(tmpdir(), 'spec-parts-'))
  const parts = new SpecParts({ apiUrl, token: 'token' }, fresh)
  const filled = await Promise.all(
    Array.from({ length: 5 }, () => parts.spec(spec({ connectors: hash }))),
  )
  assert.ok(filled.every((s) => s.connectors.length === 1))
  assert.equal(requests, 1)
  await rm(fresh, { recursive: true, force: true })
})

test('a part the API refuses is not asked for again', async () => {
  requests = 0
  const parts = new SpecParts({ apiUrl, token: 'token' }, dir, [1, 1, 1])
  await assert.rejects(parts.spec(spec({ connectors: missing })), /answered 404/)
  assert.equal(requests, 1)
})

test('a disk that will not keep a part does not stop the command', async () => {
  requests = 0
  // A file where the cache's folder should be: nothing can be written in it.
  const blocked = join(dir, 'blocked')
  await writeFile(blocked, '')
  const filled = await new SpecParts({ apiUrl, token: 'token' }, blocked).spec(
    spec({ connectors: hash }),
  )
  assert.deepEqual(filled.connectors, connectors)
  assert.equal(requests, 1)
})

test('a welcome goes on without a spec that did not come', async () => {
  const parts = new SpecParts({ apiUrl, token: 'token' }, dir, [])
  const prompt = (parts: Record<string, string>) => ({
    type: 'thread.prompt' as const,
    commandId: 'c',
    thread: spec(parts),
    then: [],
    text: 'hi',
    memberId: null,
    attachments: [],
  })
  const welcome = await parts.fill({
    type: 'welcome',
    runnerId: 'r',
    computerId: 'c',
    resume: [spec({ connectors: hash }), spec({ connectors: missing })],
    requeue: [prompt({ connectors: missing }), prompt({ connectors: hash })],
    restore: { id: 'x', teammateIds: [], accountIds: [], folders: [] },
  })
  assert.equal(welcome.resume?.length, 1)
  assert.deepEqual(welcome.resume?.[0]?.connectors, connectors)
  assert.equal(welcome.requeue?.length, 1)
  assert.equal(welcome.restore?.id, 'x', 'its restore holds')
})

test('commands are handed on in the order they came, one not filled is not taken', async () => {
  const fresh = await mkdtemp(join(tmpdir(), 'spec-parts-'))
  const handled: string[] = []
  const receive = new SpecParts({ apiUrl, token: 'token' }, fresh, []).inOrder((m) => {
    handled.push('commandId' in m ? m.commandId : m.type)
  })
  const prompt = (commandId: string, parts?: Record<string, string>) => ({
    type: 'thread.prompt' as const,
    commandId,
    thread: spec(parts),
    then: [],
    text: 'hi',
    memberId: null,
    attachments: [],
  })
  // The first needs a fetch; those after it need none, and still wait for it.
  const results = [
    receive(prompt('first', { connectors: hash })),
    receive({ type: 'thread.interrupt', commandId: 'second', sessionId: 's1' }),
    receive(prompt('lost', { connectors: missing })),
    receive(prompt('third')),
  ]
  const settled = await Promise.allSettled(results)
  assert.deepEqual(handled, ['first', 'second', 'third'])
  assert.equal(settled[2]!.status, 'rejected')
  assert.ok((settled[2] as PromiseRejectedResult).reason instanceof NotTaken)
  await rm(fresh, { recursive: true, force: true })
})
