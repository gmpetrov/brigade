// Packaging Brigade.app with electron-builder (scripts/build.sh runs it): a universal app for
// macOS (.dmg to install, .zip for updates), an installer for Windows, an AppImage and a .deb for
// Linux, and the latest*.yml files installed apps read to update (src/updates.ts).
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const helper = join(__dirname, '..', 'computer-use-macos', 'build', 'Brigade Computer Use.app')

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'ai.brigade.desktop',
  productName: 'Brigade',
  copyright: 'Brigade',
  directories: { output: 'release/out', buildResources: 'build' },
  files: ['dist/**/*', '!dist/**/*.map', 'page/**/*', 'assets/**/*', 'package.json'],
  protocols: [{ name: 'Brigade', schemes: ['brigade'] }],
  // Where installed apps look for updates: the latest GitHub release's assets.
  publish: [
    { provider: 'generic', url: 'https://github.com/gmpetrov/brigade/releases/latest/download' },
  ],
  mac: {
    category: 'public.app-category.developer-tools',
    icon: 'assets/icon.icns',
    target: [
      { target: 'dmg', arch: ['universal'] },
      { target: 'zip', arch: ['universal'] },
    ],
    artifactName: 'Brigade-${version}-${arch}-mac.${ext}',
    minimumSystemVersion: '14.0',
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    extendInfo: {
      // The Tauri app's executable name, which its login item (~/Library/LaunchAgents/
      // Brigade.plist) starts: a Mac that updated from it still opens Brigade at login.
      CFBundleExecutable: 'brigade-desktop',
      // A menu-bar app: no Dock icon until the dashboard window opens (windows.ts).
      LSUIElement: true,
      NSMicrophoneUsageDescription: 'Brigade uses the microphone when you dictate a message.',
    },
    // Brigade Computer Use.app, built and signed by its own script, with its own identity:
    // macOS ties Screen Recording and Accessibility to that signature, so it is left as it is.
    ...(existsSync(helper) && {
      extraResources: [{ from: helper, to: 'Brigade Computer Use.app' }],
      signIgnore: ['Brigade Computer Use\\.app'],
    }),
    // Notarized when the release has Apple's keys (APPLE_API_KEY, _ID, _ISSUER).
    notarize: !!process.env.APPLE_API_KEY_ID,
  },
  // The name the dashboard links to (apps/web/lib/desktop-app.ts).
  dmg: { artifactName: 'Brigade.dmg' },
  win: {
    icon: 'assets/icon.ico',
    target: [{ target: 'nsis', arch: ['x64'] }],
  },
  nsis: {
    artifactName: 'Brigade-Setup.${ext}',
    oneClick: true,
    perMachine: false,
  },
  linux: {
    icon: 'assets/icon.png',
    category: 'Development',
    executableName: 'brigade-desktop',
    // Windows belong to the app's desktop entry (package.json's desktopName).
    syncDesktopName: true,
    synopsis: 'Run your Brigade teammates on this computer',
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
    ],
  },
  appImage: { artifactName: 'Brigade-x86_64.AppImage' },
  deb: { artifactName: 'brigade_${version}_amd64.deb' },
}
