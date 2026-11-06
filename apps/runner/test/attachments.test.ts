import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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

test('a file the folder already holds as it is (a moved thread) is not fetched again', async () => {
  const bytes = Buffer.from('a screenshot, brought over with the folder')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  let asked = 0
  const api = createServer((_req, res) => {
    asked++
    res.end(bytes)
  })
  servers.push(api)
  const attachments = new Attachments({ apiUrl: await listen(api), token: 't' } as never)
  const ref = {
    id: 'att3',
    path: 'attachments/shot.png',
    name: 'shot.png',
    contentType: 'image/png',
    size: bytes.length,
    sha256,
    status: 'ready',
    source: 'upload',
  } as const
  // The folder came with it; this computer never put it there (no index for it).
  const workDir = await mkdtemp(join(home, 'work-'))
  await mkdir(join(workDir, 'attachments'), { recursive: true })
  await writeFile(join(workDir, ref.path), bytes)
  let fetching = 0
  assert.deepEqual(
    await attachments.deliver([ref], { key: 'moved', workDir }, () => fetching++),
    [],
  )
  assert.equal(asked, 0)
  assert.equal(fetching, 0)
  // Put once: the teammate's own changes after it stay.
  await writeFile(join(workDir, ref.path), 'edited by the teammate')
  assert.deepEqual(await attachments.deliver([ref], { key: 'moved', workDir }), [])
  assert.equal(await readFile(join(workDir, ref.path), 'utf8'), 'edited by the teammate')
  assert.equal(asked, 0)
})

test('a file that differs, or is missing, is fetched, and the turn is told once', async () => {
  const files = { a: Buffer.from('first file'), b: Buffer.from('second file') }
  let asked = 0
  const api = createServer((req, res) => {
    asked++
    res.end(req.url!.endsWith('att4') ? files.a : files.b)
  })
  servers.push(api)
  const attachments = new Attachments({ apiUrl: await listen(api), token: 't' } as never)
  const ref = (id: string, name: string, bytes: Buffer) =>
    ({
      id,
      path: `attachments/${name}`,
      name,
      contentType: 'text/plain',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      status: 'ready',
      source: 'upload',
    }) as const
  const refs = [ref('att4', 'a.txt', files.a), ref('att5', 'b.txt', files.b)]
  const workDir = await mkdtemp(join(home, 'work-'))
  await mkdir(join(workDir, 'attachments'), { recursive: true })
  await writeFile(join(workDir, 'attachments/a.txt'), 'another file at the same path')
  let fetching = 0
  assert.deepEqual(
    await attachments.deliver(refs, { key: 'differs', workDir }, () => fetching++),
    [],
  )
  assert.equal(asked, 2)
  assert.equal(fetching, 1)
  assert.ok((await readFile(join(workDir, 'attachments/a.txt'))).equals(files.a))
  assert.ok((await readFile(join(workDir, 'attachments/b.txt'))).equals(files.b))
})

/** A file given to the thread, as its spec says it. */
const refOf = (id: string, name: string, bytes: Buffer) =>
  ({
    id,
    path: `attachments/${name}`,
    name,
    contentType: 'video/mp4',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    status: 'ready',
    source: 'upload',
  }) as const

/** The API, sending `bytes` in pieces, a little at a time; how often it was asked. */
async function slowApi(bytes: () => Buffer) {
  const state = { asked: 0 }
  const api = createServer((_req, res) => {
    state.asked++
    const body = bytes()
    res.writeHead(200, { 'content-length': String(body.length) })
    let at = 0
    const next = () => {
      if (at >= body.length) return void res.end()
      res.write(body.subarray(at, (at += 256 * 1024)))
      setTimeout(next, 5)
    }
    next()
  })
  servers.push(api)
  return { url: await listen(api), state }
}

/** What is in a folder, dotfiles included. */
const names = (dir: string) => readdir(dir).catch(() => [] as string[])

test('a large file streams into the folder alone: no copy stays in the cache, and another teammate fetches it again', async () => {
  const bytes = randomBytes(3 * 1024 * 1024 + 11)
  const api = await slowApi(() => bytes)
  const attachments = new Attachments({ apiUrl: api.url, token: 't' } as never, {
    largeFile: 1024 * 1024,
  })
  const ref = refOf('big1', 'render.mp4', bytes)
  // What a runner before this one kept in its cache goes too: the disk holds the file once.
  await mkdir(join(home, 'attachments'), { recursive: true })
  await writeFile(join(home, 'attachments', ref.id), bytes)
  const workDir = await mkdtemp(join(home, 'work-'))
  let fetching = 0
  assert.deepEqual(
    await attachments.deliver([ref], { key: 'large-a', workDir }, () => fetching++),
    [],
  )
  assert.ok((await readFile(join(workDir, ref.path))).equals(bytes))
  assert.equal((await stat(join(workDir, ref.path))).mode & 0o777, 0o644)
  assert.equal(fetching, 1)
  await assert.rejects(stat(join(home, 'attachments', ref.id)), 'not in the cache')
  assert.deepEqual(await names(join(workDir, 'attachments')), ['render.mp4'], 'nothing beside it')

  const other = await mkdtemp(join(home, 'work-'))
  assert.deepEqual(await attachments.deliver([ref], { key: 'large-b', workDir: other }), [])
  assert.ok((await readFile(join(other, ref.path))).equals(bytes))
  assert.equal(api.state.asked, 2, 'fetched again from storage, not from a cache')
  await assert.rejects(stat(join(home, 'attachments', ref.id)))
})

test('a large file that does not match leaves nothing behind, and one a cut download left goes', async () => {
  const bytes = randomBytes(2 * 1024 * 1024)
  let sent = Buffer.concat([bytes.subarray(0, 1024 * 1024), randomBytes(1024 * 1024)])
  const api = await slowApi(() => sent)
  const attachments = new Attachments({ apiUrl: api.url, token: 't' } as never, {
    largeFile: 1024 * 1024,
  })
  const ref = refOf('big2', 'clip.mov', bytes)
  const workDir = await mkdtemp(join(home, 'work-'))
  const failed = await attachments.deliver([ref], { key: 'large-c', workDir })
  assert.equal(failed.length, 1)
  assert.match(failed[0]!, /changed on the way/)
  assert.deepEqual(await names(join(workDir, 'attachments')), [], 'neither it nor its partial copy')
  await assert.rejects(stat(join(home, 'attachments', ref.id)))

  // A runner stopped halfway through left its partial copy: the next delivery writes over it.
  const partial = join(workDir, 'attachments', `.brigade-${ref.id}.part`)
  await writeFile(partial, 'half of it')
  sent = bytes
  assert.deepEqual(await attachments.deliver([ref], { key: 'large-c', workDir }), [])
  assert.deepEqual(await names(join(workDir, 'attachments')), ['clip.mov'])
  assert.ok((await readFile(join(workDir, ref.path))).equals(bytes))
  assert.equal(api.state.asked, 2)

  // A folder that came with its file and a partial copy beside it (a backup taken mid-download):
  // nothing to fetch, and the partial copy goes all the same.
  const moved = await mkdtemp(join(home, 'work-'))
  await mkdir(join(moved, 'attachments'), { recursive: true })
  await writeFile(join(moved, ref.path), bytes)
  await writeFile(join(moved, 'attachments', `.brigade-${ref.id}.part`), 'half of it')
  assert.deepEqual(await attachments.deliver([ref], { key: 'large-moved', workDir: moved }), [])
  assert.equal(api.state.asked, 2, 'not fetched')
  assert.deepEqual(await names(join(moved, 'attachments')), ['clip.mov'])
})

test('two deliveries to one folder at once fetch a large file once, and both say it is there', async () => {
  const bytes = randomBytes(2 * 1024 * 1024 + 5)
  const api = await slowApi(() => bytes)
  const attachments = new Attachments({ apiUrl: api.url, token: 't' } as never, {
    largeFile: 1024 * 1024,
  })
  const ref = refOf('big3', 'take.mov', bytes)
  const workDir = await mkdtemp(join(home, 'work-'))
  const folder = { key: 'large-d', workDir }
  const [a, b] = await Promise.all([
    attachments.deliver([ref], folder),
    attachments.deliver([ref], folder),
  ])
  assert.deepEqual([a, b], [[], []])
  assert.equal(api.state.asked, 1)
  assert.ok((await readFile(join(workDir, ref.path))).equals(bytes))
  assert.deepEqual(await names(join(workDir, 'attachments')), ['take.mov'])
})

test('a small file is still kept in the cache for the next teammate', async () => {
  const bytes = randomBytes(64 * 1024)
  const api = await slowApi(() => bytes)
  const attachments = new Attachments({ apiUrl: api.url, token: 't' } as never, {
    largeFile: 1024 * 1024,
  })
  const ref = refOf('small1', 'shot.png', bytes)
  for (const key of ['small-a', 'small-b']) {
    const workDir = await mkdtemp(join(home, 'work-'))
    assert.deepEqual(await attachments.deliver([ref], { key, workDir }), [])
    assert.ok((await readFile(join(workDir, ref.path))).equals(bytes))
  }
  assert.equal(api.state.asked, 1)
  assert.ok((await readFile(join(home, 'attachments', ref.id))).equals(bytes))
})

test('a large file a runner before this one cached goes when the cache is cleaned, however recent; the rest stays', async () => {
  const cache = join(home, 'attachments')
  await mkdir(cache, { recursive: true })
  // Delivered long ago from that cache, and used just now: the folder has it, the cache need not.
  await writeFile(join(cache, 'old-large'), randomBytes(2 * 1024 * 1024))
  await writeFile(join(cache, 'recent-small'), randomBytes(1024))
  await writeFile(join(cache, `skill-${'a'.repeat(64)}`), randomBytes(2 * 1024 * 1024))
  const attachments = new Attachments({ apiUrl: 'http://127.0.0.1:1', token: 't' } as never, {
    largeFile: 1024 * 1024,
  })
  await attachments.cleanCache()
  await assert.rejects(stat(join(cache, 'old-large')))
  await stat(join(cache, 'recent-small'))
  await stat(join(cache, `skill-${'a'.repeat(64)}`))
})
