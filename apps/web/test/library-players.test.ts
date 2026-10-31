import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import { playedFiles, type PlayedFile } from '../lib/played-files'

// The blocks react-markdown renders, with what each would play (as components/markdown.tsx
// renders them): `document:` links kept, as its urlTransform keeps them.
function played(text: string) {
  const blocks: { tag: string; files: PlayedFile[] }[] = []
  const block =
    (tag: 'p' | 'li') =>
    ({ node, children }: { node?: unknown; children?: ReactNode }) => {
      blocks.push({ tag, files: playedFiles(node as Parameters<typeof playedFiles>[0]) })
      return createElement(tag, null, children)
    }
  renderToStaticMarkup(
    createElement(ReactMarkdown, {
      components: { p: block('p'), li: block('li') },
      urlTransform: (url: string) => url,
      children: text.replace(/@\[([^\]\n]+)\]\(([^)\s]+)\)/g, '[$1]($2)'),
    }),
  )
  return blocks.filter((b) => b.files.length > 0)
}

test('a library video or sound a paragraph mentions plays under it, once', () => {
  assert.deepEqual(
    played(
      'Film @[Projects/demo.mp4](document:f1), voice @[a/voice.mp3](document:v1), ' +
        'notes @[a/notes.md](document:n1), and **again @[Projects/demo.mp4](document:f1)**.',
    ),
    [
      {
        tag: 'p',
        files: [
          { id: 'f1', name: 'Projects/demo.mp4', kind: 'video' },
          { id: 'v1', name: 'a/voice.mp3', kind: 'audio' },
        ],
      },
    ],
  )
})

test("in a list, the item that names it plays it, not the list's other items", () => {
  assert.deepEqual(played('- first\n- the film @[a/F.MOV](document:f2)\n'), [
    { tag: 'li', files: [{ id: 'f2', name: 'a/F.MOV', kind: 'video' }] },
  ])
  // A loose list's item holds a paragraph, which plays it: the item does not too.
  assert.deepEqual(played('- first\n\n- the film @[a/f.webm](document:f3)\n'), [
    { tag: 'p', files: [{ id: 'f3', name: 'a/f.webm', kind: 'video' }] },
  ])
})

test('a link that is no library mention, or a mention in code, plays nothing', () => {
  assert.deepEqual(
    played(
      'See [the film](https://example.com/f.mp4), `@[a/f.mp4](document:x)` and @[f.mp4](email:m1).',
    ),
    [],
  )
})

test('a library image or a design a paragraph mentions shows under it, once', () => {
  assert.deepEqual(
    played(
      'Shot @[Projects/a/shot.PNG](document:i1), the page @[Projects/home.design](design:Projects/home.design/), ' +
        'a doc @[a/notes.pdf](document:n1) and the shot again @[Projects/a/shot.PNG](document:i1).',
    ),
    [
      {
        tag: 'p',
        files: [
          { id: 'i1', name: 'Projects/a/shot.PNG', kind: 'image' },
          { id: 'Projects/home.design', name: 'Projects/home.design', kind: 'design' },
        ],
      },
    ],
  )
})

test('a design system or a project shows nothing under the text', () => {
  assert.deepEqual(played('Follow @[Acme](design-system:Brand/acme) in @[Web](project:p1).'), [])
})
