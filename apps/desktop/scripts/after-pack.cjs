// electron-builder's afterPack hook (electron-builder.config.cjs): puts Brigade Computer Use.app
// in the macOS app once it is whole. Not through extraResources: a universal build packs each
// architecture, then merges the two into one app, and the merge rewrites the helper's binary,
// which breaks the signature it was built with (Apple's notarization refused it: "The signature
// of the binary is invalid"). Added after the merge with ditto, the helper keeps its own
// signature, which its Screen Recording and Accessibility permissions are tied to; the app's
// signing leaves it as it is (`signIgnore`) and seals it in.
const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const HELPER = 'Brigade Computer Use.app'
const built = join(__dirname, '..', '..', 'computer-use-macos', 'build', HELPER)

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  // One architecture of a universal build, about to be merged: the helper comes after.
  if (context.appOutDir.endsWith('-temp')) return
  if (!existsSync(built)) {
    console.warn(`  • no ${HELPER} (macOS only, built by apps/computer-use-macos): left out`)
    return
  }
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const target = join(app, 'Contents', 'Resources', HELPER)
  execFileSync('rm', ['-rf', target])
  execFileSync('ditto', [built, target])
  execFileSync('codesign', ['--verify', '--strict', target])
}
