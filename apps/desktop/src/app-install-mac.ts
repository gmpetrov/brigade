// macOS: an installed app is an app shim (Electron 45's app shims, as Chrome's web apps and
// Claude's installed artifacts): a small bundle in ~/Applications/Brigade Apps whose executable
// is Electron's `app_shim_loader`. Launched, it loads Brigade.app's own Electron framework,
// starts Brigade.app if it isn't running (with --app-shim), and connects to it; Brigade then
// opens the app's window in the shim's process, so it has its own Dock icon, ⌘-Tab entry, menu
// bar and badge (app-windows.ts). The bundle is signed ad hoc here, on this Mac, and Brigade
// keeps its cdhash: any local process may connect to the shim server, and only a shim with that
// exact signature and a known install id gets a window.
import { execFile, execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** The name the shims connect to (`ElectronAppShimServerName`), and Brigade.app listens on. */
export const SHIM_SERVER = 'brigade-apps'

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

/** ~/Applications/Brigade Apps: where installed apps go. */
export const appsFolder = (home = process.env.HOME || homedir()) =>
  join(home, 'Applications', 'Brigade Apps')

/** Brigade.app's own bundle, from its executable (…/Brigade.app/Contents/MacOS/brigade-desktop). */
export const hostBundle = (execPath = process.execPath) => resolve(execPath, '..', '..', '..')

export const shimLoader = (host: string) =>
  join(
    host,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Versions',
    'A',
    'Helpers',
    'app_shim_loader',
  )

const xml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // XML 1.0 allows no other control characters, even escaped.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')

export type PlistInput = {
  installId: string
  name: string
  hostPath: string
  hostBundleId: string
  minimumSystemVersion: string
}

/** The shim's Info.plist: what Launch Services, the Dock and the shim loader read. */
export function infoPlist(p: PlistInput) {
  const entry = (key: string, value: string | string[] | boolean) =>
    `\t<key>${xml(key)}</key>\n\t${
      typeof value === 'boolean'
        ? value
          ? '<true/>'
          : '<false/>'
        : Array.isArray(value)
          ? `<array>${value.map((v) => `<string>${xml(v)}</string>`).join('')}</array>`
          : `<string>${xml(value)}</string>`
    }`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${[
  entry('CFBundleDevelopmentRegion', 'en'),
  entry('CFBundleExecutable', 'app'),
  entry('CFBundleIconFile', 'app'),
  entry('CFBundleIdentifier', `${p.hostBundleId}.app.${p.installId}`),
  entry('CFBundleInfoDictionaryVersion', '6.0'),
  entry('CFBundleName', p.name),
  entry('CFBundleDisplayName', p.name),
  entry('CFBundlePackageType', 'APPL'),
  entry('CFBundleShortVersionString', '1.0'),
  entry('CFBundleVersion', '1'),
  entry('LSMinimumSystemVersion', p.minimumSystemVersion),
  entry('NSHighResolutionCapable', true),
  entry('NSSupportsAutomaticGraphicsSwitching', true),
  entry('BrigadeAppInstallId', p.installId),
  entry('ElectronAppShimHostPath', p.hostPath),
  entry('ElectronAppShimHostBundleIdentifier', p.hostBundleId),
  entry('ElectronAppShimServerName', SHIM_SERVER),
  entry('ElectronAppShimHostArguments', ['--app-shim']),
].join('\n')}
</dict>
</plist>
`
}

/** A key of a bundle's Info.plist, as text, or undefined. */
export function plistValue(bundle: string, key: string): string | undefined {
  try {
    return execFileSync(
      '/usr/bin/plutil',
      ['-extract', key, 'raw', '-o', '-', join(bundle, 'Contents', 'Info.plist')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
    ).trim()
  } catch {
    return undefined
  }
}

/** Brigade.app's bundle id and minimum macOS, from its own Info.plist. */
export function hostInfo(host = hostBundle()) {
  return {
    bundleId: plistValue(host, 'CFBundleIdentifier') ?? 'ai.brigade.desktop',
    minimumSystemVersion: plistValue(host, 'LSMinimumSystemVersion') ?? '14.0',
  }
}

/**
 * The app's icon as an .icns, from a PNG of at least 512px: sips makes each size of an iconset,
 * iconutil packs them. Both are part of macOS.
 */
async function writeIcns(png: string, icns: string, work: string) {
  const set = join(work, 'app.iconset')
  mkdirSync(set, { recursive: true })
  const sizes: [string, number][] = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024],
  ]
  for (const [name, size] of sizes)
    await run('/usr/bin/sips', ['-z', String(size), String(size), png, '--out', join(set, name)], {
      timeout: 15_000,
    })
  await run('/usr/bin/iconutil', ['-c', 'icns', set, '-o', icns], { timeout: 15_000 })
  rmSync(set, { recursive: true, force: true })
}

/** The cdhash of a bundle's signature, as codesign prints it (40 hex digits). */
export async function cdhashOf(bundle: string) {
  const { stderr } = await run('/usr/bin/codesign', ['-dvvv', bundle], { timeout: 15_000 })
  const hash = /^CDHash=([0-9a-f]{40})$/m.exec(stderr)?.[1]
  if (!hash) throw new Error('The app was signed, but its signature could not be read')
  return hash
}

/** Signs a bundle ad hoc: this Mac's own signature, which macOS asks of every app it runs. */
async function sign(bundle: string) {
  await run('/usr/bin/codesign', ['--force', '--sign', '-', bundle], { timeout: 30_000 })
  return cdhashOf(bundle)
}

/**
 * A folder of Brigade's to write in: made when missing; refused when it is a link (it could
 * point anywhere) or belongs to someone else.
 */
export function ownFolder(path: string) {
  mkdirSync(path, { recursive: true })
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(`${path} is not a folder Brigade can install apps in`)
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    throw new Error(`${path} belongs to another account`)
}

/** Whether `path` is a bundle directly in the apps folder (what uninstall may remove). */
export const inAppsFolder = (path: string, folder = appsFolder()) =>
  dirname(resolve(path)) === resolve(folder) && path.endsWith('.app')

export type Built = { bundle: string; cdhash: string }

/**
 * Makes the app's bundle in `staging` (Brigade.app's own folder), signs it, and moves it into
 * ~/Applications/Brigade Apps as `<name>.app`. `name` is free there (installName's `taken`); a
 * name taken meanwhile fails rather than replace anything.
 */
export async function buildShim(input: {
  installId: string
  name: string
  iconPng: string
  staging: string
  folder?: string
}): Promise<Built> {
  const folder = input.folder ?? appsFolder()
  const host = hostBundle()
  const loader = shimLoader(host)
  if (!existsSync(loader))
    throw new Error('This copy of Brigade cannot install apps: its app shim loader is missing')
  const { bundleId, minimumSystemVersion } = hostInfo(host)
  const work = join(input.staging, input.installId)
  rmSync(work, { recursive: true, force: true })
  const staged = join(work, 'app.app')
  const contents = join(staged, 'Contents')
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  mkdirSync(join(contents, 'Resources'), { recursive: true })
  try {
    copyFileSync(loader, join(contents, 'MacOS', 'app'))
    writeFileSync(
      join(contents, 'Info.plist'),
      infoPlist({
        installId: input.installId,
        name: input.name,
        hostPath: host,
        hostBundleId: bundleId,
        minimumSystemVersion,
      }),
    )
    writeFileSync(join(contents, 'PkgInfo'), 'APPL????')
    await writeIcns(input.iconPng, join(contents, 'Resources', 'app.icns'), work)
    const cdhash = await sign(staged)

    ownFolder(dirname(folder))
    ownFolder(folder)
    const bundle = join(folder, `${input.name}.app`)
    // Claimed first: an empty folder of that name, made only if nothing has it, which the
    // rename then replaces. Something there already (another app, or one made meanwhile) is
    // never written over.
    mkdirSync(bundle)
    try {
      renameSync(staged, bundle)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
        rmSync(bundle, { recursive: true, force: true })
        throw error
      }
      // Brigade's folder on another volume: copied beside the target first, then renamed.
      const near = join(folder, `.${input.installId}.app`)
      rmSync(near, { recursive: true, force: true })
      await run('/bin/cp', ['-R', staged, near])
      renameSync(near, bundle)
    }
    return { bundle, cdhash }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** Tells Launch Services about the bundle, so the Dock, Spotlight and `open` find it at once. */
export async function register(bundle: string) {
  await run(LSREGISTER, ['-f', bundle], { timeout: 30_000 }).catch(() => undefined)
}

/** Launches the shim: it connects to Brigade.app, which opens its window. */
export async function launch(bundle: string) {
  await run('/usr/bin/open', [bundle], { timeout: 30_000 })
}

/** Removes a bundle Brigade made: only one in the apps folder whose install id is this one. */
export async function removeShim(bundle: string, installId: string) {
  if (!inAppsFolder(bundle)) return false
  if (!existsSync(bundle)) return true
  if (plistValue(bundle, 'BrigadeAppInstallId') !== installId) return false
  await run(LSREGISTER, ['-u', bundle], { timeout: 30_000 }).catch(() => undefined)
  rmSync(bundle, { recursive: true, force: true })
  return true
}

/**
 * Brigade.app moved (to Applications, or renamed): each shim names the old path, so it is
 * rewritten and signed again. A new cdhash, which the list keeps.
 */
export async function pointAtHost(bundle: string): Promise<string | undefined> {
  const host = hostBundle()
  if (plistValue(bundle, 'ElectronAppShimHostPath') === host) return undefined
  const plist = join(bundle, 'Contents', 'Info.plist')
  const text = readFileSync(plist, 'utf8')
  const key = '<key>ElectronAppShimHostPath</key>'
  const at = text.indexOf(key)
  if (at < 0) return undefined
  const rest = text.slice(at + key.length)
  const replaced = rest.replace(/^(\s*)<string>[^<]*<\/string>/, `$1<string>${xml(host)}</string>`)
  writeFileSync(plist, text.slice(0, at + key.length) + replaced)
  return sign(bundle)
}

/** Whether this path looks like it is inside a running app bundle (not `electron .`). */
export const packagedHost = (execPath = process.execPath) =>
  execPath.includes(`.app${sep}Contents${sep}MacOS${sep}`)
