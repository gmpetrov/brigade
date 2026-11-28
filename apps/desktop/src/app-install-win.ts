// Windows: an installed app is a shortcut in the Start menu's Brigade Apps folder, which starts
// Brigade with --app=<installId> under an AppUserModelID of the app's own. Brigade opens the app's
// window with that id (app-windows.ts, setAppDetails), so the taskbar gives it a button of its
// own, with its icon, which pins and relaunches the app.
import { dirname, join, resolve } from 'node:path'

/** The AppUserModelID of an installed app's shortcut and window. */
export const appUserModelId = (installId: string) => `ai.brigade.desktop.app.${installId}`

/** %APPDATA%\Microsoft\Windows\Start Menu\Programs\Brigade Apps */
export const startMenuFolder = (appData = process.env.APPDATA ?? '') =>
  join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Brigade Apps')

/** Whether a path is a shortcut directly in that folder (what uninstall may remove). */
export const inStartMenuFolder = (path: string, folder = startMenuFolder()) =>
  dirname(resolve(path)).toLowerCase() === resolve(folder).toLowerCase() &&
  path.toLowerCase().endsWith('.lnk')

/**
 * An .ico holding the given PNGs, one image each: Windows Vista and later read PNG entries, which
 * keeps this a container and nothing more. `images` are [size in px, PNG bytes], 1 to 256 px.
 */
export function encodeIco(images: readonly [number, Buffer][]) {
  if (!images.length) throw new Error('An icon needs at least one image')
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1: an icon
  header.writeUInt16LE(images.length, 4)
  const entries: Buffer[] = []
  let offset = 6 + 16 * images.length
  for (const [size, png] of images) {
    if (!Number.isInteger(size) || size < 1 || size > 256) throw new Error(`Bad icon size ${size}`)
    const entry = Buffer.alloc(16)
    // 0 means 256.
    entry.writeUInt8(size === 256 ? 0 : size, 0)
    entry.writeUInt8(size === 256 ? 0 : size, 1)
    entry.writeUInt8(0, 2) // no palette
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // color planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += png.length
    entries.push(entry)
  }
  return Buffer.concat([header, ...entries, ...images.map(([, png]) => png)])
}

/** The sizes Windows draws an app's icon at, from the taskbar's to the Start menu's tiles. */
export const ICO_SIZES = [16, 24, 32, 48, 64, 256] as const

/** The command line a pinned taskbar button runs again. */
export const relaunchCommand = (execPath: string, installId: string) =>
  `"${execPath}" --app=${installId}`
