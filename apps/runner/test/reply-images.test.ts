import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { STORED_FILE } from '@brigade/contracts'
import { imageStore, imagesIn, keepReplyImages } from '../src/reply-images.js'
import type { UploadError } from '../src/uploads.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

test('a reply names its images by path, as the dashboard reads them', () => {
  assert.deepEqual(
    imagesIn(
      [
        '![Top of the landing](/tmp/rec/m0.png)',
        'See [the chart](./out/chart.JPG "Chart") and ![again](/tmp/rec/m0.png).',
        '![spaced](<shots/a b.webp>) ![encoded](shots/a%20c.gif#x)',
        '[a page](https://example.com/a.png) [notes](notes.md) [top](#top) ![](//cdn.example.com/x.png)',
        'By reference: ![shot][capture]',
        '',
        '[capture]: /tmp/shot.png',
        '  [other]: <shots/d e.png> "Title"',
        '[site]: https://example.com/b.png',
      ].join('\n'),
    ),
    [
      '/tmp/rec/m0.png',
      'out/chart.JPG',
      'shots/a b.webp',
      'shots/a c.gif',
      '/tmp/shot.png',
      'shots/d e.png',
    ],
  )
})

test('images on the computer are stored by their hash; missing ones and non-images are left out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reply-images-'))
  const workDir = join(root, 'thread')
  await mkdir(join(workDir, 'shots'), { recursive: true })
  await writeFile(join(workDir, 'shots', 'a.png'), PNG)
  await writeFile(join(root, 'elsewhere.png'), PNG)
  await writeFile(join(workDir, 'fake.png'), 'not an image')
  const stored: { sessionId: string; name: string; size: number; type: string }[] = []
  const images = await keepReplyImages(
    `![a](shots/a.png) ![b](${join(root, 'elsewhere.png')}) ![c](fake.png) ![d](gone.png)`,
    { workDir },
    's1',
    async (sessionId, name, bytes, type) => {
      stored.push({ sessionId, name, size: bytes.length, type })
    },
  )
  const name = `${createHash('sha256').update(PNG).digest('hex')}.png`
  assert.deepEqual(images, {
    'shots/a.png': `${STORED_FILE}${name}`,
    [join(root, 'elsewhere.png')]: `${STORED_FILE}${name}`,
  })
  assert.deepEqual(stored, [
    { sessionId: 's1', name, size: PNG.length, type: 'image/png' },
    { sessionId: 's1', name, size: PNG.length, type: 'image/png' },
  ])
})

test('an image the bucket refuses is left out, for the thread to read from the computer', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'reply-images-'))
  await writeFile(join(workDir, 'a.png'), PNG)
  const images = await keepReplyImages('![a](a.png)', { workDir }, 's1', async () => {
    throw new Error('the bucket refused the image (403)')
  })
  assert.deepEqual(images, {})
})

/**
 * An API that answers the ticket with `signed` (a URL on itself, or null), recording each
 * request. `status`: what the PUT gets; `complete`: what each complete gets, in turn.
 */
async function fakeApi(signed: boolean, status = 200, complete: number[] = []) {
  const seen: { method: string; url: string; auth?: string; type?: string; size: number }[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      seen.push({
        method: req.method!,
        url: req.url!,
        ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
        ...(req.headers['content-type'] ? { type: req.headers['content-type'] } : {}),
        size: body.length,
      })
      res.setHeader('content-type', 'application/json')
      if (req.url!.endsWith('/upload')) {
        const { port } = server.address() as AddressInfo
        return res.end(
          JSON.stringify(
            signed
              ? {
                  url: `http://127.0.0.1:${port}/bucket?sig=1`,
                  headers: { 'content-type': 'image/png' },
                }
              : { url: null },
          ),
        )
      }
      if (req.url!.endsWith('/complete')) {
        res.statusCode = complete.shift() ?? 200
        return res.end(res.statusCode === 200 ? '{"ok":true}' : '{"error":"no match"}')
      }
      res.statusCode = status
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { seen, apiUrl: `http://127.0.0.1:${port}`, close: () => server.close() }
}

const ticketSize = JSON.stringify({ size: PNG.length }).length

test('an image goes to the signed URL, without the runner token, then is checked', async () => {
  const api = await fakeApi(true)
  try {
    await imageStore({ apiUrl: api.apiUrl, token: 't0k' })('s1', 'abc.png', PNG, 'image/png')
    assert.deepEqual(api.seen, [
      {
        method: 'POST',
        url: '/runner/files/s1/abc.png/upload',
        auth: 'Bearer t0k',
        type: 'application/json',
        size: ticketSize,
      },
      { method: 'PUT', url: '/bucket?sig=1', type: 'image/png', size: PNG.length },
      {
        method: 'POST',
        url: '/runner/files/s1/abc.png/complete',
        auth: 'Bearer t0k',
        type: 'application/json',
        size: ticketSize,
      },
    ])
  } finally {
    api.close()
  }
})

test('an image that did not arrive whole is sent again, once', async () => {
  const api = await fakeApi(true, 200, [400])
  try {
    await imageStore({ apiUrl: api.apiUrl, token: 't0k' })('s1', 'abc.png', PNG, 'image/png')
    assert.deepEqual(
      api.seen.map((r) => `${r.method} ${r.url}`),
      [
        'POST /runner/files/s1/abc.png/upload',
        'PUT /bucket?sig=1',
        'POST /runner/files/s1/abc.png/complete',
        'POST /runner/files/s1/abc.png/upload',
        'PUT /bucket?sig=1',
        'POST /runner/files/s1/abc.png/complete',
      ],
    )
  } finally {
    api.close()
  }
  const twice = await fakeApi(true, 200, [400, 400])
  try {
    await assert.rejects(
      imageStore({ apiUrl: twice.apiUrl, token: 't0k' })('s1', 'abc.png', PNG, 'image/png'),
      (error: UploadError) => error.status === 400,
    )
  } finally {
    twice.close()
  }
})

test('without R2 it goes through the API, then is checked; a refusal is an error', async () => {
  const api = await fakeApi(false)
  try {
    await imageStore({ apiUrl: api.apiUrl, token: 't0k' })('s1', 'abc.png', PNG, 'image/png')
    assert.deepEqual(api.seen[1], {
      method: 'PUT',
      url: '/runner/files/s1/abc.png',
      auth: 'Bearer t0k',
      type: 'image/png',
      size: PNG.length,
    })
    assert.equal(api.seen[2]!.url, '/runner/files/s1/abc.png/complete')
  } finally {
    api.close()
  }
  const refusing = await fakeApi(true, 403)
  try {
    await assert.rejects(
      imageStore({ apiUrl: refusing.apiUrl, token: 't0k' })('s1', 'abc.png', PNG, 'image/png'),
      /the API refused the upload \(403\)/,
    )
  } finally {
    refusing.close()
  }
})
