// Packaging Brigade.app with electron-builder (scripts/build.sh runs it): a universal app for
// macOS (.dmg to install, .zip for updates), an installer for Windows, an AppImage and a .deb for
// Linux, and the latest*.yml files installed apps read to update (src/updates.ts).
// Windows is signed with Azure Artifact Signing (formerly Trusted Signing) when the release sets
// its account: AZURE_SIGNING_ENDPOINT, _ACCOUNT, _PROFILE and _PUBLISHER, signed in to Azure
// beforehand (desktop-release.yml). Without them, the installer is built unsigned.
const azure = process.env.AZURE_SIGNING_ENDPOINT
  ? {
      endpoint: process.env.AZURE_SIGNING_ENDPOINT,
      codeSigningAccountName: process.env.AZURE_SIGNING_ACCOUNT,
      certificateProfileName: process.env.AZURE_SIGNING_PROFILE,
      // The certificate's subject, the validated company name: installed apps check that an
      // update's installer was signed by it.
      publisherName: process.env.AZURE_SIGNING_PUBLISHER,
    }
  : null

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'ai.brigade.desktop',
  productName: 'Brigade',
  copyright: 'Brigade',
  directories: { output: 'release/out', buildResources: 'build' },
  files: ['dist/**/*', '!dist/**/*.map', 'page/**/*', 'assets/**/*', 'package.json'],
  afterPack: './scripts/after-pack.cjs',
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
      NSMicrophoneUsageDescription: 'Brigade uses the microphone when you dictate a message.',
    },
    // Brigade Computer Use.app, built and signed by its own script, with its own identity:
    // macOS ties Screen Recording and Accessibility to that signature, so it is left as it is.
    // scripts/after-pack.cjs puts it in, after the universal merge.
    signIgnore: ['Brigade Computer Use\\.app'],
    // Notarized when the release has Apple's keys (APPLE_API_KEY, _ID, _ISSUER).
    notarize: !!process.env.APPLE_API_KEY_ID,
  },
  // The name the dashboard links to (apps/web/lib/desktop-app.ts). Its window: "Drag me in!",
  // with the team waiting by Applications (build/background.png and @2x, from the design
  // Projects/Brigade/designs/installer.design). Finder draws the two icons at these points.
  dmg: {
    artifactName: 'Brigade.dmg',
    background: 'build/background.png',
    iconSize: 112,
    window: { width: 660, height: 400 },
    contents: [
      { x: 174, y: 256, type: 'file' },
      { x: 508, y: 256, type: 'link', path: '/Applications' },
    ],
  },
  win: {
    icon: 'assets/icon.ico',
    target: [{ target: 'nsis', arch: ['x64'] }],
    azureSignOptions: azure,
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
  // Names without the version: the dashboard links to the latest release's (apps/web/lib/linux-app.ts).
  deb: { artifactName: 'Brigade-amd64.deb' },
}
