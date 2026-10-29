import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ThreadSummary } from '../lib/api'
import { groupByList, isListRow } from '../lib/list-groups'

const thread = (
  id: string,
  status: string,
  list?: string,
  updatedAt = '2026-10-29T10:00:00.000Z',
) =>
  ({
    id,
    title: id,
    status,
    updatedAt,
    unread: false,
    list: list ? { documentId: list, title: `List ${list}` } : null,
  }) as unknown as ThreadSummary

test("a list's threads go under one row for it, where its first thread was", () => {
  const rows = groupByList([
    thread('a', 'idle'),
    thread('b', 'running', 'L'),
    thread('c', 'idle'),
    thread('d', 'idle', 'L', '2026-10-29T12:00:00.000Z'),
  ])
  assert.deepEqual(
    rows.map((r) => r.id),
    ['a', 'list:L', 'c'],
  )
  const list = rows[1]!
  assert.equal(isListRow(list), true)
  assert.equal(list.title, 'List L')
  assert.deepEqual(
    list.children?.map((c) => c.id),
    ['b', 'd'],
  )
  assert.equal(list.updatedAt, '2026-10-29T12:00:00.000Z')
})

test("a list's row takes its threads' most pressing state", () => {
  const status = (...statuses: string[]) =>
    groupByList(statuses.map((s, i) => thread(`t${i}`, s, 'L')))[0]!.status
  assert.equal(status('idle', 'running', 'waiting'), 'waiting')
  assert.equal(status('idle', 'running'), 'running')
  assert.equal(status('idle', 'failed'), 'failed')
  assert.equal(status('idle', 'done'), 'idle')
})
