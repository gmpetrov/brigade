import assert from 'node:assert/strict'
import { test } from 'node:test'
import { googleDocs, googleDrive, googleSheets } from '../src/connectors/google-drive.js'
import type { ConnectorContext } from '../src/connectors/types.js'

type Call = { url: string; method: string; body?: string; type?: string }

/** A context whose fetch answers from `routes` (first match by URL prefix) and records each call. */
function fake(routes: [string, (call: Call) => Response][]) {
  const calls: Call[] = []
  const ctx: ConnectorContext = {
    callId: 'call-1',
    fetch: async (url, init) => {
      const body =
        init?.body === undefined
          ? undefined
          : typeof init.body === 'string'
            ? init.body
            : Buffer.from(init.body as Uint8Array).toString()
      const call = {
        url,
        method: init?.method ?? 'GET',
        body,
        type: (init?.headers as Record<string, string> | undefined)?.['content-type'],
      }
      calls.push(call)
      const route = routes.find(([prefix]) => url.startsWith(prefix))
      if (!route) throw new Error(`unexpected ${url}`)
      return route[1](call)
    },
    keepFile: async (f) =>
      ({
        id: 'a1',
        name: f.name,
        contentType: f.contentType,
        size: (await f.bytes()).byteLength,
        status: 'ready',
        path: `files/${f.name}`,
      }) as never,
    readFile: async () => ({
      name: 'notes.md',
      contentType: 'text/plain',
      bytes: new TextEncoder().encode('# Hello'),
    }),
  }
  return { ctx, calls }
}

const ok = (body: unknown) => Response.json(body)
const run = (name: string, ctx: ConnectorContext, input: unknown) => {
  const operation = (googleDrive.operations[name] ??
    googleDocs.operations[name] ??
    googleSheets.operations[name])!
  return operation.run(ctx, operation.input.parse(input))
}

test('search turns words and a type into a Drive query across shared drives', async () => {
  const { ctx, calls } = fake([
    [
      'https://www.googleapis.com/drive/v3/files?',
      () => ok({ files: [{ id: 'f1', name: 'Q3 budget' }] }),
    ],
  ])
  const result = (await run('drive_search', ctx, { text: "Q3 'budget'", type: 'spreadsheet' })) as {
    files: { id: string }[]
  }
  assert.equal(result.files[0]!.id, 'f1')
  const params = new URL(calls[0]!.url).searchParams
  assert.equal(
    params.get('q'),
    "fullText contains 'Q3 \\'budget\\'' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
  )
  assert.equal(params.get('corpora'), 'allDrives')
  // Drive refuses orderBy with a fullText search.
  assert.equal(params.get('orderBy'), null)
})

test('a Google Doc reads as Markdown, a binary file is refused', async () => {
  const { ctx, calls } = fake([
    [
      'https://www.googleapis.com/drive/v3/files/doc1/export',
      () => new Response('# Title\n\nBody'),
    ],
    [
      'https://www.googleapis.com/drive/v3/files/doc1?',
      () => ok({ id: 'doc1', name: 'Plan', mimeType: 'application/vnd.google-apps.document' }),
    ],
    [
      'https://www.googleapis.com/drive/v3/files/pdf1?',
      () => ok({ id: 'pdf1', name: 'a.pdf', mimeType: 'application/pdf' }),
    ],
  ])
  const doc = (await run('drive_read_file', ctx, { fileId: 'doc1' })) as { content: string }
  assert.equal(doc.content, '# Title\n\nBody')
  assert.match(calls[1]!.url, /mimeType=text%2Fmarkdown/)
  await assert.rejects(run('drive_read_file', ctx, { fileId: 'pdf1' }), /drive_download_file/)
})

test('a Sheet downloads as xlsx by default, named after it', async () => {
  const { ctx } = fake([
    ['https://www.googleapis.com/drive/v3/files/s1/export', () => new Response('xlsx-bytes')],
    [
      'https://www.googleapis.com/drive/v3/files/s1?',
      () =>
        ok({
          id: 's1',
          name: 'Leads',
          mimeType: 'application/vnd.google-apps.spreadsheet',
          modifiedTime: '2026-10-17T10:00:00Z',
        }),
    ],
  ])
  const result = (await run('drive_download_file', ctx, { fileId: 's1' })) as {
    name: string
    file: string
  }
  assert.equal(result.name, 'Leads.xlsx')
  await assert.rejects(run('drive_download_file', ctx, { fileId: 's1', format: 'docx' }), /xlsx/)
})

test('uploading Markdown with convert makes a Google Doc', async () => {
  const { ctx, calls } = fake([
    ['https://www.googleapis.com/upload/drive/v3/files', () => ok({ id: 'new1', name: 'notes' })],
  ])
  await run('drive_upload_file', ctx, { file: 'att-1', convert: true, folderId: 'folder1' })
  const call = calls[0]!
  assert.match(call.url, /uploadType=multipart/)
  assert.match(call.type!, /^multipart\/related; boundary=/)
  const metadata = JSON.parse(call.body!.split('\r\n\r\n')[1]!.split('\r\n')[0]!)
  assert.deepEqual(metadata, {
    name: 'notes',
    mimeType: 'application/vnd.google-apps.document',
    parents: ['folder1'],
  })
  assert.match(call.body!, /Content-Type: text\/markdown\r\n\r\n# Hello/)
})

test('text goes in at the end of a document by default', async () => {
  const { ctx, calls } = fake([
    ['https://docs.googleapis.com/v1/documents/d1:batchUpdate', () => ok({})],
    [
      'https://docs.googleapis.com/v1/documents/d1?',
      () => ok({ body: { content: [{ endIndex: 1 }, { endIndex: 42 }] } }),
    ],
  ])
  const result = (await run('docs_insert_text', ctx, { documentId: 'd1', text: 'More' })) as {
    insertedAt: number
  }
  assert.equal(result.insertedAt, 41)
  assert.deepEqual(JSON.parse(calls[1]!.body!), {
    requests: [{ insertText: { location: { index: 41 }, text: 'More' } }],
  })
})

test('sheet writes are typed as a person would, and each tool says whether it writes', async () => {
  const { ctx, calls } = fake([
    [
      'https://sheets.googleapis.com/v4/spreadsheets/s1/values/',
      () => ok({ updates: { updatedRange: 'Sheet1!A5:B5', updatedRows: 1 } }),
    ],
  ])
  await run('sheets_append_rows', ctx, {
    spreadsheetId: 's1',
    range: 'Sheet1!A:B',
    values: [['Ada', '=1+1']],
  })
  assert.match(calls[0]!.url, /Sheet1!A%3AB:append\?valueInputOption=USER_ENTERED/)

  // Three Apps, each with only its own product's tools.
  for (const [app, prefix] of [
    [googleDrive, 'drive_'],
    [googleDocs, 'docs_'],
    [googleSheets, 'sheets_'],
  ] as const)
    assert.ok(Object.keys(app.operations).every((name) => name.startsWith(prefix)))
  const ops = [googleDrive, googleDocs, googleSheets].flatMap((app) =>
    Object.entries(app.operations),
  )
  const reads = ops.filter(([, o]) => !o.write).map(([name]) => name)
  assert.ok(reads.includes('drive_search') && reads.includes('sheets_read_range'))
  assert.ok(
    !reads.some((name) =>
      /upload|create|update|insert|replace|append|clear|trash|share|copy/.test(name),
    ),
  )
  assert.equal(googleDrive.operations.drive_upload_file!.files, 'file')
})
