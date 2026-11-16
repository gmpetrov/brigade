// Loading the worn theme (lib/theme-runtime's themeLoader): only the latest answer is worn.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WornTheme } from '@brigade/contracts'
import { invalidateThemeLoads, themeLoader } from '../lib/theme-runtime'

const worn = (name: string): WornTheme => ({
  id: name,
  theme: { name },
  files: {},
  expires: new Date(Date.now() + 86_400_000).toISOString(),
})

function setup() {
  const answers: ((value: WornTheme) => void)[] = []
  const wornHere: (string | null)[] = []
  const loader = themeLoader({
    fetch: () => new Promise<WornTheme>((resolve) => answers.push(resolve)),
    wear: (w) => wornHere.push(w?.id ?? null),
    schedule: () => 0,
    cancel: () => {},
  })
  return { answers, wornHere, loader }
}

test('an older answer coming back last never replaces a newer look', async () => {
  const { answers, wornHere, loader } = setup()
  const older = loader.load()
  const newer = loader.load()
  answers[1]!(worn('new'))
  await newer
  answers[0]!(worn('old'))
  await older
  assert.deepEqual(wornHere, ['new'])
})

test('nothing is worn once stopped, or once the look changed here', async () => {
  const { answers, wornHere, loader } = setup()
  const pending = loader.load()
  loader.stop()
  answers[0]!(worn('late'))
  await pending
  const again = loader.load()
  invalidateThemeLoads()
  answers[1]!(worn('taken off meanwhile'))
  await again
  assert.deepEqual(wornHere, [])
})
