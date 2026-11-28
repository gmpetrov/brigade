// Linux: an installed app is a launcher entry, ~/.local/share/applications/brigade-app-<id>.desktop,
// which starts Brigade with --app=<installId>. Its window says it belongs to that entry: on X11,
// by its WM_CLASS (StartupWMClass), set here through the window's X id, so the dock groups it
// under the app's own icon. Wayland gives no way to do that per window: there the window groups
// under Brigade's icon, and the launcher entry still opens it.
import x11 from 'x11'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

export const applicationsFolder = (env = process.env) =>
  join(env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share'), 'applications')

export const entryName = (installId: string) => `brigade-app-${installId}.desktop`

/** The window class its entry names, and the window gets on X11. */
export const wmClass = (installId: string) => `brigade-app-${installId}`

/** Whether a path is one of Brigade's app entries in that folder (what uninstall may remove). */
export const isAppEntry = (path: string, folder = applicationsFolder()) =>
  dirname(resolve(path)) === resolve(folder) &&
  /^brigade-app-[0-9a-f]{32}\.desktop$/.test(basename(path))

/** What runs Brigade: the AppImage itself (its mount point changes each run), else the binary. */
export const launcherPath = (env = process.env, execPath = process.execPath) =>
  env.APPIMAGE || execPath

/** A value of a key in a desktop entry: one line, its backslashes escaped. */
const value = (s: string) =>
  s
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .trim()

/**
 * An argument of Exec, quoted as the Desktop Entry Specification says: in double quotes, with
 * `"`, `` ` ``, `$` and `\` escaped by a backslash, and that backslash itself escaped again as
 * any string value's; `%` doubled, as field codes start with it.
 */
export function execArg(arg: string) {
  const quoted = `"${arg.replace(/(["`$\\])/g, '\\$1')}"`
  return quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%')
}

export function desktopEntry(input: {
  installId: string
  name: string
  exec: string
  icon: string
}) {
  return `[Desktop Entry]
Type=Application
Version=1.0
Name=${value(input.name)}
Comment=${value(`${input.name}, an app of Brigade`)}
Exec=${execArg(input.exec)} --app=${input.installId}
Icon=${value(input.icon)}
Terminal=false
Categories=Utility;
StartupWMClass=${wmClass(input.installId)}
X-Brigade-App-Install-Id=${input.installId}
`
}

/** The install id an entry file names, if it is one of Brigade's. */
export function entryInstallId(text: string) {
  return /^X-Brigade-App-Install-Id=([0-9a-f]{32})$/m.exec(text)?.[1]
}

/**
 * When a just-installed app's window sets its WM_CLASS again (`setWmClass`, same value). GNOME
 * Shell reads new launcher entries 5 s after the last change to them (ShellAppCache), and the
 * install writes the entry, then mimeinfo.cache (update-desktop-database), then opens the window
 * at once: Shell found no entry for its WM_CLASS and took it for Brigade's, by its process, for
 * as long as the window lives. It looks the window's app up again on each WM_CLASS change, even
 * to the same value (tried on Ubuntu 24.04, GNOME Shell 46 on Xorg).
 */
export const WM_CLASS_AGAIN_MS = [7_000, 15_000]

/**
 * In how many ms a window of an app installed at `installedAt` sets its WM_CLASS again: those of
 * WM_CLASS_AGAIN_MS (from the install) still ahead. Any window opened then, not only the first:
 * closed and opened again at once, the second is as unknown to Shell as the first.
 */
export function wmClassAgainIn(installedAt: number, now = Date.now()) {
  const since = Number.isFinite(installedAt) ? Math.max(0, now - installedAt) : Infinity
  return WM_CLASS_AGAIN_MS.filter((ms) => ms > since).map((ms) => ms - since)
}

const WM_CLASS = 67 // predefined atoms
const STRING = 31

/**
 * Sets an X11 window's WM_CLASS (instance and class), before it is shown: docks read it when the
 * window maps. `handle` is Electron's getNativeWindowHandle(), the window's XID on X11.
 */
export function setWmClass(handle: Buffer, name: string, display = process.env.DISPLAY) {
  return new Promise<void>((done) => {
    if (!display || handle.length < 4) return done()
    const xid = handle.length >= 8 ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0)
    const timer = setTimeout(done, 3000)
    try {
      const client = x11.createClient({ display }, (error: Error | null, connection: any) => {
        if (error) {
          clearTimeout(timer)
          return done()
        }
        const X = connection.client as {
          ChangeProperty: (...args: unknown[]) => void
          GetInputFocus: (cb: (err: Error | null) => void) => void
          on: (event: string, listener: (...args: unknown[]) => void) => void
          terminate: () => void
        }
        X.on('error', () => undefined)
        X.ChangeProperty(0, xid, WM_CLASS, STRING, 8, Buffer.from(`${name}\0${name}\0`, 'latin1'))
        // A round trip: the property reached the server before the window shows.
        X.GetInputFocus(() => {
          clearTimeout(timer)
          X.terminate()
          done()
        })
      })
      client.on?.('error', () => {
        clearTimeout(timer)
        done()
      })
    } catch {
      clearTimeout(timer)
      done()
    }
  })
}
