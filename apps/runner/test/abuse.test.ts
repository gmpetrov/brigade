import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  blockedSince,
  CpuWatch,
  mergeReports,
  minerEvidence,
  watchAbuse,
  lookForAbuse,
  ownerOf,
  parseCounts,
  parseOwners,
  ticksOf,
  type Proc,
} from '../src/abuse.js'

const cmd = (...args: string[]) => `${args.join('\0')}\0`

test('miners are killed by their name; a pool as an argument of its own is only told', () => {
  assert.equal(minerEvidence('xmrig', cmd('./xmrig', '-o', 'pool:3333')), 'name')
  assert.equal(minerEvidence('bash', cmd('/home/bt-a/bin/cpuminer-opt', '-a', 'yespower')), 'name')
  // Renamed, but given a pool or XMRig's option: told, left running.
  assert.equal(
    minerEvidence('node', cmd('/tmp/.x/node', '-o', 'stratum+tcp://pool.example:4444')),
    'arguments',
  )
  assert.equal(minerEvidence('kw', cmd('/tmp/kw', '--url=stratum+ssl://pool:443')), 'arguments')
  assert.equal(minerEvidence('kworker', cmd('/tmp/kworker', '--donate-level', '1')), 'arguments')
  assert.equal(minerEvidence('node', cmd('node', 'server.js')), null)
  assert.equal(minerEvidence('pnpm', cmd('pnpm', 'install')), null)
})

test('searching for or writing about miners is nothing', () => {
  assert.equal(
    minerEvidence('sh', cmd('sh', '-c', "rg --fixed-strings -- 'stratum+tcp://' .; sleep 180")),
    null,
  )
  assert.equal(minerEvidence('grep', cmd('grep', '-r', 'stratum+tcp://', '.')), null)
  assert.equal(minerEvidence('vim', cmd('vim', 'docs/xmrig-notes.md')), null)
  assert.equal(minerEvidence('python3', cmd('python3', '-c', 'print("--donate-level")')), null)
  assert.equal(minerEvidence('node', cmd('node', 'test.js', '--grep', 'xmrig')), null)
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
  assert.deepEqual(first?.miners, [
    { user: 'bt-ada', pid: 10, command: './xmrig', evidence: 'name', killed: true },
  ])
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

test('a search for a pool in a shell is never killed, nor reported', async () => {
  const stopped: number[] = []
  const found = await lookForAbuse(
    {
      counts: async () => '',
      procs: async () => [
        {
          pid: 20,
          uid: 1001,
          comm: 'sh',
          cmdline: cmd('sh', '-c', "rg --fixed-strings -- 'stratum+tcp://' .; sleep 180"),
          ticks: 0,
        },
        { pid: 21, uid: 1001, comm: 'tool', cmdline: cmd('./tool', 'stratum+tcp://p:1'), ticks: 0 },
      ],
      owners: async () => parseOwners('bt-ada:x:1001:1001::/home/bt-ada:/bin/bash\n', ''),
      stop: async (_user: string, pid: number) => void stopped.push(pid),
    },
    { counts: null },
  )
  assert.deepEqual(stopped, [])
  assert.deepEqual(found?.miners, [
    {
      user: 'bt-ada',
      pid: 21,
      command: './tool stratum+tcp://p:1',
      evidence: 'arguments',
      killed: false,
    },
  ])
})

test('what is found while disconnected is kept, added up, and sent once connected', async () => {
  let counts = 'smtp 0\n'
  let miner = true
  const deps = {
    counts: async () => counts,
    procs: async (): Promise<Proc[]> =>
      miner ? [{ pid: 30, uid: 1001, comm: 'xmrig', cmdline: cmd('xmrig'), ticks: 0 }] : [],
    owners: async () => parseOwners('bt-ada:x:1001:1001::/home/bt-ada:/bin/bash\n', ''),
    stop: async () => {},
  }
  const sent: unknown[] = []
  let connected = false
  const watch = watchAbuse((report) => connected && (sent.push(report), true), deps)
  watch.stop()
  await watch.look() // the first look at startup, before the connection: a miner killed
  miner = false
  counts = 'smtp 3\n'
  await watch.look()
  counts = 'smtp 5\n'
  await watch.look()
  assert.deepEqual(sent, [])
  assert.equal(watch.pending()?.blocked.smtp, 5)
  connected = true
  await watch.look() // nothing new: what waited goes
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0], {
    type: 'abuse',
    blocked: { smtp: 5, metadata: 0, scan: 0, mining: 0 },
    miners: [{ user: 'bt-ada', pid: 30, command: 'xmrig', evidence: 'name', killed: true }],
    cpu: [],
  })
  assert.equal(watch.pending(), null)
  await watch.look()
  assert.equal(sent.length, 1)
})

test('reports kept for later add up', () => {
  const quiet = { smtp: 0, metadata: 0, scan: 0, mining: 0 }
  const a = { type: 'abuse' as const, blocked: { ...quiet, scan: 2 }, miners: [], cpu: [] }
  const b = { type: 'abuse' as const, blocked: { ...quiet, scan: 3, smtp: 1 }, miners: [], cpu: [] }
  assert.deepEqual(mergeReports(a, b)?.blocked, { smtp: 1, metadata: 0, scan: 5, mining: 0 })
  assert.equal(mergeReports(null, b), b)
  assert.equal(mergeReports(a, null), a)
})
