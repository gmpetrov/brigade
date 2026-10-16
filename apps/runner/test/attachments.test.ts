import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

// The cache and the state go to a folder of the test's own.
const home = await mkdtemp(join(tmpdir(), 'brigade-attachments-'))
process.env.BRIGADE_HOME = home
const { Attachments } = await import('../src/attachments.js')

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

test('a large file comes from the bucket by redirect, without the token, and lands whole', async () => {
  // Larger than one chunk many times over, so it is written as it arrives.
  const bytes = randomBytes(8 * 1024 * 1024 + 123)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  let bucketHeaders: IncomingHttpHeaders = {}
  const bucket = createServer((req, res) => {
    bucketHeaders = req.headers
    res.end(bytes)
  })
  servers.push(bucket)
  // Another origin than the API's, as R2 is.
  const bucketUrl = (await listen(bucket)).replace('127.0.0.1', 'localhost')
  const api = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer runner-token')
    res.writeHead(302, { location: `${bucketUrl}/signed?X-Amz-Signature=x` }).end()
  })
  servers.push(api)
  const apiUrl = await listen(api)

  const attachments = new Attachments({ apiUrl, token: 'runner-token' } as never)
  const workDir = await mkdtemp(join(home, 'work-'))
  const ref = {
    id: 'att1',
    path: 'attachments/recording.mov',
    name: 'recording.mov',
    contentType: 'video/quicktime',
    size: bytes.length,
    sha256,
    status: 'ready',
    source: 'upload',
  } as const
  const failed = await attachments.deliver([ref], { key: 'thread-a', workDir })
  assert.deepEqual(failed, [])
  assert.equal(bucketHeaders.authorization, undefined)
  assert.ok((await readFile(join(workDir, ref.path))).equals(bytes))
  assert.equal((await stat(join(workDir, ref.path))).mode & 0o777, 0o644)

  // Another teammate's folder: from the cache, without asking again.
  bucketHeaders = {}
  const other = await mkdtemp(join(home, 'work-'))
  assert.deepEqual(await attachments.deliver([ref], { key: 'thread-b', workDir: other }), [])
  assert.deepEqual(bucketHeaders, {})
  assert.ok((await readFile(join(other, ref.path))).equals(bytes))
})

test('a file that does not match its SHA-256 is neither kept nor put in the folder', async () => {
  const api = createServer((_req, res) => res.end('not the file'))
  servers.push(api)
  const attachments = new Attachments({ apiUrl: await listen(api), token: 't' } as never)
  const workDir = await mkdtemp(join(home, 'work-'))
  const ref = {
    id: 'att2',
    path: 'attachments/a.txt',
    name: 'a.txt',
    contentType: 'text/plain',
    size: 12,
    sha256: '0'.repeat(64),
    status: 'ready',
    source: 'upload',
  } as const
  const failed = await attachments.deliver([ref], { key: 'thread-c', workDir })
  assert.equal(failed.length, 1)
  assert.match(failed[0]!, /changed on the way/)
  await assert.rejects(stat(join(home, 'attachments', 'att2')))
  await assert.rejects(stat(join(home, 'attachments', 'att2.part')))
  await assert.rejects(stat(join(workDir, ref.path)))
})
