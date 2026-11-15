// The cloud computer's desktop, as a person in control uses it through the
// dashboard, and as a teammate reads and uses its own browser's windows there
// (agent-desktop). The display belongs to the desktop's own user: the root
// helper reaches it, the runner does not, and a teammate's user only once the
// helper let it (its `browser`).
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { CLIPBOARD_MAX } from '@brigade/contracts'
import type { DesktopExec } from './agent-desktop.js'
import type { Keyboard } from './harness/desktop-tools.js'

const run = promisify(execFile)
const HELPER = '/usr/local/sbin/brigade-teammate'

/** Set the desktop's clipboard to `text`, or read it. Returns the clipboard text. */
export async function desktopClipboard(text?: string) {
  if (text === undefined) {
    const { stdout } = await run('sudo', ['-n', HELPER, 'clipboard', 'get'], {
      cwd: '/',
      maxBuffer: CLIPBOARD_MAX * 4,
      timeout: 5000,
    })
    return stdout.slice(0, CLIPBOARD_MAX)
  }
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      'sudo',
      ['-n', HELPER, 'clipboard', 'set'],
      { cwd: '/', timeout: 5000 },
      (error) => (error ? reject(error) : resolve()),
    )
    child.stdin?.end(text)
  })
  return text
}

/**
 * The teammate's own session bus on the desktop, which the helper's `browser` starts with its
 * browser (TEAMMATE_HELPER, cloud-bootstrap.ts): its accessibility bus carries only that
 * teammate's apps, so agent-desktop run as the teammate reads its own browser and nothing else.
 */
export const teammateBusDir = (user: string) => `/run/brigade-a11y/${user}`

/** How long one agent-desktop command may take before it is stopped. */
const DESKTOP_TIMEOUT_MS = 90_000
/** The most of its output read: a snapshot of a big page is a few megabytes at most. */
const DESKTOP_OUTPUT_MAX = 32 * 1024 * 1024

/**
 * agent-desktop as the teammate's Linux user, on the computer's desktop (display :0, which the
 * helper's `browser` let the teammate's user use) and on its own session bus. From the runner,
 * outside the thread's namespaces, where the desktop is. Resolves to its output, which is its
 * answer even when it exits with an error.
 */
export function teammateDesktopExec(user: string, binary: string | undefined): DesktopExec {
  return (args, options = {}) =>
    new Promise<string>((resolve, reject) => {
      if (!binary) return reject(new Error('agent-desktop is missing from this runner'))
      const dir = teammateBusDir(user)
      const child = spawn(
        'sudo',
        [
          '-n',
          '-u',
          user,
          '--',
          'env',
          '-i',
          `HOME=/home/${user}`,
          `USER=${user}`,
          `LOGNAME=${user}`,
          'PATH=/usr/bin:/bin',
          'LANG=C.UTF-8',
          'DISPLAY=:0',
          `XDG_RUNTIME_DIR=${dir}`,
          `DBUS_SESSION_BUS_ADDRESS=unix:path=${dir}/session`,
          binary,
          ...args,
        ],
        { cwd: '/', stdio: ['pipe', 'pipe', 'pipe'] },
      )
      let out = ''
      let err = ''
      let done = false
      const finish = (error?: Error) => {
        if (done) return
        done = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve(out)
      }
      const abort = () => {
        child.kill('SIGTERM')
        finish(new Error('aborted'))
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(new Error(`agent-desktop did not answer in ${DESKTOP_TIMEOUT_MS / 1000} seconds`))
      }, DESKTOP_TIMEOUT_MS)
      options.signal?.addEventListener('abort', abort, { once: true })
      child.stdout.on('data', (chunk: Buffer) => {
        if (out.length < DESKTOP_OUTPUT_MAX) out += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (err.length < 4000) err += chunk.toString('utf8')
      })
      child.on('error', (error) => finish(error))
      child.on('close', (code) => {
        if (out.trim()) return finish()
        finish(new Error(err.trim() || `agent-desktop exited with ${code}`))
      })
      child.stdin.on('error', () => undefined)
      child.stdin.end(options.stdin ?? '')
      if (options.signal?.aborted) abort()
    })
}

/** Whether the helper started the teammate's own session bus (with its browser). */
export const teammateBusStarted = (user: string) => existsSync(teammateBusDir(user))

/**
 * The desktop's keyboard into the teammate's browser window, as the teammate (xdotool): for what
 * agent-desktop can't type or press there. The window is the teammate's browser's (its class,
 * brigade-<user>, from the helper's `browser`): the one in front if it is, else its topmost one,
 * brought to the front first, since keys go to the window that has the focus.
 */
export function teammateKeyboard(user: string): Keyboard {
  const script = `
command -v xdotool >/dev/null || exit 127
# A window that goes while xdotool lists them makes it fail: asked again.
for T in 1 2 3; do
  L=$(xdotool search --onlyvisible --class "^brigade-$1\\$" 2>/dev/null) && [ -n "$L" ] && break
  sleep 0.2
done
A=$(xdotool getactivewindow 2>/dev/null) || true
W=""
for w in $L; do [ "$w" = "$A" ] && W=$w; done
[ -n "$W" ] || W=$(printf '%s\\n' $L | tail -n 1)
[ -n "$W" ] || { echo "Your browser has no window on the desktop" >&2; exit 3; }
[ "$W" = "$A" ] || xdotool windowactivate --sync "$W" >/dev/null 2>&1 || true
if [ "$2" = type ]; then exec xdotool type --clearmodifiers --delay 8 --file -; fi
exec xdotool key --clearmodifiers -- "$3"`
  const run = (args: string[], stdin: string, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(
        'sudo',
        [
          '-n',
          '-u',
          user,
          '--',
          'env',
          '-i',
          `HOME=/home/${user}`,
          'PATH=/usr/bin:/bin',
          'LANG=C.UTF-8',
          'DISPLAY=:0',
          'sh',
          '-c',
          script,
          'sh',
          user,
          ...args,
        ],
        { cwd: '/', stdio: ['pipe', 'ignore', 'pipe'] },
      )
      let err = ''
      const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
      const abort = () => child.kill('SIGTERM')
      signal?.addEventListener('abort', abort, { once: true })
      child.stderr.on('data', (chunk: Buffer) => {
        if (err.length < 2000) err += chunk.toString('utf8')
      })
      child.on('error', reject)
      child.on('close', (code) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (signal?.aborted) return reject(new Error('aborted'))
        if (code === 0) return resolve()
        reject(
          new Error(
            code === 127
              ? 'xdotool is missing on this computer, so text and keys cannot reach your browser window'
              : err.trim() || `The keyboard exited with ${code}`,
          ),
        )
      })
      child.stdin.on('error', () => undefined)
      child.stdin.end(stdin)
    })
  return {
    type: (text, signal) => run(['type'], text, signal),
    key: (combo, signal) => run(['key', combo], '', signal),
  }
}
