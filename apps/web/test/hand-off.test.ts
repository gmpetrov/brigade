import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handToThread } from '../lib/hand-off'

const file = { id: 'doc1', path: 'Projects/Acme/launch.md' }
const items = [{ id: 'aaaaaaaaaaaaaaaa', text: 'Write public docs' }]
const note = 'Done means a quickstart and runnable examples.'

test('lines handed to a running thread are attached quietly, then sent as the person’s message', async () => {
  const calls: { path: string; body: Record<string, unknown> }[] = []
  await handToThread(
    async (path, init) => void calls.push({ path, body: init.body as Record<string, unknown> }),
    file,
    'thread1',
    items,
    note,
  )
  assert.deepEqual(
    calls.map((c) => c.path),
    ['/lists/doc1/link', '/threads/thread1/messages'],
  )
  assert.equal(calls[0]!.body.quiet, true)
  assert.equal(calls[1]!.body.text, `${note}\n\n- Write public docs`)
})

test('when the message can’t go, the note that stands in keeps what the person added', async () => {
  const calls: { path: string; body: Record<string, unknown> }[] = []
  await assert.rejects(
    handToThread(
      async (path, init) => {
        calls.push({ path, body: init.body as Record<string, unknown> })
        if (path.endsWith('/messages')) throw new Error('Approve or deny the pending request first')
      },
      file,
      'thread1',
      items,
      `  ${note} `,
    ),
    /could not start on them now: Approve or deny the pending request first/,
  )
  const fallback = calls.at(-1)!
  assert.equal(fallback.path, '/lists/doc1/link')
  assert.equal(fallback.body.quiet, undefined)
  assert.equal(fallback.body.note, note)
})
