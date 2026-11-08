import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  blockedSince,
  CpuWatch,
  isMiner,
  lookForAbuse,
  ownerOf,
  parseCounts,
  parseOwners,
  ticksOf,
  type Proc,
} from '../src/abuse.js'

const cmd = (...args: string[]) => `${args.join('\0')}\0`

test('miners are found by their name or a pool in their arguments, not other programs', () => {
  assert.equal(isMiner('xmrig', cmd('./xmrig', '-o', 'pool:3333')), true)
  // Renamed, but given a pool.
  assert.equal(isMiner('node', cmd('/tmp/.x/node', '-o', 'stratum+tcp://pool.example:4444')), true)
  assert.equal(isMiner('kworker', cmd('/tmp/kworker', '--donate-level', '1')), true)
  assert.equal(isMiner('bash', cmd('/home/bt-a/bin/cpuminer-opt', '-a', 'yespower')), true)
  assert.equal(isMiner('node', cmd('node', 'server.js')), false)
  assert.equal(isMiner('pnpm', cmd('pnpm', 'install')), false)
  // A word in a path or an argument is not a miner.
  assert.equal(isMiner('vim', cmd('vim', 'docs/xmrig-notes.md')), false)
  assert.equal(isMiner('grep', cmd('grep', '-r', 'stratum', '.')), false)
})

test("brigade-egress's counts are read; what came before the first read is not told", () => {
  const counts = parseCounts('metadata 0\nmining 3\nscan 21\nsmtp 2\nother 9\n')
  assert.deepEqual(counts, { smtp: 2, metadata: 0, scan: 21, mining: 3 })
  assert.deepEqual(blockedSince(null, counts), { smtp: 0, metadata: 0, scan: 0, mining: 0 })
  assert.deepEqual(blockedSince(counts, { smtp: 5, metadata: 0, scan: 21, mining: 3 }), {
    smtp: 3,
    metadata: 0,
    scan: 0,
    mining: 0,
  })
  // Rules set again (a boot): counters start from 0.
  assert.deepEqual(blockedSince(counts, { smtp: 1, metadata: 0, scan: 0, mining: 0 }), {
    smtp: 1,
    metadata: 0,
    scan: 0,
    mining: 0,
  })
})

test("a teammate's processes are its uid's and its containers' subordinate uids'", () => {
  const owners = parseOwners(
    'root:x:0:0::/root:/bin/bash\nbrigade:x:999:999::/home/brigade:/bin/bash\nbt-ada:x:1001:1001::/home/bt-ada:/bin/bash\n',
    'bt-ada:100000:65536\nubuntu:300000:65536\n',
  )
  assert.equal(ownerOf(owners, 1001), 'bt-ada')
  assert.equal(ownerOf(owners, 100005), 'bt-ada')
  assert.equal(ownerOf(owners, 999), undefined)
  assert.equal(ownerOf(owners, 300001), undefined)
  assert.equal(ownerOf(owners, 0), undefined)
})

test("a process's CPU ticks are read after its name, which may hold spaces and parentheses", () => {
  const stat = '1234 (my (odd) name) S 1 1234 1234 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 1 0'
  assert.equal(ticksOf(stat), 300)
})

test('a teammate keeping most of the CPU is told after 30 minutes, and starts over after a break', () => {
  const cpu = new CpuWatch(2)
  const min = 60_000
  let ticks = 0
  // 2 cores, 100 ticks a second each: 180 s at 90% of both is 32,400 ticks a 3-minute sample.
  const at = (m: number, share = 0.9) => {
    ticks += Math.round(share * 2 * 100 * 180)
    return cpu.sample([{ pid: 1, user: 'bt-ada', ticks }], m * min)
  }
  assert.deepEqual(cpu.sample([{ pid: 1, user: 'bt-ada', ticks: 0 }], 0), [])
  for (let m = 3; m < 30; m += 3) assert.deepEqual(at(m), [])
  const long = at(30)
  assert.equal(long.length, 1)
  assert.equal(long[0]?.user, 'bt-ada')
  assert.equal(long[0]?.minutes, 30)
  assert.deepEqual(at(33, 0.1), [])
  assert.deepEqual(at(36), [])
})

test('a look kills miners, says which, and reports nothing when all is quiet', async () => {
  const procs: Proc[] = [
    { pid: 10, uid: 1001, comm: 'xmrig', cmdline: cmd('./xmrig'), ticks: 0 },
    { pid: 11, uid: 1001, comm: 'node', cmdline: cmd('node', 'app.js'), ticks: 0 },
    // Root's, the runner's: never touched.
    { pid: 12, uid: 0, comm: 'xmrig', cmdline: cmd('xmrig'), ticks: 0 },
  ]
  const stopped: string[] = []
  let counts = 'smtp 0\nscan 0\nmining 0\nmetadata 0\n'
  const deps = {
    counts: async () => counts,
    procs: async () => procs,
    owners: async () => parseOwners('bt-ada:x:1001:1001::/home/bt-ada:/bin/bash\n', ''),
    stop: async (user: string, pid: number) => void stopped.push(`${user} ${pid}`),
  }
  const state = { counts: null }
  const first = await lookForAbuse(deps, state)
  assert.deepEqual(stopped, ['bt-ada 10'])
  assert.deepEqual(first?.miners, [{ user: 'bt-ada', pid: 10, command: './xmrig', killed: true }])
  assert.deepEqual(first?.blocked, { smtp: 0, metadata: 0, scan: 0, mining: 0 })

  procs.splice(0, 1)
  assert.equal(await lookForAbuse(deps, state), null)

  counts = 'smtp 4\nscan 0\nmining 0\nmetadata 0\n'
  const mail = await lookForAbuse(deps, state)
  assert.deepEqual(mail?.blocked, { smtp: 4, metadata: 0, scan: 0, mining: 0 })
  assert.deepEqual(mail?.miners, [])

  // An older helper without egress-counts: the rest still runs.
  const older = await lookForAbuse(
    { ...deps, counts: () => Promise.reject(new Error('unknown command')) },
    { counts: null },
  )
  assert.equal(older, null)
})
