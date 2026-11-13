import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkedOn, COMPARISONS } from '../lib/compare'
import { isPublicPage } from '../lib/public-pages'

const web = join(import.meta.dirname, '..')

test('each comparison has a unique slug and a public page', () => {
  const slugs = COMPARISONS.map((x) => x.slug)
  assert.equal(new Set(slugs).size, slugs.length)
  for (const slug of slugs) {
    assert.match(slug, /^[a-z0-9-]+$/)
    assert.equal(isPublicPage(`/compare/${slug}`), true, slug)
  }
})

test('each comparison shows its logo, its sources and the day they were checked', () => {
  for (const x of COMPARISONS) {
    for (const logo of x.logos)
      if ('src' in logo)
        assert.ok(existsSync(join(web, 'public', logo.src)), `${x.slug}: ${logo.src} is missing`)
    assert.ok(x.sources.length > 0, `${x.slug} has no sources`)
    for (const s of x.sources) assert.match(s.url, /^https:\/\//, `${x.slug}: ${s.url}`)
    assert.match(checkedOn(x), /^[A-Z][a-z]+ \d{1,2}, \d{4}$/, x.slug)
    assert.ok(x.rows.length > 0 && x.pickBrigade.length > 0 && x.pickThem.length > 0, x.slug)
  }
})

test('the README lists every comparison', () => {
  const readme = readFileSync(join(web, '..', '..', 'README.md'), 'utf8')
  for (const x of COMPARISONS)
    assert.ok(
      readme.includes(`(https://www.brigade.lol/compare/${x.slug})`),
      `README.md has no link to /compare/${x.slug}`,
    )
})
