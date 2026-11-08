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

test('from v0.4.0, every release has a version, each above the one before', () => {
  // Above as numbers, part by part: 0.10.0 comes after 0.9.0.
  const newer = (a: string, b: string) => {
    const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)]
    const i = x.findIndex((n, j) => n !== y[j])
    return i >= 0 && (x[i] ?? 0) > (y[i] ?? 0)
  }
  const first = RELEASES.findLastIndex((r) => r.version === '0.4.0')
  assert.ok(first >= 0, 'v0.4.0 is a release')
  const versioned = RELEASES.slice(0, first + 1)
  for (const r of versioned) assert.match(r.version ?? '', /^\d+\.\d+\.\d+$/, r.slug)
  versioned.slice(1).forEach((older, i) => {
    const later = versioned[i]
    assert.ok(later && newer(later.version ?? '', older.version ?? ''), later?.slug)
  })
  assert.ok(
    RELEASES.slice(first + 1).every((r) => !r.version),
    'releases before v0.4.0 have none',
  )
})

test("the newest release carries the product's version", async () => {
  const { readFile } = await import('node:fs/promises')
  const pkg = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'))
  assert.equal(RELEASES[0]?.version, pkg.version)
})
