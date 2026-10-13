import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DesignEditOp, DesignManifest, designBoards, isSafeAddress } from '../dist/design.js'

test('lays boards out in a row, in their order', () => {
  const manifest = DesignManifest.parse({
    boards: [
      { file: 'index.html', title: 'Home', width: 1440 },
      { file: 'signin.html' },
      { file: 'phone.html', width: 390, height: 844, x: 0, y: 1200 },
      { file: 'next.html', width: 390 },
    ],
  })
  assert.deepEqual(
    designBoards(manifest).map((b) => [b.file, b.x, b.y, b.width, b.height]),
    [
      ['index.html', 0, 0, 1440, undefined],
      ['signin.html', 1520, 0, 1280, undefined],
      ['phone.html', 0, 1200, 390, 844],
      ['next.html', 470, 1200, 390, undefined],
    ],
  )
})

test('leaves out a bad board, not the manifest', () => {
  const manifest = DesignManifest.parse({
    title: 'Pricing',
    viewports: ['desktop', 'mobile'],
    boards: [{ file: '../secret.html' }, { file: 'index.html' }, { file: 'notes.txt' }],
  })
  assert.equal(manifest.title, 'Pricing')
  assert.deepEqual(
    manifest.boards?.map((b) => b.file),
    ['index.html'],
  )
  const broken = DesignManifest.parse({ title: 'Still here', boards: 'nope' })
  assert.equal(broken.title, 'Still here')
  assert.equal(broken.boards, undefined)
})

test('shows a design without boards once per viewport, a deck as one board', () => {
  const page = designBoards(DesignManifest.parse({ viewports: ['desktop', 'mobile'] }))
  assert.deepEqual(
    page.map((b) => [b.file, b.width, b.x]),
    [
      ['index.html', 1280, 0],
      ['index.html', 390, 1360],
    ],
  )
  assert.deepEqual(
    designBoards(null).map((b) => b.width),
    [1280],
  )
  assert.equal(
    designBoards(DesignManifest.parse({ kind: 'slides', viewports: ['mobile'] })).length,
    1,
  )
})

test('takes styles, text and safe attributes', () => {
  for (const op of [
    { id: 3, style: { padding: '24px 16px', color: 'oklch(0.79 0.13 291.74)', margin: null } },
    { id: 3, style: { 'font-family': '"Inter", sans-serif', '--brand': '#7c3aed' } },
    { id: 3, style: { 'background-image': 'url(hero.jpg)' } },
    { id: 0, text: 'Plans & pricing <for teams>' },
    { id: 9, attrs: { href: 'signin.html', alt: 'A "quoted" picture' } },
    { id: 9, attrs: { href: 'https://example.com/a?b=1&c=2', title: null } },
    { id: 9, attrs: { href: 'mailto:hi@example.com' } },
  ])
    assert.equal(DesignEditOp.safeParse(op).success, true, JSON.stringify(op))
})

test('refuses anything that could run script or leave the attribute', () => {
  for (const op of [
    { id: 1, style: { color: 'red; background: blue' } },
    { id: 1, style: { color: 'red</style><script>' } },
    { id: 1, style: { width: 'expression(alert(1))' } },
    { id: 1, style: { 'background-image': 'url(javascript:alert(1))' } },
    { id: 1, style: { 'background-image': 'url(data:image/svg+xml,…)' } },
    { id: 1, style: { Color: 'red' } },
    { id: 1, style: { 'color:red;x': 'blue' } },
    { id: 1, attrs: { onclick: 'alert(1)' } },
    { id: 1, attrs: { style: 'color: red' } },
    { id: 1, attrs: { srcdoc: '<script></script>' } },
    { id: 1, attrs: { href: 'javascript:alert(1)' } },
    { id: 1, attrs: { href: ' JaVa\tScRiPt:alert(1)' } },
    { id: 1, attrs: { href: '&#106;avascript:alert(1)' } },
    { id: 1, attrs: { href: 'javascript&colon;alert(1)' } },
    { id: 1, attrs: { src: 'data:text/html,<script>' } },
    { id: -1, text: 'x' },
  ])
    assert.equal(DesignEditOp.safeParse(op).success, false, JSON.stringify(op))
  assert.equal(isSafeAddress('#pricing'), true)
  assert.equal(isSafeAddress('vbscript:x'), false)
})
