import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * The thread helper in a folder of its own, for a teammate's Docker: its state, network pins,
 * threads' Docker folders and the teammate's /run/user there, and what needs root stubbed.
 * iptables (on the host, and in a thread's network through ip) logs its calls and has no rule
 * yet; docker answers with DOCKER_PS and DOCKER_INSPECT.
 */
function dockerHelper() {
  const dir = mkdtempSync(join(tmpdir(), 'thread-docker-'))
  const bin = join(dir, 'bin')
  for (const sub of ['bin', 'state', 'netns', 'run', 'user/1500'])
    mkdirSync(join(dir, sub), { recursive: true })
  writeFileSync(join(dir, 'subuid'), 'bt-test:100000:65536\n')
  const stub = (name: string, body: string) =>
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  stub('id', 'case "$1" in -u) echo 1500 ;; *) exit 0 ;; esac')
  for (const name of ['dockerd-rootless.sh', 'newuidmap', 'loginctl']) stub(name, 'exit 0')
  // As the teammate: here, with this PATH, its env -i and assignments dropped.
  stub(
    'runuser',
    [
      'while [ "$1" != -- ]; do shift; done; shift',
      '[ "$1" = env ] && shift && [ "$1" = -i ] && shift',
      'while case "$1" in *=*) true ;; *) false ;; esac; do shift; done',
      'exec "$@"',
    ].join('\n'),
  )
  stub(
    'docker',
    'case "$*" in *" ps -q") printf "%s" "$DOCKER_PS" ;; *" inspect "*) printf "%b" "$DOCKER_INSPECT" ;; esac',
  )
  stub('iptables', 'echo "host $*" >>"$LOG"; case "$*" in *" -C "*|"-C "*) exit 1 ;; esac')
  stub(
    'ip',
    'if [ "$1 $2" = "netns exec" ]; then N=$3; shift 4; echo "netns $N $*" >>"$LOG"; case "$*" in *" -C "*|"-C "*) exit 1 ;; esac; fi',
  )
  stub(
    'install',
    'A=""; while [ $# -gt 0 ]; do case "$1" in -o|-g) shift ;; *) A="$A $1" ;; esac; shift; done; exec /usr/bin/install $A',
  )
  // The teammate's systemd: its proxy runs once started, and listens in each folder on SIGHUP.
  const listen = `for D in "$DIR"/run/*/bt-test; do [ -S "$D/docker.sock" ] || python3 -c 'import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])' "$D/docker.sock"; done`
  stub(
    'systemctl',
    `echo "systemctl $*" >>"$LOG"; case "$*" in *is-active*) [ -e "$DIR/proxy-up" ] ;; *"kill -s HUP"*) ${listen} ;; esac`,
  )
  stub('systemd-run', `echo "systemd-run $*" >>"$LOG"; : >"$DIR/proxy-up"; ${listen}`)
  const helper = THREAD_HELPER.replace('STATE=/run/brigade-threads', `STATE=${dir}/state`)
    .replace('DOCKER_RUN=/run/brigade-docker', `DOCKER_RUN=${dir}/run`)
    .replaceAll('/run/netns/', `${dir}/netns/`)
    .replaceAll('/run/user/', `${dir}/user/`)
    .replaceAll('/etc/subuid', `${dir}/subuid`)
  const log = join(dir, 'log')
  const call = (args: string[], env: Record<string, string> = {}) => {
    writeFileSync(log, '')
    const result = spawnSync('sh', ['-c', helper, 'brigade-thread', ...args], {
      env: { PATH: `${bin}:/usr/bin:/bin`, LOG: log, DIR: dir, ...env },
      encoding: 'utf8',
    })
    return { ...result, log: readFileSync(log, 'utf8') }
  }
  // Thread 7's network: 10.231.0.29 on the host's side, its containers on 127.231.0.7.
  const thread = (name: string, index: number) => {
    writeFileSync(join(dir, 'state', name), `${index}\n`)
    writeFileSync(join(dir, 'netns', `bt-${name}`), '')
  }
  return { dir, call, thread }
}

const canRun = (...commands: string[]) =>
  commands.every((c) => spawnSync('sh', ['-c', `command -v ${c}`]).status === 0)

test("a thread's localhost reaches the ports its teammate's containers publish on its address, and only those", () => {
  const { dir, call, thread } = dockerHelper()
  thread('cmthread1', 7)
  mkdirSync(join(dir, 'run', 'cmthread1', 'bt-test'), { recursive: true })
  writeFileSync(join(dir, 'run', 'cmthread1', 'bt-test', 'address'), '127.231.0.7\n')
  const inspect = [
    '127.231.0.7 5432 5432/tcp',
    '127.231.0.7 32768 80/tcp',
    '127.231.0.7 5353 53/udp',
    // Another thread's container, and what the helper must not trust.
    '127.231.0.8 6379 6379/tcp',
    '127.231.0.7 99999 1/tcp',
    '127.231.0.7 22 22/sctp',
    '127.231.0.7 1 1/tcp -j ACCEPT',
    '',
  ].join('\\n')
  const result = call(['docker-ports', 'cmthread1', 'bt-test'], {
    DOCKER_PS: 'c1\nc2',
    DOCKER_INSPECT: inspect,
  })
  assert.equal(result.status, 0, result.stderr)
  const rules = result.log
    .split('\n')
    .filter((line) => / -A BD-| -A OUTPUT| -A PREROUTING| -I INPUT/.test(line))
  assert.deepEqual(rules, [
    'host -t nat -A PREROUTING -i btn7 -j BD-7-1500',
    'host -I INPUT 1 -i btn7 -j BD-7-1500',
    'netns bt-cmthread1 -t nat -A OUTPUT -j BD-1500',
    ...[
      ['tcp', 32768],
      ['tcp', 5432],
      ['udp', 5353],
    ].flatMap(([proto, port]) => [
      `host -t nat -A BD-7-1500 -d 10.231.0.29 -p ${proto} --dport ${port} -j DNAT --to-destination 127.231.0.7`,
      `host -A BD-7-1500 -d 127.231.0.7 -p ${proto} --dport ${port} -j ACCEPT`,
      `netns bt-cmthread1 -t nat -A BD-1500 -d 127.0.0.1 -p ${proto} --dport ${port} -j DNAT --to-destination 10.231.0.29`,
      `netns bt-cmthread1 -t nat -A BD-1500 -d 127.231.0.7 -p ${proto} --dport ${port} -j DNAT --to-destination 10.231.0.29`,
    ]),
  ])
  // Made again from scratch each time: what stopped is gone.
  assert.match(result.log, /^host -t nat -N BD-7-1500$/m)

  // Without the teammate's Docker socket in the thread, none of its ports is the thread's.
  rmSync(join(dir, 'run', 'cmthread1', 'bt-test', 'address'))
  const none = call(['docker-ports', 'cmthread1', 'bt-test'], {
    DOCKER_PS: 'c1',
    DOCKER_INSPECT: inspect,
  })
  assert.equal(none.status, 0, none.stderr)
  assert.doesNotMatch(none.log, /DNAT/)
})

test("a teammate's proxy makes only its own containers' ports a thread's", () => {
  const { call, thread } = dockerHelper()
  thread('cmthread1', 7)
  const other = call(['docker-ports', 'cmthread1', 'bt-test'], { SUDO_USER: 'bt-other' })
  assert.equal(other.status, 2)
  assert.match(other.stderr, /not yours/)
  assert.equal(call(['docker-ports', 'cmthread1', 'bt-test'], { SUDO_USER: 'bt-test' }).status, 0)
  assert.equal(call(['docker-ports', 'cmthread1', 'bt-test'], { SUDO_USER: 'brigade' }).status, 0)
  // Allowed in sudoers for that command alone.
  assert.match(
    setupScript(),
    /^%brigade-teammates ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/brigade-thread docker-ports \*$/m,
  )
})

test(
  "a thread's Docker socket is its teammate's proxy, started once, told of each new thread",
  { skip: !canRun('flock', 'python3') && 'no flock or python3 here' },
  () => {
    const { dir, call, thread } = dockerHelper()
    thread('cmthread1', 7)
    thread('cmthread2', 300)
    const bus = join(dir, 'user', '1500', 'bus')
    spawnSync('python3', [
      '-c',
      'import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])',
      bus,
    ])

    const first = call(['docker', 'cmthread1', 'bt-test'])
    assert.equal(first.status, 0, first.stderr)
    assert.equal(first.stdout.trim(), `${dir}/run/cmthread1/bt-test/docker.sock`)
    assert.equal(
      readFileSync(join(dir, 'run', 'cmthread1', 'bt-test', 'address'), 'utf8'),
      '127.231.0.7\n',
    )
    const started = first.log.split('\n').filter((line) => line.startsWith('systemd-run'))
    assert.deepEqual(started, [
      'systemd-run --user --quiet --collect --unit=brigade-docker-proxy.service /opt/brigade/node/bin/node /opt/brigade/runner/dist/docker-proxy.js',
    ])
    // Docker on first use only: not with the teammate's systemd.
    assert.match(first.log, /systemctl --user disable --quiet docker\.service/)
    assert.doesNotMatch(first.log, /dockerd/)

    // Running already: told, not started again. Thread 300's address is its own.
    const second = call(['docker', 'cmthread2', 'bt-test'])
    assert.equal(second.status, 0, second.stderr)
    assert.equal(
      readFileSync(join(dir, 'run', 'cmthread2', 'bt-test', 'address'), 'utf8'),
      '127.231.1.44\n',
    )
    assert.doesNotMatch(second.log, /systemd-run/)
    assert.match(second.log, /systemctl --user kill -s HUP brigade-docker-proxy\.service/)

    // Its socket in a thread gone, the thread's ports with it.
    const stop = call(['docker-stop', 'cmthread2', 'bt-test'])
    assert.equal(stop.status, 0, stop.stderr)
    assert.equal(existsSync(join(dir, 'run', 'cmthread2')), false)
    assert.match(stop.log, /systemctl --user kill -s HUP brigade-docker-proxy\.service/)
    assert.match(stop.log, /^host -t nat -D PREROUTING -i btn300 -j BD-300-1500$/m)
    assert.match(stop.log, /^netns bt-cmthread2 -t nat -D OUTPUT -j BD-1500$/m)
  },
)

test("each thread's containers publish on a loopback address of its own", () => {
  const loopAddr = /^loop_addr\(\) \{.*\}$/m.exec(THREAD_HELPER)?.[0]
  assert.ok(loopAddr)
  const of = (index: number) =>
    spawnSync('sh', ['-c', `${loopAddr}\nloop_addr ${index}`], { encoding: 'utf8' }).stdout.trim()
  // make_net hands out 1 to 16382.
  const all = [1, 2, 255, 256, 257, 16382].map(of)
  assert.deepEqual(all, [
    '127.231.0.1',
    '127.231.0.2',
    '127.231.0.255',
    '127.231.1.0',
    '127.231.1.1',
    '127.231.63.254',
  ])
})
