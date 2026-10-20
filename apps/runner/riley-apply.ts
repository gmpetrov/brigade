import { readFileSync, writeFileSync } from 'node:fs'
import { coreLength, layOutMemoryFile, parseMemoryFile } from '@brigade/contracts'
import { tidyRun } from './src/memory-tidy.js'
const [file, scope, answer, out] = process.argv.slice(2)
const text = readFileSync(file!, 'utf8')
const run = tidyRun({ ref: { kind: 'project', projectId: 'p' }, scope: scope as never, about: 'x', text, meta: {}, fresh: new Set(), lastTidied: null }, new Date('2026-10-20T14:00:00Z'))
const layout = run.parse(readFileSync(answer!, 'utf8'))
if (!layout) { console.log('PARSE FAILED (or too much taken away)'); process.exit(1) }
const result = layOutMemoryFile(text, layout)
writeFileSync(out!, result.text)
const before = parseMemoryFile(text), after = parseMemoryFile(result.text)
const count = (l: ReturnType<typeof parseMemoryFile>) => l.core.length + l.topics.reduce((n, t) => n + t.lines.length, 0)
console.log(`lines ${count(before)} -> ${count(after)}; chars ${text.length} -> ${result.text.length}; core ${coreLength(before)} -> ${coreLength(after)} chars (${after.core.length} lines)`)
console.log(`topics ${after.topics.length}: ${after.topics.map((t) => `${t.name} (${t.lines.length})`).join(', ')}`)
console.log(`merged ${result.merged.length} (from ${result.merged.reduce((n, m) => n + m.from.length, 0)} lines), archived ${result.archived.length}, moved ${result.moved.length}`)
