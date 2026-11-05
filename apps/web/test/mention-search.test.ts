import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SearchResult } from '@brigade/contracts'
import {
  foundFor,
  foundThreads,
  searchesThreads,
  searchMentions,
  stillFound,
  withFoundThreads,
  type MentionOption,
} from '../lib/mention-search'

const thread = (id: string, label: string, hint = 'Riley'): MentionOption => ({
  kind: 'thread',
  id,
  label,
  hint,
})
const result = (r: Partial<SearchResult> & Pick<SearchResult, 'kind' | 'id' | 'title'>) =>
  ({ detail: null, snippet: null, threadId: null, pull: null, score: 90, ...r }) as SearchResult

// What the page loaded: the latest threads only, the one the member looks for is older.
const options: MentionOption[] = [
  { kind: 'document', id: 'd1', label: 'Projects/Brigade/structure.md', hint: 'Library' },
  thread('t1', 'Revue des instructions IA Brigade'),
  thread('t2', 'Reconstruction produit Videopal V2'),
  { kind: 'computer', id: 'c1', label: 'Cloud computer struct' },
]

test('an older thread the search finds joins the threads, first when its title starts with the query', () => {
  const shown = searchMentions(options, 'Struct')
  assert.deepEqual(
    shown.map((o) => o.id),
    ['d1', 't1', 't2', 'c1'],
  )
  const found = [thread('t9', 'Structurer les specs techniques du projet'), thread('t1', 'x')]
  assert.deepEqual(
    withFoundThreads(shown, found, 'Struct').map((o) => o.id),
    // The other groups stay where they were; the threads already shown keep their order.
    ['d1', 't9', 't1', 't2', 'c1'],
  )
})

test('a thread shown already is not added twice, and keeps what the menu showed of it', () => {
  const shown = searchMentions(options, 'revue')
  const merged = withFoundThreads(
    shown,
    [thread('t1', 'Revue des instructions IA Brigade', 'Cody')],
    'revue',
  )
  assert.equal(merged, shown)
  assert.equal(merged.find((o) => o.id === 't1')?.hint, 'Riley')
})

test('threads the search found despite a typo or by their summary come after those named, as it ranked them', () => {
  const shown = searchMentions(options, 'instruc')
  const found = [
    thread('t7', 'Instrcutions pour la release', 'Riley'),
    thread('t8', 'Plan de lancement', 'From its summary'),
    thread('t6', 'Instructions des teammates'),
  ]
  assert.deepEqual(
    withFoundThreads(shown, found, 'instruc').map((o) => o.id),
    ['t6', 't1', 't7', 't8'],
  )
})

test('the threads group keeps its size: the best named first', () => {
  const many = [1, 2, 3, 4, 5].map((n) => thread(`r${n}`, `Release notes ${n}`))
  const shown = searchMentions(many, 'notes')
  assert.equal(shown.length, 4)
  const merged = withFoundThreads(shown, [thread('old', 'Notes from the kickoff')], 'notes')
  assert.deepEqual(
    merged.map((o) => o.id),
    ['old', 'r1', 'r2', 'r3'],
  )
})

test('nothing matched here: what the search found is all the menu shows', () => {
  assert.deepEqual(
    withFoundThreads([], [thread('t9', 'Structurer les specs')], 'structurer').map((o) => o.id),
    ['t9'],
  )
})

test("the search's answer becomes the menu's threads: not other kinds, not the thread replied in", () => {
  const found = foundThreads(
    '  Struct ',
    [
      result({ kind: 'thread', id: 't9', title: 'Structurer les specs', detail: 'Riley' }),
      result({ kind: 'thread', id: 'here', title: 'Structure du thread courant', detail: 'Riley' }),
      result({ kind: 'file', id: 'f1', title: 'Projects/Brigade/structure.md' }),
      result({
        kind: 'thread',
        id: 't8',
        title: 'Plan de lancement',
        detail: 'From its summary',
        score: 20,
      }),
    ],
    'here',
  )
  assert.equal(found.query, 'struct')
  assert.deepEqual(found.threads, [
    thread('t9', 'Structurer les specs'),
    thread('t8', 'Plan de lancement', 'From its summary'),
  ])
  assert.ok(foundFor(found, 'STRUCT'))
  assert.ok(!foundFor(found, 'structu'))
  assert.ok(!foundFor(undefined, 'struct'))
})

test('typing on keeps the threads found whose title still holds the query', () => {
  const found = {
    query: 'struct',
    threads: [
      thread('t9', 'Structurer les specs'),
      thread('t8', 'Plan de lancement', 'From its summary'),
    ],
  }
  assert.deepEqual(stillFound(found, 'Struct'), found.threads)
  assert.deepEqual(
    stillFound(found, 'structurer').map((t) => t.id),
    ['t9'],
  )
  assert.deepEqual(stillFound(found, 'release'), [])
  assert.deepEqual(stillFound(undefined, 'struct'), [])
})

test('the search is asked from two characters', () => {
  assert.ok(!searchesThreads(''))
  assert.ok(!searchesThreads(' s '))
  assert.ok(searchesThreads('st'))
})
