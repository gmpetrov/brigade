import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  bootstrapScript,
  GIVE_HOMES_BACK,
  setupScript,
  TEAMMATE_HELPER,
  THREAD_HELPER,
} from '../src/cloud-bootstrap.js'

/** sh -n: the script parses, with the template's escapes resolved as the computer gets them. */
const parses = (script: string) => {
  const result = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

test('the helpers and the setup the computer runs are valid shell', () => {
  parses(TEAMMATE_HELPER)
  parses(THREAD_HELPER)
  parses(setupScript())
  parses(bootstrapScript({ apiUrl: 'https://api.example.com', code: 'abc' }))
  parses(GIVE_HOMES_BACK)
})

test('the thread helper reads its command from its first argument', () => {
  // A JavaScript template turns an unescaped ${1:-} into "undefined"; the helper must not.
  assert.match(THREAD_HELPER, /case "\$\{1:-\}" in/)
  assert.doesNotMatch(THREAD_HELPER, /undefined/)
  assert.match(setupScript(), /NOPASSWD:SETENV: \/usr\/local\/sbin\/brigade-thread$/m)
})

test(
  "a thread's Docker keeps its sockets on a short path, whatever the ids",
  { skip: spawnSync('sh', ['-c', 'command -v sha256sum']).status !== 0 && 'no sha256sum here' },
  () => {
    // Under its runtime directory (/run/brigade-docker/<thread>/<user>), containerd's socket
    // paths were longer than a unix socket's may be (104), and it never started.
    const execRoot = /^docker_exec\(\) \{.*\}$/m.exec(THREAD_HELPER)?.[0]
    assert.ok(execRoot)
    const of = (thread: string, user: string) => {
      const result = spawnSync(
        'sh',
        ['-c', `${execRoot}\ndocker_exec "$1" "$2"`, 'sh', thread, user],
        {
          encoding: 'utf8',
        },
      )
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trim()
    }
    // The longest ids thread_ok and user_ok let through.
    const longest = of('t'.repeat(64), `bt-${'a'.repeat(28)}`)
    assert.ok(`${longest}/containerd/containerd-debug.sock`.length <= 104, longest)
    assert.equal(of('cmthread1', 'bt-ada'), of('cmthread1', 'bt-ada'))
    assert.notEqual(of('cmthread1', 'bt-ada'), of('cmthread2', 'bt-ada'))
    assert.notEqual(of('cmthread1', 'bt-ada'), of('cmthread1', 'bt-bob'))
    assert.match(THREAD_HELPER, /dockerd-rootless\.sh --data-root="\$D" --exec-root="\$X"/)
  },
)

test("the thread helper restarts systemd-resolved when the threads' listener is missing", () => {
  // Its host_rules alone, with what it calls stubbed: systemctl's calls are logged, ss lists
  // what LISTENING says.
  const rules = /^host_rules\(\) \{$[\s\S]*?^\}$/m.exec(THREAD_HELPER)?.[0]
  assert.ok(rules)
  const dir = mkdtempSync(join(tmpdir(), 'thread-helper-'))
  const stub = (name: string, body: string) =>
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  stub('ip', 'exit 0')
  stub('iptables', 'exit 0')
  stub('systemctl', 'echo "$*" >>"$LOG"')
  stub('ss', 'printf "%s" "$LISTENING"')
  writeFileSync(join(dir, 'resolved.conf'), '')
  const restarts = (listening: string) => {
    const log = join(dir, listening ? 'listening.log' : 'missing.log')
    const result = spawnSync(
      'sh',
      ['-c', `DNS=10.231.255.254\nRESOLVED_FILE=${dir}/resolved.conf\n${rules}\nhost_rules`],
      { env: { PATH: `${dir}:/usr/bin:/bin`, LOG: log, LISTENING: listening }, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    return readFileSync(log, 'utf8').includes('restart systemd-resolved')
  }
  assert.equal(restarts(''), true)
  assert.equal(restarts('UNCONN 0 0 10.231.255.254:53 0.0.0.0:*'), false)
})

test("the thread helper's holder runs only as pid 1 of new namespaces", () => {
  const result = spawnSync('sh', ['-c', THREAD_HELPER, 'brigade-thread', 'holder', 'cmthread1'], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /not in new namespaces/)
})

test('the thread helper takes a thread down only when none of its processes is left', () => {
  // In a folder of its own: its state, /tmp and network pins there, and what it calls stubbed:
  // ip lists PIDS in the thread's network, and logs the rest with systemctl's calls.
  const dir = mkdtempSync(join(tmpdir(), 'thread-down-'))
  const helper = THREAD_HELPER.replace('STATE=/run/brigade-threads', `STATE=${dir}/state`)
    .replace('TMPS=/var/lib/brigade/thread-tmp', `TMPS=${dir}/tmp`)
    .replaceAll('/run/netns/', `${dir}/netns/`)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const stub = (name: string, body: string) =>
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  stub('flock', 'exit 0')
  stub('ip', 'if [ "$1 $2" = "netns pids" ]; then echo $PIDS; else echo "ip $*" >>"$LOG"; fi')
  stub('systemctl', 'echo "systemctl $*" >>"$LOG"')
  const down = (pids: string, ...more: string[]) => {
    const log = join(dir, 'log')
    writeFileSync(log, '')
    const result = spawnSync('sh', ['-c', helper, 'brigade-thread', 'down', 'cmthread1', ...more], {
      env: { PATH: `${bin}:/usr/bin:/bin`, LOG: log, PIDS: pids },
      encoding: 'utf8',
    })
    return { status: result.status, log: readFileSync(log, 'utf8') }
  }
  mkdirSync(join(dir, 'state'))
  mkdirSync(join(dir, 'netns'))
  mkdirSync(join(dir, 'tmp', 'cmthread1', 'tmp'), { recursive: true })
  writeFileSync(join(dir, 'netns', 'bt-cmthread1'), '')
  writeFileSync(join(dir, 'state', 'cmthread1'), '7\n')
  writeFileSync(join(dir, 'state', 'cmthread1.holder'), '100 101\n')

  // A process of its own besides the holder's two: refused, nothing changed.
  const busy = down('100 101 555')
  assert.equal(busy.status, 3)
  assert.equal(busy.log, '')
  assert.equal(readFileSync(join(dir, 'state', 'cmthread1.holder'), 'utf8'), '100 101\n')

  // None left: the holder stopped, the network deleted, its address kept for when it comes back.
  const idle = down('100 101')
  assert.equal(idle.status, 0)
  assert.match(idle.log, /systemctl stop brigade-thread-cmthread1/)
  assert.match(idle.log, /ip netns del bt-cmthread1/)
  assert.equal(existsSync(join(dir, 'state', 'cmthread1.holder')), false)
  assert.equal(readFileSync(join(dir, 'state', 'cmthread1'), 'utf8'), '7\n')
  assert.equal(existsSync(join(dir, 'tmp', 'cmthread1')), true)

  // Its folder gone (purge): its address and /tmp too.
  writeFileSync(join(dir, 'netns', 'bt-cmthread1'), '')
  assert.equal(down('', 'purge').status, 0)
  assert.equal(existsSync(join(dir, 'state', 'cmthread1')), false)
  assert.equal(existsSync(join(dir, 'tmp', 'cmthread1')), false)
})

test('the swap file is as large as the memory, within 8 GiB, a tenth of the disk and a quarter of what is free', () => {
  const swapGib = /^swap_gib\(\) \{$[\s\S]*?^\}$/m.exec(setupScript())?.[0]
  assert.ok(swapGib)
  const size = (memoryKib: number, diskGib: number, freeGib: number) => {
    const result = spawnSync(
      'sh',
      ['-c', `${swapGib}\nswap_gib ${Math.round(memoryKib)} ${diskGib} ${freeGib}`],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    return Number(result.stdout.trim())
  }
  const GIB = 1024 * 1024
  // default: 8 GB of memory, 69 GB disk. Twice the memory used to take 12 GiB of it.
  assert.equal(size(7.9 * GIB, 69, 48), 6)
  // large: 16 GB of memory, 125 GB disk.
  assert.equal(size(15.9 * GIB, 125, 100), 8)
  // A disk already short of room.
  assert.equal(size(7.9 * GIB, 69, 12), 3)
  // small: 4 GB of memory, a small disk.
  assert.equal(size(3.9 * GIB, 20, 15), 2)
})

test("the teammate helper prunes the computer's own Docker, never its volumes", () => {
  const dir = mkdtempSync(join(tmpdir(), 'system-docker-'))
  const stub = (name: string, body: string) =>
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  stub('docker', 'echo "$*" >>"$LOG"; echo "Total reclaimed space: 2.979GB"')
  stub('systemctl', '[ "$ACTIVE" = yes ]')
  const prune = (active: string) => {
    const log = join(dir, `${active}.log`)
    const result = spawnSync(
      'sh',
      ['-c', TEAMMATE_HELPER, 'brigade-teammate', 'prune-system-docker'],
      {
        env: { PATH: `${dir}:/usr/bin:/bin`, LOG: log, ACTIVE: active },
        encoding: 'utf8',
      },
    )
    assert.equal(result.status, 0, result.stderr)
    return { out: result.stdout.trim(), calls: existsSync(log) ? readFileSync(log, 'utf8') : '' }
  }
  const { out, calls } = prune('yes')
  assert.equal(out, 'Total reclaimed space: 2.979GB')
  assert.equal(calls.trim(), 'system prune --all --force')
  // No Docker running on the computer: nothing to prune.
  assert.deepEqual(prune('no'), { out: '', calls: '' })
})

test("a restored computer's teammate homes are given back, only for users that exist", () => {
  const dir = mkdtempSync(join(tmpdir(), 'homes-back-'))
  const home = join(dir, 'home')
  for (const user of ['bt-riley', 'bt-gone', 'bt-kai'])
    mkdirSync(join(home, user), { recursive: true })
  mkdirSync(join(home, 'user'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const stub = (name: string, body: string) =>
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  stub('id', '[ "$1" != bt-gone ]')
  stub('sudo', 'echo "$*" >>"$LOG"; [ "$3" != "$FAILS" ]')
  const giveBack = (fails: string) => {
    const log = join(dir, `${fails || 'ok'}.log`)
    const result = spawnSync('sh', ['-c', GIVE_HOMES_BACK.replaceAll('/home/', `${home}/`)], {
      env: { PATH: `${bin}:/usr/bin:/bin`, LOG: log, FAILS: fails },
      encoding: 'utf8',
    })
    return { status: result.status, calls: readFileSync(log, 'utf8').trim().split('\n') }
  }
  const calls = [
    '/usr/local/sbin/brigade-teammate ensure-user bt-kai',
    '/usr/local/sbin/brigade-teammate ensure-user bt-riley',
  ]
  assert.deepEqual(giveBack(''), { status: 0, calls })
  // One that fails fails the run, after the others had theirs.
  assert.deepEqual(giveBack('bt-kai'), { status: 1, calls })
})
