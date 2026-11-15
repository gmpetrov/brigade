import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { shell } from 'electron'
import { logFile } from './settings.js'

/** The runner's log: in Console on macOS, else in the app that opens text files. */
export function showLogs() {
  const file = logFile()
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '')
  }
  if (process.platform === 'darwin') execFile('open', ['-a', 'Console', file], () => {})
  else void shell.openPath(file)
}
