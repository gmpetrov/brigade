#!/usr/bin/env node
// A package's tests, for CI (.github/workflows/ci.yml): each test file in a process of its own,
// a few at a time, as `node --test` runs them. A file that fails runs once more, alone, before
// it counts: one that fails now and then on a busy runner (a timing, a port) does not fail the
// pull request, and the job says which ones did. Failures show as annotations on the pull
// request, which anyone can read, unlike the job's log.
//
//   node scripts/ci/test.mjs <package folder> [node options...]
//   node scripts/ci/test.mjs apps/api --expose-gc --import tsx
//
// REQUIRE_DATABASE=1: a suite skipped because no database answers fails the run, rather than
// passing with its tests left out. TEST_CONCURRENCY: files run at once (one fewer than the CPUs).
import { spawn } from 'node:child_process'
import { appendFileSync, readdirSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'

const [folder, ...nodeOptions] = process.argv.slice(2)
if (!folder) {
  console.error('Usage: node scripts/ci/test.mjs <package folder> [node options...]')
  process.exit(2)
}
/** A file still running after this long is stopped and fails: one that hangs never holds the job. */
const FILE_TIMEOUT_MS = 5 * 60_000
const concurrency = Number(process.env.TEST_CONCURRENCY) || Math.max(1, availableParallelism() - 1)
const files = readdirSync(join(folder, 'test'))
  .filter((name) => /\.test\.(ts|mjs|js)$/.test(name))
  .sort()
  .map((name) => `test/${name}`)

/** One run of a test file: whether it passed, and what it printed. */
function run(file) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(
      process.execPath,
      [...nodeOptions, '--test', '--test-reporter=spec', file],
      {
        cwd: folder,
        env: process.env,
      },
    )
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, FILE_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      const skippedForDatabase =
        process.env.REQUIRE_DATABASE === '1' && /no database answers/.test(output)
      resolve({
        file,
        ok: code === 0 && !skippedForDatabase,
        why: timedOut
          ? `still running after ${FILE_TIMEOUT_MS / 60_000} minutes`
          : skippedForDatabase
            ? 'skipped: no database answers'
            : null,
        output,
        seconds: Math.round((Date.now() - started) / 100) / 10,
      })
    })
  })
}

/** Each item through `work`, `size` at a time. */
async function pool(items, size, work) {
  const results = []
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) results.push(await work(items[next++]))
    }),
  )
  return results
}

/** The failing tests a spec report lists at its end, with each one's first line of error. */
function failures(output) {
  const at = output.lastIndexOf('✖ failing tests:')
  if (at < 0) return []
  const lines = output.slice(at).split('\n').slice(1)
  const found = []
  for (let i = 0; i < lines.length; i++) {
    const name = lines[i].match(/^✖ (.*?)(?: \(\d[\d.]*m?s\))?$/)
    if (!name) continue
    const error =
      lines
        .slice(i + 1)
        .find((line) => line.trim())
        ?.trim() ?? ''
    found.push(`${name[1]}: ${error}`)
  }
  return found
}

/** GitHub's workflow command escapes: data, and a property's value. */
const data = (text) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
const property = (text) => data(text).replace(/:/g, '%3A').replace(/,/g, '%2C')

function annotate(level, result, title) {
  const tests = failures(result.output)
  const message = [
    result.why,
    ...tests.slice(0, 5),
    tests.length > 5 ? `and ${tests.length - 5} more` : null,
    tests.length || result.why ? null : result.output.trim().split('\n').slice(-8).join('\n'),
  ]
    .filter(Boolean)
    .join('\n')
  console.log(
    `::${level} file=${property(join(folder, result.file))},title=${property(title)}::${data(message)}`,
  )
}

/** A file's run, and a line saying how it went as it ends. */
async function report(file, attempt) {
  const result = await run(file)
  const how = result.ok ? 'passed' : `failed${result.why ? ` (${result.why})` : ''}`
  console.log(
    `${result.seconds.toFixed(1).padStart(6)} s  ${how}${attempt ? ', run again' : ''}: ${file}`,
  )
  return result
}

const started = Date.now()
const first = await pool(files, concurrency, (file) => report(file, 0))
const failed = first.filter((r) => !r.ok).map((r) => r.file)
// Once more, alone: what fails again counts.
const again = await pool(failed, 1, (file) => report(file, 1))
const broken = again.filter((r) => !r.ok)
const flaky = again.filter((r) => r.ok)

for (const result of broken) {
  console.log(`::group::${join(folder, result.file)} failed twice`)
  console.log(result.output)
  console.log('::endgroup::')
  annotate('error', result, `${result.file} failed`)
}
for (const result of flaky) annotate('warning', result, `${result.file} failed once, then passed`)

const slowest = [...first].sort((a, b) => b.seconds - a.seconds).slice(0, 5)
const summary = [
  `${folder}: ${files.length} test files in ${Math.round((Date.now() - started) / 1000)} s, ` +
    `${concurrency} at a time: ${broken.length} failed` +
    (flaky.length ? `, ${flaky.length} passed only when run again` : ''),
  ...broken.map((r) => `- failed: ${r.file}${r.why ? ` (${r.why})` : ''}`),
  ...flaky.map((r) => `- passed only when run again: ${r.file}`),
  `Slowest: ${slowest.map((r) => `${r.file} ${r.seconds} s`).join(', ')}`,
].join('\n')
console.log(summary)
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n\n`)
process.exit(broken.length ? 1 : 0)
