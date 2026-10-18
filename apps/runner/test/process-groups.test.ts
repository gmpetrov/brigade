// What a runner that died left running: found from the groups it noted, and stopped by the next.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  leftovers,
  parseProcesses,
  processes,
  ProcessGroups,
  type Proc,
} from '../src/process-groups.js'

const at = 1_000_000_000
const proc = (pid: number, ppid: number, pgid: number, started = at): Proc => ({
  pid,
  ppid,
  pgid,
  started,
})

test('ps elapsed times read in any of their forms', () => {
  const now = 10_000_000
  const procs = parseProcesses(
    [
      '  1     0     1 2-01:02:03',
      ' 20     1    20    01:02:03',
      ' 30    20    20 05:09',
      'junk',
    ].join('\n'),
    now,
  )
  assert.deepEqual(
    procs.map((p) => [p.pid, (now - p.started) / 1000]),
    [
      [1, 2 * 86_400 + 3_723],
      [20, 3_723],
      [30, 309],
    ],
  )
})

test('a group left over is stopped whole, with what it started in groups of its own', () => {
  const procs = [
    proc(1, 0, 1, 0),
    proc(100, 1, 100), // the bridge, orphaned
    proc(101, 100, 100), // the harness, in its group
    proc(102, 101, 102), // a command the harness ran in a group of its own
    proc(103, 102, 102),
    proc(200, 1, 200), // something else
  ]
  const found = leftovers([{ pgid: 100, at: at + 1_000, what: 'turn t' }], procs, 999)
  assert.deepEqual(found.map((p) => p.pid).sort(), [100, 101, 102, 103])
})

test("a group's pid that is someone else's by now is left alone", () => {
  // Its leader started an hour after the group was noted: the pid went to another group.
  const later = [proc(100, 1, 100, at + 3_600_000), proc(101, 100, 100, at + 3_600_000)]
  assert.deepEqual(leftovers([{ pgid: 100, at, what: 'turn t' }], later, 999), [])
  // Its leader gone, what is in it started before the group was: not what the runner started.
  const before = [proc(101, 1, 100, at - 60_000)]
  assert.deepEqual(leftovers([{ pgid: 100, at, what: 'turn t' }], before, 999), [])
  // Its leader gone, what it started stays in it.
  const orphans = [proc(101, 1, 100, at + 2_000)]
  assert.deepEqual(
    leftovers([{ pgid: 100, at, what: 'turn t' }], orphans, 999).map((p) => p.pid),
    [101],
  )
})

test('never the runner itself, nor what started it', () => {
  const procs = [proc(100, 1, 100), proc(101, 100, 100), proc(102, 101, 100)]
  // The new runner (102) runs inside a group the old one noted (started from a turn, say).
  assert.deepEqual(
    leftovers([{ pgid: 100, at, what: 'turn t' }], procs, 102).map((p) => p.pid),
    [],
  )
})

test('the next runner stops the groups the one before left running', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brigade-groups-'))
  test.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'process-groups.json')
  // A leader with a child in its group, and a grandchild in a group of its own.
  const leader = spawn(
    process.execPath,
    [
      '-e',
      `const { spawn } = require('node:child_process')
       spawn('sleep', ['60'], { stdio: 'ignore' })
       spawn('sleep', ['61'], { stdio: 'ignore', detached: true })
       setInterval(() => {}, 1e6)`,
    ],
    { detached: true, stdio: 'ignore' },
  )
  const before = new ProcessGroups(file)
  before.add(leader.pid, 'turn t')
  // Its two children are up.
  let mine: Proc[] = []
  for (let i = 0; i < 50 && mine.length < 3; i++) {
    await new Promise((done) => setTimeout(done, 100))
    const procs = await processes()
    mine = procs.filter((p) => p.pid === leader.pid || p.ppid === leader.pid)
  }
  assert.equal(mine.length, 3)

  const reaped = await new ProcessGroups(file).reap()
  assert.match(reaped ?? '', /^3 process\(es\) of turn t/)
  const left = (await processes()).filter((p) => mine.some((m) => m.pid === p.pid))
  assert.deepEqual(left, [])
  // The list is the new runner's now: a runner after it finds nothing to stop.
  assert.equal(await new ProcessGroups(file).reap(), undefined)
})

test('a group handed over by an update is kept, and stopped by a runner after if left', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brigade-groups-'))
  const file = join(dir, 'process-groups.json')
  const start = () => spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
  const handed = start()
  const left = start()
  test.after(async () => {
    for (const p of [handed, left]) p.kill()
    await rm(dir, { recursive: true, force: true })
  })
  const before = new ProcessGroups(file)
  before.add(handed.pid, 'turn handed over')
  before.add(left.pid, 'turn left')
  await new Promise((done) => setTimeout(done, 100))
  const alive = async (pid: number | undefined) => (await processes()).some((p) => p.pid === pid)

  const reaped = await new ProcessGroups(file).reap(new Set([handed.pid!]))
  assert.match(reaped ?? '', /^1 process\(es\) of turn left/)
  assert.equal(await alive(handed.pid), true)
  assert.equal(await alive(left.pid), false)
  // Still on the list: a runner after this one that did not take it up stops it.
  assert.match((await new ProcessGroups(file).reap()) ?? '', /turn handed over/)
  assert.equal(await alive(handed.pid), false)
})
