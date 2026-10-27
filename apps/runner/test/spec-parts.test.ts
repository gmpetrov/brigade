import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { ThreadSpec } from '@brigade/contracts'
import { SpecParts } from '../src/spec-parts.js'

// A thread spec's parts named by hash (SPEC_PARTS_PROTOCOL): filled in from the API once, then
// from the disk; a part that does not match its hash is never used.
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
