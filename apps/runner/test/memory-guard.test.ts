import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MemoryGuard,
  parseMemory,
  roomFor,
  type Candidate,
  type Reading,
} from '../src/memory-guard.js'

const MB = 1024 ** 2
const calm: Reading = { full: 2, available: 0.4, swapUsed: 0.1, swapTotal: 8 * 1024 * MB }
const stuck: Reading = { ...calm, full: 70 }

const guard = () =>
  new MemoryGuard({ candidates: async () => [], limit: 40, duration: 10_000, cooldown: 20_000 })

test('memory and pressure read from /proc', () => {
  const reading = parseMemory(
    'some avg10=81.20 avg60=40.00 avg300=9.00 total=1\nfull avg10=63.50 avg60=30.00 avg300=6.00 total=1\n',
    'MemTotal:        8000000 kB\nMemFree:          100000 kB\nMemAvailable:     400000 kB\nSwapTotal:       4000000 kB\nSwapFree:        1000000 kB\n',
  )
  assert.deepEqual(reading, {
    full: 63.5,
    available: 0.05,
    swapUsed: 0.75,
    swapTotal: 4000000 * 1024,
  })
  // Not Linux, or no PSI: nothing to go on.
  assert.equal(parseMemory('', 'MemTotal: 8000000 kB\n'), null)
})

test('the guard acts once the computer has been stuck long enough, not on a short spike', () => {
  const g = guard()
  assert.equal(g.check(stuck, 0), undefined)
  assert.equal(g.check(stuck, 5_000), undefined)
  assert.equal(g.check(calm, 8_000), undefined)
  // Started over after the dip.
  assert.equal(g.check(stuck, 9_000), undefined)
  assert.equal(g.check(stuck, 15_000), undefined)
  assert.match(g.check(stuck, 19_000) ?? '', /stuck waiting for memory for 10 s/)
})

test('nearly out of memory with swap full: at once', () => {
  const g = guard()
  assert.match(
    g.check({ full: 5, available: 0.02, swapUsed: 0.95, swapTotal: 1 }, 0) ?? '',
    /nearly out of memory/,
  )
  // Little memory but swap left: the kernel moves it there; no reason yet.
  assert.equal(g.check({ full: 5, available: 0.02, swapUsed: 0.5, swapTotal: 1 }, 0), undefined)
  // No swap at all: nothing to move it to.
  assert.match(
    g.check({ full: 5, available: 0.02, swapUsed: 0, swapTotal: 0 }, 0) ?? '',
    /nearly out/,
  )
})

test('after acting, it waits for the averages to show the effect', async () => {
  let stopped = 0
  const candidates: Candidate[] = [
    { kind: 'turn', memory: 2048 * MB, stop: async () => void stopped++ },
  ]
  const g = new MemoryGuard({
    candidates: async () => candidates,
    read: async () => stuck,
    duration: 10_000,
    cooldown: 20_000,
    limit: 40,
  })
  await g.tick(0)
  await g.tick(10_000)
  assert.equal(stopped, 1)
  // Still stuck during the pause: noted, nothing done.
  await g.tick(12_000)
  await g.tick(25_000)
  assert.equal(stopped, 1)
  // Still stuck once the pause is over: the next one.
  await g.tick(30_000)
  assert.equal(stopped, 2)
})

const candidate = (kind: Candidate['kind'], memory: number, lastUsed?: number): Candidate => ({
  kind,
  memory: memory * MB,
  ...(lastUsed !== undefined ? { lastUsed } : {}),
  stop: async () => undefined,
})

test('what it stops: a preview before a turn of the same size, the biggest of each', () => {
  const g = guard()
  const turn = candidate('turn', 3000)
  const preview = candidate('preview', 1600)
  const small = candidate('preview', 300)
  assert.equal(g.pick([small, turn, preview], calm), preview)
  // A turn much bigger than any preview goes first: stopping a small preview would not help.
  const huge = candidate('turn', 5000)
  assert.equal(g.pick([small, huge, preview], calm), huge)
  // Too small to matter: nothing to stop but frozen previews.
  assert.equal(g.pick([candidate('turn', 20)], calm), undefined)
})

test('frozen previews go first when swap is what runs out, the one unused longest', () => {
  const g = guard()
  const older = candidate('frozen', 10, 1_000)
  const newer = candidate('frozen', 10, 5_000)
  const turn = candidate('turn', 3000)
  assert.equal(g.pick([newer, turn, older], { ...calm, swapUsed: 0.85 }), older)
  assert.equal(g.pick([newer, turn, older], calm), turn)
  // Nothing else: a frozen one still gives back its swap.
  assert.equal(g.pick([newer, older], calm), older)
})

test('a browser no turn used for a while goes before anything that runs', () => {
  const g = guard()
  const now = 10 * 60_000
  const idle = candidate('browser', 500, now - 5 * 60_000)
  const busy = candidate('browser', 800, now - 10_000)
  const turn = candidate('turn', 3000)
  const preview = candidate('preview', 1000)
  assert.equal(g.pick([turn, preview, busy, idle], calm, now), idle)
  // In use: weighed as a preview is, since it starts again at the next call.
  assert.equal(g.pick([turn, busy], calm, now), turn)
  assert.equal(g.pick([candidate('turn', 1200), busy], calm, now), busy)
  // Frozen previews still go first when swap is what runs out.
  const frozen = candidate('frozen', 10, 1_000)
  assert.equal(g.pick([idle, frozen], { ...calm, swapUsed: 0.85 }, now), frozen)
  // Too small to matter: not stopped for nothing.
  assert.equal(g.pick([candidate('browser', 20, 0), turn], calm, now), turn)
})

test('checks that pile up on a stuck computer stop one thing, not one each', async () => {
  let stopped = 0
  let release!: () => void
  const slow = new Promise<void>((done) => (release = done))
  const g = new MemoryGuard({
    candidates: async () =>
      [candidate('turn', 2000), candidate('turn', 1900)].map((c) => ({
        ...c,
        stop: async () => void stopped++,
      })),
    // The first reading takes long, as /proc does when the computer is stuck.
    read: async () => (await slow, { full: 5, available: 0.01, swapUsed: 0, swapTotal: 0 }),
    cooldown: 20_000,
  })
  const ticks = [g.tick(0), g.tick(2_000), g.tick(4_000)]
  release()
  await Promise.all(ticks)
  assert.equal(stopped, 1)
})

test('after the kernel killed something for memory, the guard waits instead of adding to it', async () => {
  let stopped = 0
  let kills = 3
  const g = new MemoryGuard({
    candidates: async () => [{ ...candidate('turn', 2000), stop: async () => void stopped++ }],
    read: async () => ({ full: 5, available: 0.01, swapUsed: 0, swapTotal: 0, oomKills: kills }),
    cooldown: 20_000,
  })
  await g.tick(0)
  assert.equal(stopped, 1)
  kills = 4 // the kernel's own kill, during the pause
  await g.tick(22_000)
  assert.equal(stopped, 0 + 1)
  // Its pause over, still nearly out: the guard acts again.
  await g.tick(43_000)
  assert.equal(stopped, 2)
  assert.equal(
    parseMemory(
      'full avg10=1.00 avg60=0 avg300=0 total=0\n',
      'MemTotal: 100 kB\nMemAvailable: 50 kB\n',
      'pgfault 9\noom_kill 7\n',
    )?.oomKills,
    7,
  )
})

test('room for a turn: some memory available, hardly any waiting on it', () => {
  assert.equal(roomFor(calm), true)
  assert.equal(roomFor({ ...calm, available: 0.1 }), false)
  assert.equal(roomFor({ ...calm, full: 25 }), false)
})
