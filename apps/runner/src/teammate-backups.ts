// What a teammate keeps on a cloud computer outside its thread folders, backed up for a computer
// that replaces this one (BACKUP_PROTOCOL), and put back there before it runs anything:
// - its tasks: its crontab and its systemd user services (~/.config/systemd/user), Brigade's own
//   (its rootless Docker, brigade-*) left out, as the computer sets those up itself;
// - its browser: the parts of its Chrome profile that keep its sign-ins (cookies, saved logins,
//   local storage, IndexedDB, preferences), never its cache. Chrome runs with
//   --password-store=basic, so they work on another computer. Packed only while Chrome is closed:
//   a copy of its databases made while it writes them may not open.
// Everything is read and written as the teammate, never as root: nothing here writes through a
// link the teammate planted in its own home.
import { createReadStream, createWriteStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { finished } from 'node:stream/promises'
import { run } from './repos.js'
import { ensureUser, teammateHome, userServices } from './teammates.js'

/** A browser profile's sign-ins larger than this are not backed up (IndexedDB left out first). */
const BROWSER_MAX = 1024 ** 3
/** A teammate's user services, as a tar.gz: unit files, a few kilobytes each. */
const UNITS_MAX = 10 * 1024 ** 2
/** Brigade's own user units: the computer sets them up again. */
const OURS = /^(docker\.(service|socket)|brigade-.*)$/

/** A teammate's tasks, as backed up (JSON). */
export type Tasks = {
  crontab: string
  /** ~/.config/systemd/user, as a tar.gz in base64 ('' without one). */
  units: string
}

/** The teammate's tasks now. */
export async function readTasks(runAs: string): Promise<Tasks> {
  const crontab = await run('crontab', ['-l'], { runAs }).then(
    (out) => out.toString(),
    (error: Error) => {
      // "no crontab for bt-…": none.
      if (/no crontab/i.test(error.message)) return ''
      throw error
    },
  )
  const units = await run(
    'bash',
    [
      '-o',
      'pipefail',
      '-c',
      // Unit files, links (enabled units, in *.wants folders) and drop-ins; Brigade's own left
      // out, and nothing at all when that is all there is.
      'D="$HOME/.config/systemd"; [ -d "$D/user" ] || exit 0; cd "$D" || exit 0; ' +
        'OURS="(^|/)(docker\\.(service|socket)|brigade-[^/]*)$"; ' +
        'N=$(find user -mindepth 1 \\( -type f -o -type l \\) -print0 | { grep -zvcE "$OURS" || true; }); ' +
        '[ "${N:-0}" -gt 0 ] || exit 0; ' +
        'find user -mindepth 1 \\( -type f -size -256k -o -type l -o -type d \\) -print0 | ' +
        '{ grep -zvE "$OURS" || true; } | tar --null --no-recursion -T - -czf - | head -c "$1"',
      'units',
      String(UNITS_MAX + 1),
    ],
    { runAs },
  )
  if (units.length > UNITS_MAX) throw new Error('its user services are larger than 10 MB')
  return { crontab, units: units.toString('base64') }
}

/** Nothing to put back: a teammate that never had a crontab or a user service of its own. */
export const noTasks = (tasks: Tasks) => !tasks.crontab.trim() && !tasks.units

/**
 * Put a teammate's tasks back, as the teammate: its crontab, its unit files, then its user
 * manager started (lingering, as Brigade's own user services need it too) and each enabled unit
 * started. Resolves to what did not come back.
 */
export async function writeTasks(runAs: string, tasks: Tasks): Promise<string[]> {
  const problems: string[] = []
  await ensureUser(runAs)
  if (tasks.crontab.trim())
    await run('crontab', ['-'], { runAs, input: Buffer.from(tasks.crontab) }).catch((error) =>
      problems.push(`its crontab could not be installed again: ${String(error)}`),
    )
  if (!tasks.units) return problems
  await run(
    'sh',
    ['-c', 'mkdir -p "$HOME/.config/systemd" && tar -xzf - -C "$HOME/.config/systemd"'],
    { runAs, input: Buffer.from(tasks.units, 'base64') },
  ).catch((error) =>
    problems.push(`its systemd user services could not be put back: ${String(error)}`),
  )
  let uid: string
  try {
    uid = await userServices(runAs)
  } catch (error) {
    problems.push(`its systemd user manager did not start: ${String(error)}`)
    return problems
  }
  const env = {
    XDG_RUNTIME_DIR: `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
  }
  const systemctl = (...args: string[]) =>
    run('systemctl', ['--user', ...args], { runAs, env, timeout: 60_000 })
  await systemctl('daemon-reload').catch(() => undefined)
  const enabled = (
    await run(
      'sh',
      [
        '-c',
        'cd "$HOME/.config/systemd/user" 2>/dev/null && find . -path "*.wants/*" -printf "%f\\n" || true',
      ],
      { runAs },
    )
  )
    .toString()
    .split('\n')
    .filter((unit) => /^[\w@.:-]+\.(service|timer|socket|path)$/.test(unit) && !OURS.test(unit))
  for (const unit of new Set(enabled))
    await systemctl('start', unit).catch((error) =>
      problems.push(`its user service ${unit} did not start again: ${String(error)}`),
    )
  return problems
}

/** Whether the teammate's Chrome runs. */
export async function browserRunning(runAs: string) {
  return run('pgrep', ['-u', runAs, '-f', `user-data-dir=${teammateHome(runAs)}/.browser`], {
    runAs,
  }).then(
    () => true,
    () => false,
  )
}

/** What of a Chrome profile keeps its sign-ins, relative to it: the profile's own, then each of its people's. */
const PROFILE_FILES = ['Local State']
const PERSON_FILES = [
  'Preferences',
  'Secure Preferences',
  'Cookies',
  'Cookies-journal',
  'Network/Cookies',
  'Network/Cookies-journal',
  'Login Data',
  'Login Data-journal',
  'Login Data For Account',
  'Login Data For Account-journal',
  'Web Data',
  'Web Data-journal',
  'Extension Cookies',
  'Local Storage',
  'IndexedDB',
]

/** The shell that lists what PROFILE_FILES and PERSON_FILES name in a profile, NUL-separated. */
const listProfile = (skip: string[] = []) => {
  const quote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`
  const person = PERSON_FILES.filter((f) => !skip.includes(f))
  return (
    `for f in ${PROFILE_FILES.map(quote).join(' ')}; do [ -e "$f" ] && printf '%s\\0' "$f"; done; ` +
    `for p in Default 'Profile '*; do [ -d "$p" ] || continue; ` +
    `for f in ${person.map(quote).join(' ')}; do [ -e "$p/$f" ] && printf '%s\\0' "$p/$f"; done; done`
  )
}

/**
 * When the profile's sign-ins last changed (the newest of their files, in seconds), or null
 * without a profile.
 */
export async function browserStamp(runAs: string): Promise<number | null> {
  const out = await run(
    'bash',
    [
      '-c',
      `cd "$HOME/.browser" 2>/dev/null || exit 0; { ${listProfile()}; } | ` +
        "xargs -0r find 2>/dev/null -printf '%T@\\n' | sort -n | tail -1",
    ],
    { runAs },
  )
  const stamp = Number(out.toString().trim())
  return out.toString().trim() && Number.isFinite(stamp) ? stamp : null
}

/**
 * Pack the profile's sign-ins into `file` (a tar.gz), as the teammate, with Chrome closed.
 * Resolves to its size; null without a profile, or larger than BROWSER_MAX even without IndexedDB.
 */
export async function packBrowser(runAs: string, file: string): Promise<number | null> {
  for (const skip of [[], ['IndexedDB']]) {
    const out = createWriteStream(file, { mode: 0o600 })
    const written = finished(out)
    const packed = run(
      'bash',
      [
        '-o',
        'pipefail',
        '-c',
        `cd "$HOME/.browser" 2>/dev/null || exit 3; { ${listProfile(skip)}; } | ` +
          'tar --null -T - -czf - | head -c "$1"',
        'browser',
        String(BROWSER_MAX + 1),
      ],
      { runAs, stdout: out },
    ).then(
      () => null,
      (error: { code?: number }) => error,
    )
    const failed = await packed
    if (failed && !out.writableEnded) out.end()
    await written
    if ((failed as { code?: number } | null)?.code === 3) return null
    const { size } = await stat(file)
    if (size > BROWSER_MAX) continue
    if (failed) throw failed
    return size
  }
  return null
}

/** Put the profile's sign-ins back, as the teammate, before its Chrome first starts here. */
export async function unpackBrowser(runAs: string, file: string) {
  await ensureUser(runAs)
  await run('sh', ['-c', 'mkdir -p -m 700 "$HOME/.browser" && tar -xzf - -C "$HOME/.browser"'], {
    runAs,
    stdin: createReadStream(file),
  })
}

/** Tasks as a file, and back. */
export const writeTasksFile = (file: string, tasks: Tasks) =>
  writeFile(file, JSON.stringify(tasks), { mode: 0o600 })
export const readTasksFile = async (file: string) =>
  JSON.parse(await readFile(file, 'utf8')) as Tasks
