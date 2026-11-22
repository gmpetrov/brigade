// The runner's Windows layer (windows.ts): paths between Git Bash and Windows, the PATH, process
// trees. Each runs where it can: the conversions everywhere, what needs Windows on Windows (CI's
// Windows job).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createLocalSandboxSession, freePort } from '../src/harness/local-sandbox.js'
import {
  groupAlive,
  parseMsysList,
  parseWindowsList,
  treeOf,
  ownGroup,
  posixShell,
  prependPath,
  stopTree,
  toMsys,
  toNative,
  WINDOWS,
} from '../src/windows.js'

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

test('Windows paths as Git Bash writes them', () => {
  assert.equal(toMsys('C:\\Users\\Ada\\.brigade\\threads\\x'), '/c/Users/Ada/.brigade/threads/x')
  assert.equal(toMsys('D:/work/'), '/d/work')
  assert.equal(toMsys('C:\\'), '/c')
  // Not a Windows path: as it is.
  assert.equal(toMsys('/home/ada'), '/home/ada')
  assert.equal(toMsys('relative\\x'), 'relative\\x')
})

test('Git Bash paths as Windows takes them', { skip: !WINDOWS }, () => {
  const cwd = 'C:\\Users\\Ada\\thread'
  assert.equal(toNative('/c/Users/Ada/x.txt', cwd), 'C:\\Users\\Ada\\x.txt')
  assert.equal(toNative('/d', cwd), 'D:\\')
  assert.equal(toNative('C:/Users/Ada/x.txt', cwd), 'C:\\Users\\Ada\\x.txt')
  assert.equal(toNative('C:\\Users\\Ada\\x.txt', cwd), 'C:\\Users\\Ada\\x.txt')
  assert.equal(toNative('notes/a.md', cwd), 'C:\\Users\\Ada\\thread\\notes\\a.md')
  assert.equal(toNative('/tmp/x', cwd), join(tmpdir(), 'x'))
})

test('a PATH with folders first, once each', () => {
  const sep = WINDOWS ? ';' : ':'
  assert.equal(prependPath(['a', 'b', 'c'].join(sep), ['c', 'd']), ['c', 'd', 'a', 'b'].join(sep))
  assert.equal(prependPath(undefined, ['x']), 'x')
})

test("Windows' process list, and Git Bash's", () => {
  assert.deepEqual(parseWindowsList('4 0 3600\r\n812 4 12\r\n\r\nbad line\r\n'), [
    { pid: 4, ppid: 0, seconds: 3600 },
    { pid: 812, ppid: 4, seconds: 12 },
  ])
  const ps = [
    '      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND',
    '     1857       1    1857       4200  ?         197609 08:01:02 /usr/bin/bash',
    'S    1858    1857    1857       1492  ?         197609 08:01:02 /usr/bin/sleep',
  ].join('\r\n')
  assert.deepEqual(parseMsysList(ps), [
    { pid: 1857, pgid: 1857, winpid: 4200 },
    { pid: 1858, pgid: 1857, winpid: 1492 },
  ])
})

test('a tree holds what Git Bash forked, whose Windows parent is gone', () => {
  // bin\bash.exe (2076) starts usr\bin\bash (4200), which forks sleep (1492) through a process
  // it ended (8304); an unrelated process (900) stays out, and so does Git Bash's other group.
  const procs = [
    { pid: 2076, ppid: 3812 },
    { pid: 4200, ppid: 2076 },
    { pid: 1492, ppid: 8304 },
    { pid: 1600, ppid: 1492 },
    { pid: 900, ppid: 1 },
    { pid: 950, ppid: 1 },
  ]
  const msys = [
    { pgid: 1857, winpid: 4200 },
    { pgid: 1857, winpid: 1492 },
    { pgid: 2000, winpid: 950 },
  ]
  assert.deepEqual(treeOf(2076, procs, msys).sort(), [1492, 1600, 2076, 4200])
})

test('a process tree stops as one, what the shell ran in the background too', async () => {
  // A shell with a child it ran in the background: stopping the shell's tree ends both. On
  // Windows, Git Bash gives that child a Windows parent it ended (windows.ts, windowsTree).
  const child = spawn(
    posixShell(),
    ['-c', `sleep 60 & ${WINDOWS ? 'cat /proc/$!/winpid' : 'echo $!'}; wait`],
    { stdio: ['ignore', 'pipe', 'ignore'], ...ownGroup() },
  )
  const inner = Number(
    await new Promise<string>((done) => child.stdout!.once('data', (d: Buffer) => done(String(d)))),
  )
  assert.ok(inner > 0)
  const closed = new Promise((done) => child.once('close', done))
  assert.ok(groupAlive(child.pid!))
  const started = Date.now()
  await stopTree(child.pid!)
  await closed
  // Its output closed with it: nothing of it is left holding it.
  assert.ok(Date.now() - started < 20_000, `closed after ${Date.now() - started} ms`)
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(inner, 0)
    } catch {
      break
    }
    await sleep(100)
  }
  assert.throws(() => process.kill(inner, 0))
})

test('the local sandbox runs commands and reads and writes files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brigade-sandbox-'))
  const sandbox = createLocalSandboxSession({
    id: 'windows-test',
    workingDirectory: dir,
    port: await freePort(),
    env: { ...(process.env as Record<string, string>) },
  })
  try {
    // The harness sees POSIX paths: Git Bash's on Windows.
    const shown = sandbox.defaultWorkingDirectory
    assert.ok(shown.startsWith('/'))
    const pwd = await sandbox.run({ command: 'pwd' })
    assert.equal(pwd.exitCode, 0)
    // Git Bash may name the folder its own way (/tmp for the temporary folder): the same folder.
    assert.equal(toNative(pwd.stdout.trim(), dir).toLowerCase(), dir.toLowerCase())
    const home = await sandbox.run({ command: 'printf "%s" "$HOME"' })
    assert.ok(home.stdout.startsWith('/'), home.stdout)
    // Files written by path, as the harness gives them, and by a command, meet.
    await sandbox.writeTextFile({ path: `${shown}/a.txt`, content: 'from the harness' })
    assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'from the harness')
    const made = await sandbox.run({ command: 'mkdir -p sub && printf made > sub/b.txt' })
    assert.equal(made.exitCode, 0)
    assert.equal(await sandbox.readTextFile({ path: `${shown}/sub/b.txt` }), 'made')
    assert.equal(await sandbox.readTextFile({ path: 'sub/b.txt' }), 'made')
    assert.deepEqual((await sandbox.listDirectory({ path: shown }))?.map((e) => e.name).sort(), [
      'a.txt',
      'sub',
    ])
    assert.equal((await sandbox.stat({ path: `${shown}/sub` }))?.type, 'directory')
    assert.equal(await sandbox.deleteFile({ path: `${shown}/a.txt` }), true)
    // A Windows program started from bash gets a Windows path.
    const node = await sandbox.run({
      command: `node -e "console.log(require('fs').existsSync(process.argv[1]))" "${shown}/sub/b.txt"`,
    })
    assert.equal(node.stdout.trim(), 'true', node.stderr)
  } finally {
    await sandbox.destroy()
    await rm(dir, { recursive: true, force: true })
  }
})

test("Windows' computer use asks agent-desktop as the Mac's helper is asked", async () => {
  const { windowsComputer } = await import('../src/harness/windows-computer.js')
  const calls: string[][] = []
  const answers: Record<string, unknown> = {
    'list-apps': {
      apps: [
        { name: 'Notepad.exe', pid: 7 },
        { name: 'Code.exe', pid: 8 },
      ],
    },
    'list-windows': [{ app_name: 'Notepad.exe', is_focused: true }],
    'list-displays': [{ bounds: { x: 0, y: 0, width: 1280, height: 800 } }],
    screenshot: { width: 1280, height: 800 },
    launch: { app: 'notepad.exe', pid: 9 },
  }
  const exec = async (args: string[]) => {
    calls.push(args)
    return JSON.stringify({ ok: true, data: answers[args[0]!] ?? {} })
  }
  const computer = windowsComputer(exec, {
    workDir: '.',
    env: () => ({}),
    screenshotPath: () => ({ path: 'images/x.png', absolute: '/x.png' }),
    share: () => undefined,
    seen: () => undefined,
    acted: () => undefined,
  })
  assert.deepEqual(await computer.request('apps', {}), {
    apps: [
      { name: 'Notepad', pid: 7, active: true },
      { name: 'Code', pid: 8, active: false },
    ],
  })
  assert.deepEqual(await computer.request('screenshot', { path: '/x.png', display: 0 }), {
    width: 1280,
    height: 800,
    origin: { x: 0, y: 0 },
    displays: 1,
  })
  await computer.request('click', { x: 10.4, y: 20, count: 2, modifiers: ['cmd'] })
  assert.deepEqual(calls.at(-1), [
    'mouse-click',
    '--headed',
    '--xy=10,20',
    '--button',
    'left',
    '--count',
    '2',
    '--modifiers',
    'ctrl',
  ])
  await computer.request('scroll', { x: 1, y: 2, direction: 'down', amount: 3 })
  assert.deepEqual(calls.at(-1), ['mouse-wheel', '--headed', '--x=1', '--y=2', '--dy=-3'])
  // A key for an app goes only while it is in front.
  await computer.request('key', { key: 'cmd+s', app: 'Notepad' })
  assert.deepEqual(calls.at(-1), ['press', '--headed', 'ctrl+s'])
  await assert.rejects(computer.request('key', { key: 'return', app: 'Code' }), /not in front/)
  assert.deepEqual(await computer.request('open_app', { app: 'Notepad' }), {
    name: 'notepad',
    pid: 9,
    active: true,
  })
  await assert.rejects(computer.request('run', {}), /not offered on Windows/)
})
