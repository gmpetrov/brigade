import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ScheduleOperation } from '../dist/schedules.js'
import {
  ThemeFile,
  themeCssProblem,
  themeFileName,
  themeFilesUsed,
  themeSlug,
  themeUrlAllowed,
  themeValueLoads,
  urlTargets,
} from '../dist/themes.js'

test('a theme loads only its own files, inline images and fonts, or #ids', () => {
  assert.equal(themeUrlAllowed('theme:paper.png'), true)
  assert.equal(themeUrlAllowed('data:image/png;base64,AAAA'), true)
  assert.equal(themeUrlAllowed('data:font/woff2;base64,AAAA'), true)
  assert.equal(themeUrlAllowed('#noise'), true)
  assert.equal(themeUrlAllowed('https://evil.example/x.png'), false)
  assert.equal(themeUrlAllowed('//evil.example/x.png'), false)
  assert.equal(themeUrlAllowed('/api/attachments/1/content'), false)
  assert.equal(themeUrlAllowed('data:text/html,<script>'), false)
  assert.equal(themeUrlAllowed('theme:../x.png'), false)
  assert.equal(themeUrlAllowed('theme:logo.svg'), false)
})

test('the API refuses what loads from elsewhere, with a reason', () => {
  assert.equal(themeCssProblem('body { color: red }'), null)
  assert.equal(themeCssProblem('body { background: url("theme:paper.png") center / cover }'), null)
  assert.equal(themeCssProblem('/* url(https://x.y) */ body { color: red }'), null)
  // Even in a string: the check stays on the safe side.
  assert.match(themeCssProblem('a::after { content: "url(https://x.y)" }'), /not allowed/)
  assert.match(themeCssProblem('@import "https://x.y/a.css";'), /@import/)
  assert.match(themeCssProblem('@IMPORT url(a.css);'), /@import/)
  assert.match(themeCssProblem('body { background: url(https://x.y/p.png) }'), /not allowed/)
  assert.match(themeCssProblem("body { background: url('//x.y/p.png') }"), /not allowed/)
  assert.match(
    themeCssProblem('body { background: image-set("https://x.y/p.png" 1x) }'),
    /image-set/,
  )
  assert.match(themeCssProblem('body { background: -webkit-image-set("p.png" 1x) }'), /image-set/)
  assert.match(themeCssProblem('body { background: \\75 rl(https://x.y) }'), /Backslash/)
  assert.match(themeCssProblem('body { background: url(https://x.y'), /could not be read/)
  assert.match(themeCssProblem('a { --u: attr(href type(<url>)) }'), /attr/)
})

test('a parsed value that could load is refused, escapes included', () => {
  assert.equal(themeValueLoads('url("theme:paper.png")'), false)
  assert.equal(themeValueLoads('linear-gradient(red, blue)'), false)
  assert.equal(themeValueLoads('url("https://x.y/p.png")'), true)
  assert.equal(themeValueLoads('url("theme:paper.png"), url("https://x.y/p.png")'), true)
  assert.equal(themeValueLoads('\\75 rl(x)'), true)
  assert.equal(themeValueLoads('image-set("a.png" 1x)'), true)
  assert.equal(themeValueLoads('src("a.png")'), true)
})

test('url() targets are read in order, quoted or not', () => {
  assert.deepEqual(urlTargets(`url(a.png) URL( "b.png" ) url('c d.png')`), [
    'a.png',
    'b.png',
    'c d.png',
  ])
  assert.equal(urlTargets('url("a.png" x)'), null)
  assert.deepEqual(
    themeFilesUsed('a{background:url(theme:a.png)} b{background:url("theme:a.png")}'),
    ['a.png'],
  )
})

test('a theme file holds colours, never a file', () => {
  assert.ok(ThemeFile.safeParse({ name: 'Paper', canvas: '#f4efe6', accent: '#b4532a' }).success)
  assert.ok(ThemeFile.safeParse({ name: 'X', colors: { primary: 'oklch(0.5 0.2 280)' } }).success)
  assert.equal(
    ThemeFile.safeParse({ name: 'X', colors: { background: 'url(https://x.y/p.png)' } }).success,
    false,
  )
  assert.equal(
    ThemeFile.safeParse({ name: 'X', colors: { background: 'var(--x)' } }).success,
    false,
  )
  assert.equal(ThemeFile.safeParse({ name: 'X', colors: { nope: 'red' } }).success, false)
  assert.equal(ThemeFile.safeParse({ name: 'X', canvas: 'red' }).success, false)
  assert.equal(ThemeFile.safeParse({ name: 'X', radius: '1rem; background: red' }).success, false)
  assert.equal(ThemeFile.safeParse({ name: 'X', font: 'Inter; } body {' }).success, false)
  assert.equal(ThemeFile.safeParse({ name: 'X', extra: 1 }).success, false)
})

test('ids and file names', () => {
  assert.equal(themeSlug('Solarized Dark!'), 'solarized-dark')
  assert.equal(themeSlug('Été ☀'), 'ete')
  assert.equal(themeSlug('none'), 'theme-none')
  assert.equal(themeSlug('★'), 'theme-custom')
  assert.equal(themeFileName('My Paper.PNG'), 'my-paper.png')
  assert.equal(themeFileName('logo.svg'), null)
  assert.equal(themeFileName('noext'), null)
})

test('theme operations travel with the schedule tools', () => {
  assert.equal(ScheduleOperation.parse({ name: 'theme_read' }).name, 'theme_read')
  assert.equal(
    ScheduleOperation.parse({ name: 'theme_set', id: 'paper', theme: { name: 'Paper' } }).name,
    'theme_set',
  )
  assert.equal(
    ScheduleOperation.parse({
      name: 'theme_add_file',
      id: 'paper',
      path: 'a.png',
      upload: { id: 'u1' },
    }).name,
    'theme_add_file',
  )
  assert.equal(ScheduleOperation.parse({ name: 'theme_undo', steps: 2 }).name, 'theme_undo')
  assert.throws(() => ScheduleOperation.parse({ name: 'theme_undo', steps: 0 }))
})
