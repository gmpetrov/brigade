import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RELEASES, releaseDate } from '../lib/changelog'

test('releases are days, newest first, each once', () => {
  const slugs = RELEASES.map((r) => r.slug)
  for (const slug of slugs) {
    assert.match(slug, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(new Date(`${slug}T00:00:00Z`).toISOString().slice(0, 10), slug, slug)
  }
  assert.deepEqual(slugs, [...new Set(slugs)].sort().reverse())
})

test('every release says something, with its pull requests by number', () => {
  for (const r of RELEASES) {
    assert.ok(r.title && r.summary, r.slug)
    assert.ok(r.sections.length && r.sections.every((s) => s.items.length), r.slug)
    for (const item of r.sections.flatMap((s) => s.items))
      assert.ok(
        (item.prs ?? []).every((n) => Number.isInteger(n) && n > 0),
        item.title,
      )
  }
})

test('a release is dated the same wherever it is built', () => {
  assert.equal(releaseDate('2026-10-29'), 'October 29, 2026')
})
