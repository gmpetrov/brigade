// The name a guest's account starts with (docs/guests.md): the full name of this computer's own
// account, so Brigade greets them by it before they ever sign in. Never the login's short name,
// an address, a value with digits or a generic account's name: then none, and the dashboard says
// Guest. macOS's `id -F`, Linux's GECOS field (`getent passwd <uid>`); Windows gives none.
import { execFile } from 'node:child_process'
import os from 'node:os'

const NOT_A_NAME = new Set([
  'admin',
  'administrator',
  'user',
  'guest',
  'student',
  'owner',
  'root',
  'test',
])

/** An account's full name worth greeting someone by, or null. */
export function fullNameOf(full: string | undefined, login: string | undefined) {
  const name = String(full ?? '')
    .split(',')[0]!
    .trim()
    .slice(0, 100)
  if (!name || name.includes('@') || /\d/.test(name)) return null
  const lower = name.toLowerCase()
  if (
    NOT_A_NAME.has(lower) ||
    lower ===
      String(login ?? '')
        .trim()
        .toLowerCase()
  )
    return null
  return name
}

function run(file: string, args: string[]) {
  return new Promise<string>((resolve) => {
    execFile(file, args, { timeout: 2_000, encoding: 'utf8', windowsHide: true }, (error, out) =>
      resolve(error ? '' : String(out)),
    )
  })
}

/** This computer's account's full name, or null. */
export async function accountFullName(
  platform: NodeJS.Platform = process.platform,
  exec: typeof run = run,
) {
  const user = os.userInfo()
  if (platform === 'darwin')
    return fullNameOf((await exec('/usr/bin/id', ['-F'])).trim(), user.username)
  if (platform !== 'linux' || user.uid < 0) return null
  const entry = (await exec('getent', ['passwd', String(user.uid)])).trim()
  return fullNameOf(entry.split(':')[4], user.username)
}
