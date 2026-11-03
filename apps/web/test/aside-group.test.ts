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

const render = (live: boolean, sides: SideState[] = [settled, { ...settled, messageId: 'm2' }]) =>
  renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(AsideGroup, {
        sides,
        seqs: [42, 57],
        live,
        children: [
          createElement('div', { key: 42, 'data-seq': 42 }, 'Where was the bug?'),
          createElement('div', { key: 57, 'data-seq': 57 }, 'Add a test too'),
        ],
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
