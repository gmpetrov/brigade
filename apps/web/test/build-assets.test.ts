import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAssets } from '../lib/build-assets'

test("a page's scripts and stylesheets, each once, in order", () => {
  const html = `<!DOCTYPE html><html><head>
    <link rel="stylesheet" href="/_next/static/css/a1b2.css" data-precedence="next"/>
    <link rel="preload" as="script" fetchPriority="low" href="/_next/static/chunks/webpack-9f.js"/>
    <script src="/_next/static/chunks/main-app-3c.js" async=""></script>
    <script src="/_next/static/chunks/webpack-9f.js" async=""></script>
    <script src="/_next/static/chunks/app/page-77.js?dpl=abc" async=""></script>
  </head></html>`
  assert.deepEqual(buildAssets(html), [
    '/_next/static/css/a1b2.css',
    '/_next/static/chunks/webpack-9f.js',
    '/_next/static/chunks/main-app-3c.js',
    '/_next/static/chunks/app/page-77.js',
  ])
})

test('leaves out what is not a build file', () => {
  const html = `<link rel="icon" href="/icons/icon.svg"/>
    <img src="/_next/static/media/logo.png"/>
    <script src="https://us.i.posthog.com/static/array.js"></script>
    <a href="/app/threads">Threads</a>`
  assert.deepEqual(buildAssets(html), [])
})
