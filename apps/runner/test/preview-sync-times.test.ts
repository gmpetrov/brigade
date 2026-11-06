import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Receiver } from '../src/preview-sync-receiver.js'

// What a machine's copy lacks after a manifest (preview-sync-receiver.ts), judged by size, mode
// and time: a time is the same when equal to the millisecond, or in the same second when one
// side keeps whole seconds only, as boat's ascii-lazyfs does for a few minutes after a machine
// wakes (the machine's side), or a computer's after a restart (the reader's).

const made: string[] = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'preview-sync-times-'))
  made.push(dir)
  return dir
}

/** A whole second, then times in it that a double holds exactly (no rounding on the way). */
const SECOND = 1_793_953_492_000
const BYTES = 'same bytes\n'

type Entry = { time: number; size?: number; mode?: number }

/** The paths the receiver asks for: its copy holds `copy`, the reader's manifest says `here`. */
async function lacks(copy: Record<string, number>, here: Record<string, Entry>) {
  const root = temp()
  for (const [path, time] of Object.entries(copy)) {
    writeFileSync(join(root, path), BYTES)
    chmodSync(join(root, path), 0o644)
    utimesSync(join(root, path), new Date(time), new Date(time))
  }
  let need: string[] | undefined
  const receiver = new Receiver(root, join(temp(), 'state.json'), (message) => {
    const m = message as { t: string; paths?: string[] }
    if (m.t === 'need') need = m.paths
  })
  const files = Object.entries(here).map(([path, e]) => [
    path,
    e.size ?? BYTES.length,
    e.time,
    e.mode ?? 0o644,
  ])
  await receiver.push(Buffer.from(`${JSON.stringify({ t: 'manifest', files, links: [] })}\n`))
  await receiver.idle()
  return need?.sort()
}

test('a time kept to the second by one side is the same as the other side’s in that second', async () => {
  assert.deepEqual(
    await lacks(
      { 'machine-whole.mov': SECOND, 'here-whole.mov': SECOND + 500, 'equal.mov': SECOND + 250 },
      {
        // The machine's copy kept whole seconds (lazyfs there): what it has is this file.
        'machine-whole.mov': { time: SECOND + 500 },
        // This side's time kept whole seconds (lazyfs here): what the machine has is this file.
        'here-whole.mov': { time: SECOND },
        'equal.mov': { time: SECOND + 250 },
      },
    ),
    [],
  )
})

test('a time in another second, or another in the same one, is not; nor another size or mode', async () => {
  assert.deepEqual(
    await lacks(
      {
        'next-second.mov': SECOND,
        'other-ms.mov': SECOND + 250,
        'size.mov': SECOND,
        'mode.mov': SECOND,
      },
      {
        'next-second.mov': { time: SECOND + 1500 },
        // Both keep milliseconds, and differ: it changed.
        'other-ms.mov': { time: SECOND + 500 },
        'size.mov': { time: SECOND + 500, size: BYTES.length + 1 },
        'mode.mov': { time: SECOND + 500, mode: 0o755 },
      },
    ),
    ['mode.mov', 'next-second.mov', 'other-ms.mov', 'size.mov'],
  )
})
