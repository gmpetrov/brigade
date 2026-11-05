import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SearchResult } from '@brigade/contracts'
import {
  foundFor,
  foundThreads,
  searchesThreads,
  searchMentions,
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
const ids = (items: MentionOption[]) => items.map((o) => o.id)

// What the page loaded: the latest threads only, the one the member looks for is older.
const options: MentionOption[] = [
  { kind: 'document', id: 'd1', label: 'Projects/Brigade/structure.md', hint: 'Library' },
  thread('t1', 'Revue des instructions IA Brigade'),
  thread('t2', 'Reconstruction produit Videopal V2'),
  { kind: 'computer', id: 'c1', label: 'Cloud computer struct' },
]
const releaseNotes = [1, 2, 3, 4].map((n) => thread(`r${n}`, `Release notes ${n}`))

test('an older thread the search finds joins the threads, below those the menu shows', () => {
  const shown = searchMentions(options, 'Struct')
  assert.deepEqual(ids(shown), ['d1', 't1', 't2', 'c1'])
  const found = [thread('t9', 'Structurer les specs techniques du projet'), thread('t1', 'x')]
  assert.deepEqual(ids(withFoundThreads(shown, found, 'Struct')), ['d1', 't1', 't2', 't9', 'c1'])
})

test('nothing the menu shows moves or goes: the row selected is still the one Enter picks', () => {
  // Four recent threads fill the group; the fourth is selected when a better match comes in.
  const shown = searchMentions(releaseNotes, 'notes')
  assert.deepEqual(ids(shown), ['r1', 'r2', 'r3', 'r4'])
  const merged = withFoundThreads(shown, [thread('old', 'Notes from the kickoff')], 'notes')
  assert.deepEqual(ids(merged), ['r1', 'r2', 'r3', 'r4', 'old'])
  shown.forEach((o, i) => assert.equal(merged[i], o))
})

test('an older thread named as typed shows when recent ones fill the group, first of those found', () => {
  const shown = searchMentions(releaseNotes, 'release')
  const found = [
    thread('r2', 'Release notes 2'),
    thread('plan', 'Release plan'),
    thread('typo', 'Relase checklist'),
    thread('old', 'Release'),
  ]
  assert.deepEqual(ids(withFoundThreads(shown, found, 'Release')), [
    'r1',
    'r2',
    'r3',
    'r4',
    'old',
    'plan',
    'typo',
  ])
})

test('among the page’s own, the name typed comes first, then those that start with it', () => {
  const page = [...releaseNotes, thread('beta', 'Beta release'), thread('exact', 'Release')]
  assert.deepEqual(ids(searchMentions(page, 'release')), ['exact', 'r1', 'r2', 'r3'])
})

test('found threads come as named, then as the search ranked them, as many as the group shows', () => {
  const shown = searchMentions(options, 'instruc')
  assert.deepEqual(ids(shown), ['t1'])
  const found = [
    thread('t7', 'Instrcutions pour la release'),
    thread('t8', 'Plan de lancement', 'From its summary'),
    thread('t6', 'Instructions des teammates'),
    thread('t5', 'Les instructions du chief'),
    thread('t4', 'Instructions'),
  ]
  assert.deepEqual(ids(withFoundThreads(shown, found, 'instruc')), ['t1', 't6', 't4', 't5', 't7'])
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

test('nothing matched here: what the search found is all the menu shows', () => {
  assert.deepEqual(
    ids(withFoundThreads([], [thread('t9', 'Structurer les specs')], 'structurer')),
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

test('the search is asked from two characters', () => {
  assert.ok(!searchesThreads(''))
  assert.ok(!searchesThreads(' s '))
  assert.ok(searchesThreads('st'))
})
