import assert from 'node:assert/strict'
import { test } from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AsideGroup, type SideState } from '../components/aside-group'
import { TooltipProvider } from '../components/ui/tooltip'
import { onRevealSeq, revealSeq } from '../lib/reveal'

// The component's JSX compiles to React.createElement here.
Object.assign(globalThis, { React })

const settled: SideState = { messageId: 'm1', status: 'answered', route: 'answer', text: 'Yes.' }

const TEXTS = ['Where was the bug?', 'Add a test too', 'And the cache?']
const SEQS = [42, 57, 63]

const render = (
  live: boolean,
  sides: SideState[] = [settled, { ...settled, messageId: 'm2' }],
  quiet = false,
) =>
  renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(AsideGroup, {
        sides,
        seqs: SEQS.slice(0, sides.length),
        live,
        quiet,
        children: sides.map((_, i) =>
          createElement('div', { key: SEQS[i], 'data-seq': SEQS[i] }, TEXTS[i]),
        ),
      }),
    ),
  )

test('while its turn runs, the aside shows its messages', () => {
  const html = render(true)
  assert.match(html, /Where was the bug\?/)
  assert.equal(html.match(/data-seq="42"/g)?.length, 1)
})

test('folded once the turn ended, its line still stands for each message, for a quote or the timeline to go to', () => {
  const html = render(false)
  assert.doesNotMatch(html, /Where was the bug\?/)
  assert.match(html, /2 messages/)
  assert.match(html, /data-seq="42"/)
  assert.match(html, /data-seq="57"/)
})

test('one whose reply is still coming keeps it open after the turn', () => {
  const html = render(false, [settled, { messageId: 'm2', status: 'answering' }])
  assert.match(html, /Add a test too/)
  assert.equal(html.match(/data-seq="57"/g)?.length, 1)
})

test('going to a message asks what folds it to open', () => {
  Object.assign(globalThis, { window: new EventTarget() })
  const asked: number[] = []
  const stop = onRevealSeq((seq) => asked.push(seq))
  revealSeq(57)
  stop()
  revealSeq(42)
  assert.deepEqual(asked, [57])
})

test('while its turn runs, it shows the latest two exchanges, the earlier one folded where it is', () => {
  const html = render(true, [
    settled,
    { ...settled, messageId: 'm2' },
    { ...settled, messageId: 'm3' },
  ])
  assert.doesNotMatch(html, /Where was the bug\?/)
  assert.match(html, /1 earlier exchange/)
  assert.match(html, /Add a test too/)
  assert.match(html, /And the cache\?/)
  // The folded one still has its place, for a quote or the timeline to go to.
  assert.equal(html.match(/data-seq="42"/g)?.length, 1)
})

test('once the turn wrote again, every reply in, it folds to a line while the turn runs', () => {
  const html = render(true, undefined, true)
  assert.doesNotMatch(html, /Where was the bug\?/)
  assert.match(html, /2 messages/)
  assert.match(html, /data-seq="57"/)
})

test('a reply still coming keeps it open though the turn wrote again', () => {
  const html = render(true, [settled, { messageId: 'm2', status: 'answering' }], true)
  assert.match(html, /Add a test too/)
})
