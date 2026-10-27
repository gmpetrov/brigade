// Type-check the Workers' own files with Cloudflare's types (tsconfig.workers.json). The rest of
// the API is checked with Node's (tsconfig.json); where the two sets of types disagree in those
// modules, the errors are not the Workers' files' own and are left out here.
import { execFileSync } from 'node:child_process'

const WORKERS_FILES = [
  'src/worker.ts',
  'src/worker-env.ts',
  'src/front.ts',
  'src/api-object.ts',
  'src/hub-object.ts',
  'src/platform/workers.ts',
  'src/platform/jsdom.workers.ts',
]

let output = ''
try {
  execFileSync('tsc', ['-p', 'tsconfig.workers.json'], { encoding: 'utf8', stdio: 'pipe' })
} catch (error) {
  output = `${error.stdout ?? ''}${error.stderr ?? ''}`
}
const errors = output
  .split('\n')
  .filter((line) => / error TS\d+/.test(line))
  .filter((line) => WORKERS_FILES.some((file) => line.startsWith(`${file}(`)))
if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}
console.log('Workers files: no type errors')
