import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { infoPlist, inAppsFolder, ownFolder, plistValue } from '../src/app-install-mac.js'
import {
  desktopEntry,
  entryInstallId,
  execArg,
  isAppEntry,
  wmClass,
} from '../src/app-install-linux.js'
import {
  appUserModelId,
  encodeIco,
  inStartMenuFolder,
  relaunchCommand,
} from '../src/app-install-win.js'
import {
  appArg,
  byAppId,
  fileName,
  forget,
  imitates,
  installName,
  list,
  listIn,
  newInstallId,
  save,
  update,
  validInstallId,
  type InstalledApp,
} from '../src/installed-apps.js'
import { loadSettings } from '../src/settings.js'

const ID = '0123456789abcdef0123456789abcdef'

const entry = (over: Partial<InstalledApp> = {}): InstalledApp => ({
  installId: ID,
  appId: 'doc_1',
  path: 'Projects/Brigade/clip-review.webapp',
  name: 'Clip review',
  workspaceId: 'ws_1',
  workspaceName: 'Acme',
  installedPath: '/Users/ada/Applications/Brigade Apps/Clip review.app',
  cdhash: 'af91057ff4032547b86922efb798f75a8d2e6934',
  installedAt: '2026-11-28T00:00:00.000Z',
  ...over,
})

test('install ids are 16 random bytes in hex', () => {
  const a = newInstallId()
  assert.match(a, /^[0-9a-f]{32}$/)
  assert.notEqual(a, newInstallId())
  assert.equal(validInstallId(a), true)
  assert.equal(validInstallId('../x'), false)
  assert.equal(validInstallId(ID.toUpperCase()), false)
})

test('--app= names an install; anything else is no app', () => {
  assert.equal(appArg(['/opt/Brigade/brigade-desktop', `--app=${ID}`]), ID)
  assert.equal(appArg(['brigade', '--app=']), undefined)
  assert.equal(appArg(['brigade', '--app=../../etc']), undefined)
  assert.equal(appArg(['brigade', `--app=${ID}x`]), undefined)
  assert.equal(appArg(['brigade', 'brigade://link?code=1']), undefined)
  // The first good one, as Windows may pass the shortcut's arguments after others.
  assert.equal(appArg(['brigade', '--app=nope', `--app=${ID}`]), ID)
})

test('the list in the settings keeps whole entries and other keys', () => {
  process.env.BRIGADE_HOME = mkdtempSync(join(tmpdir(), 'brigade-apps-'))
  writeFileSync(join(process.env.BRIGADE_HOME, 'desktop.json'), JSON.stringify({ keepAwake: true }))
  assert.deepEqual(list(), [])
  save(entry())
  save(entry({ installId: 'f'.repeat(32), appId: 'doc_2', name: 'Tracker' }))
  assert.equal(list().length, 2)
  assert.equal(byAppId('doc_2')?.name, 'Tracker')
  // Saved again: replaced, not added.
  save(entry({ name: 'Clip review 2' }))
  assert.equal(list().length, 2)
  update(ID, (a) => {
    a.installedPath = '/elsewhere/Clip review.app'
  })
  assert.equal(byAppId('doc_1')?.installedPath, '/elsewhere/Clip review.app')
  forget(ID)
  assert.deepEqual(
    list().map((a) => a.appId),
    ['doc_2'],
  )
  assert.equal(loadSettings().keepAwake, true)
  // What a broken or hand-edited file holds is left out.
  assert.deepEqual(
    listIn({
      installedApps: [
        entry({ installId: 'nope' }),
        entry({ cdhash: 'not hex' }),
        { ...entry(), name: '' },
        null,
        'x',
        entry(),
      ],
    }).length,
    1,
  )
  assert.deepEqual(listIn({ installedApps: 'x' }), [])
})

test('a title becomes a file name every system takes', () => {
  assert.equal(fileName('Clip review'), 'Clip review')
  assert.equal(fileName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j')
  assert.equal(fileName('..hidden'), 'hidden')
  assert.equal(fileName('trailing. . '), 'trailing')
  assert.equal(fileName('\u0000\u0007'), 'App')
  assert.equal(fileName('   '), 'App')
  assert.equal(fileName('CON'), 'CON app')
  assert.equal([...fileName('x'.repeat(200))].length, 60)
  // Characters beyond the first plane count as one.
  assert.equal([...fileName('🎬'.repeat(70))].length, 60)
})

test('names that pass for Brigade, Apple or the system get (App)', () => {
  for (const name of [
    'Brigade',
    'brigade helper',
    'Apple Pay',
    'Finder',
    'System Settings',
    'App Store',
    'macOS Update',
    'Microsoft Teams',
    'iCloud Drive',
    'Finder.',
    'BrigadeHelper',
    'Ｆｉｎｄｅｒ',
  ])
    assert.equal(imitates(name), true, name)
  for (const name of ['Clip review', 'Launch tracker', 'Mailbox stats', 'Applesauce board'])
    assert.equal(imitates(name), false, name)
  const none = () => false
  assert.equal(installName('Finder', { id: 'w', name: 'Acme' }, [], none), 'Finder (App)')
})

test('a name taken gets " 2", and one from another workspace gets its name', () => {
  const ws = { id: 'ws_1', name: 'Acme' }
  const files = new Set(['Clip review', 'Clip review 2'])
  assert.equal(
    installName('Clip review', ws, [], (n) => files.has(n)),
    'Clip review 3',
  )
  const other = [{ name: 'Clip review', workspaceId: 'ws_2' }]
  assert.equal(
    installName('Clip review', ws, other, (n) => n === 'Clip review'),
    'Clip review (Acme)',
  )
  // The same workspace twice is two installs of one name: numbered.
  const same = [{ name: 'Clip review', workspaceId: 'ws_1' }]
  assert.equal(
    installName('Clip review', ws, same, (n) => n === 'Clip review'),
    'Clip review 2',
  )
})

test("the shim's Info.plist escapes what it holds and names the host", () => {
  const text = infoPlist({
    installId: ID,
    name: 'Tom & Jerry <"board">\u0001',
    hostPath: '/Applications/Brigade.app',
    hostBundleId: 'ai.brigade.desktop',
    minimumSystemVersion: '14.0',
  })
  assert.match(text, /<key>CFBundleName<\/key>\n\t<string>Tom &amp; Jerry &lt;&quot;board&quot;&gt;<\/string>/)
  assert.doesNotMatch(text, /\u0001/)
  assert.match(text, new RegExp(`<string>ai.brigade.desktop.app.${ID}</string>`))
  assert.match(text, /<key>ElectronAppShimServerName<\/key>\n\t<string>brigade-apps<\/string>/)
  assert.match(text, /<key>ElectronAppShimHostArguments<\/key>\n\t<array><string>--app-shim<\/string><\/array>/)
  assert.match(text, /<key>BrigadeAppInstallId<\/key>\n\t<string>0123456789abcdef/)
  if (process.platform === 'darwin') {
    // macOS itself reads it back.
    const bundle = join(mkdtempSync(join(tmpdir(), 'brigade-shim-')), 'x.app')
    mkdirSync(join(bundle, 'Contents'), { recursive: true })
    writeFileSync(join(bundle, 'Contents', 'Info.plist'), text)
    execFileSync('/usr/bin/plutil', ['-lint', join(bundle, 'Contents', 'Info.plist')])
    assert.equal(plistValue(bundle, 'CFBundleName'), 'Tom & Jerry <"board">')
    assert.equal(plistValue(bundle, 'BrigadeAppInstallId'), ID)
    assert.equal(plistValue(bundle, 'ElectronAppShimHostPath'), '/Applications/Brigade.app')
  }
})

test('only bundles in the apps folder may be removed, and links are refused', () => {
  assert.equal(inAppsFolder('/Users/a/Applications/Brigade Apps/X.app', '/Users/a/Applications/Brigade Apps'), true)
  assert.equal(inAppsFolder('/Users/a/Applications/Brigade Apps/../X.app', '/Users/a/Applications/Brigade Apps'), false)
  assert.equal(inAppsFolder('/Users/a/Applications/Brigade Apps/X', '/Users/a/Applications/Brigade Apps'), false)
  assert.equal(inAppsFolder('/Applications/Brigade.app', '/Users/a/Applications/Brigade Apps'), false)
  if (process.platform === 'win32') return
  const dir = mkdtempSync(join(tmpdir(), 'brigade-folder-'))
  ownFolder(join(dir, 'made'))
  assert.equal(existsSync(join(dir, 'made')), true)
  symlinkSync(join(dir, 'made'), join(dir, 'link'))
  assert.throws(() => ownFolder(join(dir, 'link')), /not a folder/)
})

test('an .ico holds each PNG with its size', () => {
  const a = Buffer.from('png-16')
  const b = Buffer.from('png-256-longer')
  const ico = encodeIco([
    [16, a],
    [256, b],
  ])
  assert.equal(ico.readUInt16LE(0), 0)
  assert.equal(ico.readUInt16LE(2), 1)
  assert.equal(ico.readUInt16LE(4), 2)
  // First entry: 16px, its bytes right after the directory.
  assert.equal(ico.readUInt8(6), 16)
  assert.equal(ico.readUInt16LE(6 + 6), 32)
  assert.equal(ico.readUInt32LE(6 + 8), a.length)
  assert.equal(ico.readUInt32LE(6 + 12), 6 + 32)
  // 256 is written as 0.
  assert.equal(ico.readUInt8(22), 0)
  assert.equal(ico.readUInt32LE(22 + 12), 6 + 32 + a.length)
  assert.deepEqual(ico.subarray(6 + 32, 6 + 32 + a.length), a)
  assert.deepEqual(ico.subarray(ico.length - b.length), b)
  assert.throws(() => encodeIco([]))
  assert.throws(() => encodeIco([[512, a]]))
})

test("Windows' shortcut names the install", () => {
  assert.equal(appUserModelId(ID), `ai.brigade.desktop.app.${ID}`)
  assert.equal(
    relaunchCommand('C:\\Users\\a\\AppData\\Local\\Programs\\Brigade\\Brigade.exe', ID),
    `"C:\\Users\\a\\AppData\\Local\\Programs\\Brigade\\Brigade.exe" --app=${ID}`,
  )
  const folder = join('/appdata', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Brigade Apps')
  assert.equal(inStartMenuFolder(join(folder, 'Clip review.lnk'), folder), true)
  assert.equal(inStartMenuFolder(join(folder, 'Clip review.exe'), folder), false)
  assert.equal(inStartMenuFolder(join(folder, '..', 'Clip review.lnk'), folder), false)
})

test('the desktop entry quotes its Exec and names its window class', () => {
  assert.equal(execArg('/opt/Brigade/brigade-desktop'), '"/opt/Brigade/brigade-desktop"')
  // A quote, a dollar, a backtick, a backslash and a percent, each escaped as the spec says.
  assert.equal(execArg('/a "b" $c `d` \\e 50%'), '"/a \\\\"b\\\\" \\\\$c \\\\`d\\\\` \\\\\\\\e 50%%"')
  const text = desktopEntry({
    installId: ID,
    name: 'Clip\nreview',
    exec: '/home/a/Apps/Brigade x86_64.AppImage',
    icon: '/home/a/.config/Brigade/Installed apps/x.png',
  })
  assert.match(text, /^Name=Clip review$/m)
  assert.match(text, new RegExp(`^Exec="/home/a/Apps/Brigade x86_64.AppImage" --app=${ID}$`, 'm'))
  assert.match(text, new RegExp(`^StartupWMClass=${wmClass(ID)}$`, 'm'))
  assert.equal(entryInstallId(text), ID)
  assert.equal(entryInstallId('[Desktop Entry]\nName=x\n'), undefined)
  assert.equal(isAppEntry(`/h/.local/share/applications/brigade-app-${ID}.desktop`, '/h/.local/share/applications'), true)
  assert.equal(isAppEntry('/h/.local/share/applications/brigade-desktop.desktop', '/h/.local/share/applications'), false)
  if (process.platform === 'linux') {
    // desktop-file-validate, where the desktop has it (CI's Ubuntu does once installed).
    const file = join(mkdtempSync(join(tmpdir(), 'brigade-entry-')), `brigade-app-${ID}.desktop`)
    writeFileSync(file, text)
    try {
      execFileSync('desktop-file-validate', [file], { stdio: 'pipe' })
    } catch (error) {
      const e = error as NodeJS.ErrnoException & { stdout?: Buffer }
      if (e.code !== 'ENOENT') assert.fail(String(e.stdout ?? e))
    }
    assert.equal(readFileSync(file, 'utf8'), text)
  }
})
