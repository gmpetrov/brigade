// The selectors a theme can rely on (THEME_HOOKS, docs/themes.md) are still in the dashboard:
// removing one breaks people's themes, so it must be on purpose, with the list changed too.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { THEME_HOOKS } from '@brigade/contracts'

const ROOT = join(import.meta.dirname, '..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (name === 'node_modules' || name.startsWith('.')) return []
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) ? [readFileSync(path, 'utf8')] : []
  })
}

const code = [...sources(join(ROOT, 'app')), ...sources(join(ROOT, 'components'))].join('\n')

test('every stable selector is still in the dashboard', () => {
  for (const hook of THEME_HOOKS)
    for (const [, attribute, value] of hook.selector.matchAll(/\[(data-[a-z-]+)="([a-z-]+)"\]/g))
      assert.ok(
        code.includes(`${attribute}="${value}"`),
        `${attribute}="${value}" (${hook.what}) left the dashboard: themes use it`,
      )
})
