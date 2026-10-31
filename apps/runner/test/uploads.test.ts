import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Readable } from 'node:stream'
import { LIBRARY_FILE_MAX } from '@brigade/contracts'

// The attachments cache goes to a folder of the test's own.
const home = await mkdtemp(join(tmpdir(), 'brigade-uploads-'))
process.env.BRIGADE_HOME = home
const { Attachments } = await import('../src/attachments.js')
const { bundleStore, libraryMessage, stageStream, uploadForTeammate } =
  await import('../src/uploads.js')
const { libraryTools } = await import('../src/harness/tools.js')

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

type Seen = { method: string; url: string; auth?: string; length?: string; body: Buffer }

const listen = (server: Server) =>
  new Promise<string>((done) =>
    server.listen(0, '127.0.0.1', () =>
      done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  )

const servers: Server[] = []
after(async () => {
  for (const server of servers) server.close()
  await rm(home, { recursive: true, force: true })
})

/**
 * An API with its tickets, and a bucket: on the API itself (a signed relative path, as
 * without R2) or on another origin (as R2). Complete checks what the bucket holds against
 * the SHA-256 the start gave; `failFirst` refuses the first complete as a mismatch.
 */
async function fakeApi(options: { r2?: boolean; failFirst?: boolean } = {}) {
  const seen: Seen[] = []
  const held = new Map<string, Buffer>()
  const started = new Map<string, { sha256: string; size: number; name?: string }>()
  let failed = false
  const read = (req: import('node:http').IncomingMessage) =>
    new Promise<Buffer>((done) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => done(Buffer.concat(chunks)))
    })
  const bucket = createServer(async (req, res) => {
    const body = await read(req)
    seen.push({
      method: req.method!,
      url: `bucket${req.url}`,
      ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
      ...(req.headers['content-length'] ? { length: req.headers['content-length'] } : {}),
      body,
    })
    held.set(new URL(req.url!, 'http://x').searchParams.get('key')!, body)
    res.end()
  })
  servers.push(bucket)
  const bucketUrl = (await listen(bucket)).replace('127.0.0.1', 'localhost')
  let next = 0
  const api = createServer(async (req, res) => {
    const body = await read(req)
    seen.push({
      method: req.method!,
      url: req.url!,
      ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
      ...(req.headers['content-length'] ? { length: req.headers['content-length'] } : {}),
      body,
    })
    res.setHeader('content-type', 'application/json')
    const url = new URL(req.url!, 'http://x')
    if (req.method === 'PUT' && url.pathname === '/api/bucket') {
      held.set(url.searchParams.get('key')!, body)
      return res.end('{}')
    }
    const ticket = (key: string) => ({
      url: options.r2 ? `${bucketUrl}/put?key=${key}&sig=1` : `/api/bucket?key=${key}&sig=1`,
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
    })
    const complete = (key: string) => {
      const start = started.get(key)
      const bytes = held.get(key)
      const refuse = (status: number, error: string) => {
        res.writeHead(status).end(JSON.stringify({ error }))
        return null
      }
      if (!start || !bytes) return refuse(409, 'not there yet')
      if (options.failFirst && !failed) {
        failed = true
        return refuse(400, 'does not match')
      }
      if (sha256(bytes) !== start.sha256 || bytes.length !== start.size)
        return refuse(400, 'does not match')
      return { ...start, bytes }
    }
    const json = JSON.parse(body.toString() || '{}') as Record<string, unknown>
    let m: RegExpExecArray | null
    if (url.pathname === '/runner/uploads' || url.pathname === '/runner/attachments/uploads') {
      const id = `up${++next}`
      started.set(id, json as never)
      return res.writeHead(201).end(JSON.stringify({ id, ...ticket(id) }))
    }
    if ((m = /^\/runner\/(?:uploads|attachments)\/(\w+)\/complete$/.exec(url.pathname))) {
      if (
        url.pathname.startsWith('/runner/attachments') &&
        json.sha256 !== started.get(m[1]!)?.sha256
      )
        return res.writeHead(400).end('{"error":"which file?"}')
      const done = complete(m[1]!)
      if (!done) return
      return res.end(
        JSON.stringify({
          id: m[1],
          purpose: json.purpose ?? 'library',
          name: done.name,
          contentType: '',
          size: done.size,
          sha256: done.sha256,
        }),
      )
    }
    if ((m = /^(\/runner\/backups\/.+)\/(upload|done)$/.exec(url.pathname))) {
      const key = m[1]!
      if (m[2] === 'upload') {
        started.set(key, json as never)
        const { url: put, headers } = ticket(encodeURIComponent(key))
        return res.end(JSON.stringify({ url: put, headers }))
      }
      if (!complete(key)) return
      return res.end('{"ok":true}')
    }
    res.writeHead(404).end('{"error":"no such route"}')
  })
  servers.push(api)
  return { apiUrl: await listen(api), seen, held }
}

const urls = (seen: Seen[]) => seen.map((r) => `${r.method} ${r.url.replace(/\?.*$/, '')}`)

test('an upload goes to a signed path of the API without R2, without the token, then is checked', async () => {
  const api = await fakeApi()
  const bytes = randomBytes(1000)
  const info = await uploadForTeammate(
    { apiUrl: api.apiUrl, token: 'tok' },
    { purpose: 'library', sessionId: 's1', teammateId: 't1', name: 'notes/a.bin', bytes },
  )
  assert.equal(info.sha256, sha256(bytes))
  assert.equal(info.size, bytes.length)
  assert.deepEqual(urls(api.seen), [
    'POST /runner/uploads',
    'PUT /api/bucket',
    'POST /runner/uploads/up1/complete',
  ])
  const [start, put, complete] = api.seen
  assert.equal(start!.auth, 'Bearer tok')
  assert.deepEqual(JSON.parse(start!.body.toString()), {
    purpose: 'library',
    sessionId: 's1',
    teammateId: 't1',
    name: 'notes/a.bin',
    size: bytes.length,
    sha256: sha256(bytes),
  })
  assert.equal(put!.auth, undefined, 'the signed URL needs no token')
  assert.ok(put!.body.equals(bytes))
  assert.equal(complete!.auth, 'Bearer tok')
})

test('with R2 the bytes go to the bucket, never with the token; a mismatch is uploaded again once', async () => {
  const api = await fakeApi({ r2: true, failFirst: true })
  const bytes = randomBytes(2000)
  await uploadForTeammate(
    { apiUrl: api.apiUrl, token: 'tok' },
    { purpose: 'skill_file', sessionId: 's1', name: 'notes.md', bytes },
  )
  assert.deepEqual(urls(api.seen), [
    'POST /runner/uploads',
    'PUT bucket/put',
    'POST /runner/uploads/up1/complete',
    'POST /runner/uploads',
    'PUT bucket/put',
    'POST /runner/uploads/up2/complete',
  ])
  for (const put of api.seen.filter((r) => r.method === 'PUT')) {
    assert.equal(put.auth, undefined)
    assert.ok(put.body.equals(bytes))
  }
})

test('a library save sends the upload, not the bytes; one too large for a thread is refused first', async () => {
  const api = await fakeApi()
  const bytes = Buffer.from('# Refunds\n')
  const operation = await libraryMessage(
    { apiUrl: api.apiUrl, token: 'tok' },
    { sessionId: 's1', teammateId: 't1' },
    { name: 'save', path: 'guides/refunds.md', bytes },
  )
  assert.deepEqual(operation, { name: 'save', path: 'guides/refunds.md', upload: { id: 'up1' } })
  assert.ok(api.held.get('up1')!.equals(bytes))

  const before = api.seen.length
  // Its size as staged, without holding 500 MB here; the staged file goes all the same.
  const big = join(home, 'big.bin')
  await writeFile(big, 'x')
  await assert.rejects(
    libraryMessage(
      { apiUrl: api.apiUrl, token: 'tok' },
      { sessionId: 's1' },
      {
        name: 'save',
        path: 'big.bin',
        file: { path: big, size: LIBRARY_FILE_MAX + 1, sha256: '0'.repeat(64) },
      },
    ),
    /can be up to 500 MB/,
  )
  assert.equal(api.seen.length, before, 'nothing was sent')
  await assert.rejects(access(big), 'the staged file was removed')
  // Other operations go as they are.
  const search = { name: 'search' as const, query: 'refunds', limit: 8 }
  assert.equal(
    await libraryMessage({ apiUrl: api.apiUrl, token: 'tok' }, { sessionId: 's1' }, search),
    search,
  )
})

for (const r2 of [false, true])
  test(`a staged save streams to the ${r2 ? 'bucket' : "API's stand-in"} with its length, and is removed once sent`, async () => {
    const api = await fakeApi({ r2 })
    const bytes = randomBytes(300_000)
    const file = await stageStream(
      Readable.from([bytes.subarray(0, 100_000), bytes.subarray(100_000)]),
      bytes.length,
      'Files saved to the library',
    )
    assert.equal(file.size, bytes.length)
    assert.equal(file.sha256, sha256(bytes))
    const operation = await libraryMessage(
      { apiUrl: api.apiUrl, token: 'tok' },
      { sessionId: 's1', teammateId: 't1' },
      { name: 'save', path: 'films/demo.mp4', file },
    )
    assert.deepEqual(operation, { name: 'save', path: 'films/demo.mp4', upload: { id: 'up1' } })
    assert.ok(api.held.get('up1')!.equals(bytes))
    const put = api.seen.find((r) => r.method === 'PUT')!
    assert.equal(put.auth, undefined, 'the signed URL needs no token')
    assert.equal(put.length, String(bytes.length), 'the bucket takes no upload of unknown length')
    await assert.rejects(access(file.path), 'the staged file was removed')
  })

test('staging refuses a stream past its limit and leaves nothing behind', async () => {
  await assert.rejects(
    stageStream(
      Readable.from([Buffer.alloc(6), Buffer.alloc(6)]),
      10,
      'Files saved to the library',
    ),
    /Files saved to the library can be up to 0 MB/,
  )
  assert.deepEqual(await readdir(join(home, 'staging')), [])
})

test('propose_skill uploads its text files and the proposal names them by SHA-256', async () => {
  const api = await fakeApi()
  const files: Record<string, Buffer> = {
    '/skill/SKILL.md': Buffer.from(
      '---\nname: refunds\ndescription: How to refund\n---\n\nSteps.\n',
    ),
    '/skill/notes.md': Buffer.from('Notes.\n'),
    '/skill/data/table.csv': Buffer.from('a,b\n1,2\n'),
    '/skill/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]),
  }
  const calls: unknown[] = []
  const tools = libraryTools({
    access: 'read',
    libraryDir: '/library',
    readFile: async (path) => files[path]!,
    listFiles: async () => ['SKILL.md', 'notes.md', 'data/table.csv', 'logo.png'],
    renderDesign: async () => ({ screenshots: [], errors: [] }),
    call: async (call) => {
      const operation = await libraryMessage(
        { apiUrl: api.apiUrl, token: 'tok' },
        { sessionId: 's1', teammateId: 't1' },
        call.operation,
      )
      calls.push(operation)
      return { ticketId: 'tk1', change: false }
    },
  })
  const result = (await tools.propose_skill!.execute!(
    { folder: '/skill', reason: 'it keeps coming up' },
    { toolCallId: 'c1', messages: [] } as never,
  )) as { files: number; skipped?: string }
  assert.equal(result.files, 2)
  assert.match(result.skipped!, /logo\.png/)
  assert.deepEqual(calls, [
    {
      name: 'skill_proposal',
      proposal: {
        skill: {
          name: 'refunds',
          description: 'How to refund',
          instructions: 'Steps.',
          files: [],
        },
        reason: 'it keeps coming up',
        teammateOnly: false,
        refs: [
          { path: 'notes.md', sha256: sha256(files['/skill/notes.md']!), size: 7 },
          { path: 'data/table.csv', sha256: sha256(files['/skill/data/table.csv']!), size: 8 },
        ],
      },
    },
  ])
  const starts = api.seen
    .filter((r) => r.url === '/runner/uploads')
    .map((r) => JSON.parse(r.body.toString()) as { purpose: string; name: string })
  assert.deepEqual(
    starts.map((s) => `${s.purpose} ${s.name}`),
    ['skill_file notes.md', 'skill_file data/table.csv'],
  )
})

test('save_to_library stages the file and hands it to the caller, which uploads it', async () => {
  const file = { path: '/staging/1', size: 5, sha256: 'a'.repeat(64) }
  const operations: unknown[] = []
  const tools = libraryTools({
    access: 'read_write',
    libraryDir: '/library',
    readFile: async () => assert.fail('save_to_library never reads the file whole'),
    stageFile: async (path) => (path === 'a.txt' ? file : assert.fail(path)),
    listFiles: async () => [],
    renderDesign: async () => ({ screenshots: [], errors: [] }),
    call: async (call) => {
      operations.push(call.operation)
      return { ok: true }
    },
  })
  await tools.save_to_library!.execute!({ file: 'a.txt', path: 'notes/a.txt' }, {
    toolCallId: 'c1',
    messages: [],
  } as never)
  assert.deepEqual(operations, [{ name: 'save', path: 'notes/a.txt', file }])
})

test('a file for a connector call goes to the bucket, and its id comes back once checked', async () => {
  const api = await fakeApi({ r2: true })
  const attachments = new Attachments({ apiUrl: api.apiUrl, token: 'tok' } as never)
  const bytes = randomBytes(3000)
  const id = await attachments.upload({ sessionId: 's1', teammateId: 't1', name: 'a.pdf', bytes })
  assert.equal(id, 'up1')
  assert.deepEqual(urls(api.seen), [
    'POST /runner/attachments/uploads',
    'PUT bucket/put',
    'POST /runner/attachments/up1/complete',
  ])
  assert.deepEqual(JSON.parse(api.seen[0]!.body.toString()), {
    sessionId: 's1',
    teammateId: 't1',
    name: 'a.pdf',
    size: bytes.length,
    sha256: sha256(bytes),
  })
  assert.deepEqual(JSON.parse(api.seen[2]!.body.toString()), { sha256: sha256(bytes) })
  // A refusal says which file.
  await assert.rejects(
    new Attachments({ apiUrl: api.apiUrl.replace(/\d+$/, '9'), token: 'tok' } as never).upload({
      sessionId: 's1',
      teammateId: 't1',
      name: 'b.pdf',
      bytes,
    }),
    /Could not send b\.pdf/,
  )
})

test('a git backup goes to the bucket, then the API checks its size and SHA-256', async () => {
  const api = await fakeApi({ r2: true })
  const bundle = Buffer.from('# v2 git bundle\nabc\n')
  await bundleStore({ apiUrl: api.apiUrl, token: 'tok' }).put(
    { repository: 'acme/app', sessionId: 's1', teammateId: 't1', folder: 'app' },
    bundle,
  )
  assert.deepEqual(urls(api.seen), [
    'POST /runner/backups/acme/app/s1/t1/app/upload',
    'PUT bucket/put',
    'POST /runner/backups/acme/app/s1/t1/app/done',
  ])
  const body = { size: bundle.length, sha256: sha256(bundle) }
  assert.deepEqual(JSON.parse(api.seen[0]!.body.toString()), body)
  assert.deepEqual(JSON.parse(api.seen[2]!.body.toString()), body)
  assert.equal(api.seen[1]!.auth, undefined)
})
