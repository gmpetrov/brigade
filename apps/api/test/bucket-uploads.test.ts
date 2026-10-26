import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { strToU8, zipSync } from 'fflate'

// The pieces every upload straight to the bucket goes through (bucket.ts, object-check.ts):
// the stand-in a client PUTs to without R2, the copy inside the bucket, and the check that
// reads an object back as it streams. Without R2, in a folder of the test's own; nothing
// here reaches a database.
process.env.DATABASE_URL ??= 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
process.env.BUCKET_DIR = await mkdtemp(join(tmpdir(), 'bucket-uploads-'))
const { copyObject, objectSize, putObject, readHead, uploadTarget } =
  await import('../src/bucket.js')
const { inspectObject } = await import('../src/object-check.js')
const { localBucket } = await import('../src/routes/bucket.js')
const { Hono } = await import('hono')

const app = new Hono().route('/api/bucket', localBucket)
const put = (url: string, body: Uint8Array, headers: Record<string, string> = {}) =>
  app.request(url, {
    method: 'PUT',
    body,
    headers: { 'content-length': String(body.byteLength), ...headers },
  })
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

test('without R2, a client PUTs to the signed path of the stand-in, exactly the signed size', async () => {
  const bytes = strToU8('hello, bucket')
  const target = await uploadTarget('org/ws/uploads/a1', bytes.byteLength, 'text/plain')
  assert.match(target.url, /^\/api\/bucket\?/)
  assert.equal(target.headers['content-type'], 'text/plain')
  assert.equal((await put(target.url, bytes)).status, 200)
  assert.deepEqual(
    new Uint8Array(await readFile(join(process.env.BUCKET_DIR!, 'org/ws/uploads/a1'))),
    bytes,
  )
  // More or fewer bytes than signed for: refused, and the object keeps what it held.
  assert.equal((await put(target.url, strToU8('hello, bucket!'))).status, 400)
  assert.equal((await put(target.url, strToU8('hello'))).status, 400)
  assert.equal(await objectSize('org/ws/uploads/a1'), bytes.byteLength)
})

test('a path whose signature, key or size was changed, or that expired, is refused', async () => {
  const target = await uploadTarget('org/ws/uploads/a2', 3, 'text/plain')
  const url = new URL(target.url, 'http://api')
  const tampered = (name: string, value: string) => {
    const changed = new URL(url)
    changed.searchParams.set(name, value)
    return `${changed.pathname}${changed.search}`
  }
  assert.equal((await put(tampered('key', 'org/ws/library/x'), strToU8('abc'))).status, 403)
  assert.equal((await put(tampered('size', '4'), strToU8('abcd'))).status, 403)
  assert.equal((await put(tampered('sig', '00'.repeat(32)), strToU8('abc'))).status, 403)
  assert.equal((await put(tampered('expires', '1'), strToU8('abc'))).status, 403)
  assert.equal(await objectSize('org/ws/library/x'), null)
})

test('an object is copied inside the bucket; a missing one is false', async () => {
  await putObject('org/ws/uploads/c1', strToU8('copied'), 'text/plain')
  assert.equal(await copyObject('org/ws/uploads/c1', 'org/ws/library/d1', 'text/plain'), true)
  assert.equal(new TextDecoder().decode((await readHead('org/ws/library/d1', 100))!), 'copied')
  assert.equal(await copyObject('org/ws/uploads/none', 'org/ws/library/d2'), false)
  assert.equal(await readHead('org/ws/library/d2', 10), null)
})

test('a check reads size, SHA-256, the real type and the text as the object streams', async () => {
  const text = strToU8('# Refunds\n\nWithin 30 days, café.')
  await putObject('org/ws/uploads/t1', text, 'text/markdown')
  const read = await inspectObject('org/ws/uploads/t1', { name: 'refunds.md', text: true })
  assert.equal(read?.size, text.byteLength)
  assert.equal(read?.sha256, sha(text))
  assert.equal(read?.contentType, 'text/markdown')
  assert.equal(read?.text, '# Refunds\n\nWithin 30 days, café.')
  // Text only when asked for.
  assert.equal((await inspectObject('org/ws/uploads/t1', { name: 'refunds.md' }))?.text, '')

  // A file that claims a type shown inline must be one.
  await putObject('org/ws/uploads/p1', strToU8('<script>alert(1)</script>'), 'image/png')
  const fake = await inspectObject('org/ws/uploads/p1', { name: 'shot.png' })
  assert.equal(fake?.contentType, 'application/octet-stream')
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  await putObject('org/ws/uploads/p2', png, 'image/png')
  assert.equal(
    (await inspectObject('org/ws/uploads/p2', { name: 'shot.png' }))?.contentType,
    'image/png',
  )

  // Not UTF-8: kept, not searchable.
  await putObject('org/ws/uploads/b1', new Uint8Array([0xff, 0xfe, 0x41]), 'text/plain')
  assert.equal((await inspectObject('org/ws/uploads/b1', { name: 'a.txt', text: true }))?.text, '')

  assert.equal(await inspectObject('org/ws/uploads/none', { name: 'a.txt' }), null)
})

test('a check stops once more bytes came than allowed', async () => {
  await putObject('org/ws/uploads/m1', new Uint8Array(5000), 'application/octet-stream')
  const read = await inspectObject('org/ws/uploads/m1', { name: 'a.bin', max: 1000 })
  assert.ok(read && read.size > 1000)
})

test("an Office file's text is read from its XML parts as they unzip, at any size", async () => {
  const docx = zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(
      '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Quarterly</w:t></w:r><w:r><w:t xml:space="preserve"> plan &amp; budget</w:t></w:r></w:p>' +
        `<w:p><w:r><w:t>${'word '.repeat(50_000)}</w:t></w:r></w:p><w:p><w:r><w:t>The end</w:t></w:r></w:p></w:body></w:document>`,
    ),
    // Bytes no text is in: never inflated for it.
    'word/media/image1.png': new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 7919) % 251),
  })
  await putObject('org/ws/uploads/o1', docx, 'application/octet-stream')
  const read = await inspectObject('org/ws/uploads/o1', { name: 'plan.docx', text: true })
  assert.equal(read?.sha256, sha(docx))
  assert.ok(read?.text.startsWith('Quarterly plan & budget\n'))
  assert.ok(read?.text.endsWith('The end'))

  const xlsx = zipSync({
    'xl/sharedStrings.xml': strToU8('<sst><si><t>Revenue</t></si><si><t>Costs</t></si></sst>'),
    'xl/worksheets/sheet1.xml': strToU8(
      '<worksheet><sheetData><row><c t="inlineStr"><is><t>Q3</t></is></c></row></sheetData></worksheet>',
    ),
  })
  await putObject('org/ws/uploads/o2', xlsx, 'application/octet-stream')
  const sheet = await inspectObject('org/ws/uploads/o2', { name: 'numbers.xlsx', text: true })
  assert.deepEqual(sheet?.text.split(/\s+/), ['Revenue', 'Costs', 'Q3'])

  // A damaged one, and a PDF (whose text needs the whole file): kept, not searchable.
  await putObject('org/ws/uploads/o3', docx.subarray(0, 2000), 'application/octet-stream')
  assert.equal(
    (await inspectObject('org/ws/uploads/o3', { name: 'cut.docx', text: true }))?.text,
    '',
  )
  await putObject('org/ws/uploads/o4', strToU8('%PDF-1.7\nhello'), 'application/pdf')
  const pdf = await inspectObject('org/ws/uploads/o4', { name: 'a.pdf', text: true })
  assert.equal(pdf?.contentType, 'application/pdf')
  assert.equal(pdf?.text, '')
})

test('an Office file that inflates far past its size is read a little at a time, and stops', async () => {
  // 128 MiB of text in one run, a few hundred kB compressed.
  // Built by hand: the long run, deflated as it is made, never whole in this test either.
  const { Zip, ZipDeflate } = await import('fflate')
  const chunks: Uint8Array[] = []
  const zip = new Zip((error, data) => {
    if (error) throw error
    chunks.push(data)
  })
  const part = new ZipDeflate('word/document.xml', { level: 9 })
  zip.add(part)
  part.push(strToU8('<w:document><w:body><w:p><w:r><w:t>'))
  const block = new Uint8Array(1024 * 1024).fill(0x61)
  for (let i = 0; i < 128; i++) part.push(block)
  part.push(strToU8('</w:t></w:r></w:p></w:body></w:document>'), true)
  zip.end()
  const bomb = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
  let at = 0
  for (const c of chunks) {
    bomb.set(c, at)
    at += c.byteLength
  }
  assert.ok(bomb.byteLength < 1024 * 1024)
  await putObject('org/ws/uploads/bomb', bomb, 'application/octet-stream')
  // Run with --expose-gc (the package's test script): what came before is not counted.
  global.gc?.()
  const before = process.memoryUsage().rss
  const read = await inspectObject('org/ws/uploads/bomb', { name: 'bomb.docx', text: true })
  const grew = process.memoryUsage().rss - before
  assert.equal(read?.size, bomb.byteLength)
  assert.ok((read?.text.length ?? 0) <= 400_000)
  // Far less than the 128 MiB it inflates to (the old way held it all, and more).
  if (global.gc) assert.ok(grew < 48 * 1024 * 1024, `grew by ${Math.round(grew / 1024 / 1024)} MB`)
})

test("an Office file's media and other parts are passed over, none of their bytes held", async () => {
  const { Unzip } = await import('fflate')
  const media = new Uint8Array(24 * 1024 * 1024).fill(0x61)
  for (const level of [0, 6] as const) {
    const doc = zipSync(
      {
        'word/media/photo.png': media,
        'word/document.xml': strToU8('<w:p><w:r><w:t>hello</w:t></w:r></w:p>'),
      },
      { level },
    )
    await putObject('org/ws/uploads/skip', doc, 'application/octet-stream')
    // What Unzip keeps for entries not started yet (its own `k`), at its largest.
    const push = Unzip.prototype.push
    let held = 0
    Unzip.prototype.push = function (chunk, final) {
      const out = push.call(this, chunk, final)
      const waiting = (this as unknown as { k: Uint8Array[][] }).k
      held = Math.max(
        held,
        waiting.flat().reduce((n, c) => n + c.byteLength, 0),
      )
      return out
    }
    try {
      const read = await inspectObject('org/ws/uploads/skip', { name: 'media.docx', text: true })
      assert.equal(read?.text, 'hello')
      assert.equal(held, 0)
    } finally {
      Unzip.prototype.push = push
    }
  }
})
