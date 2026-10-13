import assert from 'node:assert/strict'
import { test } from 'node:test'
import { annotate, applyEdits, EditError, elementsOf, fingerprint } from '../src/design-source.js'

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Pricing</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>body { margin: 0 }</style>
</head>
<body class="bg-white">
<header class="flex gap-4" style="padding: 24px; color: #111">
  <h1 data-id="title">Plans 🚀 &amp; pricing</h1>
  <a href="signin.html">Sign in</a>
</header>
<ul id="plans"><li>Free<li>Pro</ul>
<svg viewBox="0 0 24 24"><path d="M0 0h24"/></svg>
<template><p>never shown</p></template>
<table><tr><td>Cell</td></tr></table>
<p>One <b>bold</b> word</p>
<script>document.getElementById('plans').innerHTML += '<li>Team</li>'</script>
</body>
</html>
`

const ids = (html: string) => elementsOf(html).map((e) => `${e.id}:${e.tag}`)

test('numbers the elements written in the body, not the head, implied ones or what is never shown', () => {
  assert.deepEqual(ids(PAGE), [
    '0:header',
    '1:h1',
    '2:a',
    '3:ul',
    '4:li',
    '5:li',
    '6:svg',
    '7:table',
    '8:tr',
    '9:td',
    '10:p',
    '11:b',
  ])
})

test('annotates each element in place, changing nothing else', () => {
  const annotated = annotate(PAGE)
  assert.match(annotated, /<header data-bid="0:10:[0-9a-z]+" class="flex gap-4"/)
  assert.match(
    annotated,
    /<h1 data-bid="1:11:[0-9a-z]+" data-id="title">Plans 🚀 &amp; pricing<\/h1>/,
  )
  assert.match(annotated, /<li data-bid="4:14:[0-9a-z]+">Free<li data-bid="5:14:/)
  assert.match(annotated, /<path d="M0 0h24"\/>/)
  assert.equal(annotated.replace(/ data-bid="[^"]*"/g, ''), PAGE)
  // The fingerprint is of the text as the page shows it.
  assert.ok(annotated.includes(`1:11:${fingerprint('Plans 🚀 & pricing')}"`))
})

test('rebuilt formatting elements are numbered once', () => {
  assert.deepEqual(ids('<body><p><b>x<p>y</b></p></body>'), ['0:p', '1:b', '2:p'])
})

test('sets and removes inline styles, keeping the rest of the tag', () => {
  const out = applyEdits(PAGE, [
    { id: 0, style: { padding: '32px 16px', color: null, 'font-family': '"Inter", sans-serif' } },
    { id: 1, style: { 'font-size': '48px' } },
  ])
  assert.ok(
    out.includes(
      '<header class="flex gap-4" style="padding: 32px 16px; font-family: &quot;Inter&quot;, sans-serif">',
    ),
  )
  assert.ok(out.includes('<h1 style="font-size: 48px" data-id="title">'))
  const cleared = applyEdits(out, [{ id: 1, style: { 'font-size': null } }])
  assert.ok(cleared.includes('<h1 data-id="title">'))
})

test('retypes text, escaped, after emoji and entities', () => {
  const out = applyEdits(PAGE, [{ id: 1, text: 'Plans <for> teams & you' }])
  assert.ok(out.includes('<h1 data-id="title">Plans &lt;for&gt; teams &amp; you</h1>'))
  assert.ok(out.includes('<a href="signin.html">Sign in</a>'))
})

test('refuses to retype what holds other elements or has no end tag', () => {
  assert.throws(() => applyEdits(PAGE, [{ id: 10, text: 'x' }]), EditError)
  assert.throws(() => applyEdits(PAGE, [{ id: 4, text: 'x' }]), EditError)
  assert.throws(() => applyEdits(PAGE, [{ id: 99, text: 'x' }]), EditError)
})

test('changes, adds and removes attributes, double-quoted and escaped', () => {
  const out = applyEdits(PAGE, [
    { id: 2, attrs: { href: 'https://example.com/?a=1&b="2"', title: 'Go' } },
    { id: 3, attrs: { 'aria-label': 'Plans' } },
  ])
  assert.ok(out.includes('<a title="Go" href="https://example.com/?a=1&amp;b=&quot;2&quot;">'))
  assert.ok(out.includes('<ul aria-label="Plans" id="plans">'))
  const removed = applyEdits(out, [{ id: 2, attrs: { title: null } }])
  assert.ok(removed.includes('<a href="https://example.com/'))
})

test('several changes to one element, and to many, in one go', () => {
  const out = applyEdits(PAGE, [
    { id: 1, style: { color: 'red' } },
    { id: 1, style: { margin: '0' } },
    { id: 1, text: 'Pricing' },
    { id: 0, attrs: { title: 'Top' } },
  ])
  assert.ok(out.includes('<header title="Top" class="flex gap-4"'))
  assert.ok(out.includes('<h1 style="color: red; margin: 0" data-id="title">Pricing</h1>'))
  // The numbering holds after the edit: the same elements, the same ids.
  assert.deepEqual(ids(out), ids(PAGE))
})
