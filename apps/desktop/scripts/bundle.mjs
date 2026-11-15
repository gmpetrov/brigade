// Bundles the main process and the preloads into dist/ (CommonJS, as Electron loads them),
// with their dependencies (electron-updater) inlined: the packaged app needs no node_modules.
import { build } from 'esbuild'

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: 'linked',
  logLevel: 'warning',
}

await Promise.all([
  build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.js' }),
  // Preloads run sandboxed: only `electron` can be required there.
  build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.js' }),
  build({ ...common, entryPoints: ['src/setup-preload.ts'], outfile: 'dist/setup-preload.js' }),
  build({ ...common, entryPoints: ['src/find-preload.ts'], outfile: 'dist/find-preload.js' }),
])
