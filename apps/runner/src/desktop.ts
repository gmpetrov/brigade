// The cloud computer's desktop, as a person in control uses it through the
// dashboard. The display belongs to the desktop's own user: the root helper
// reaches it, the runner does not.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CLIPBOARD_MAX } from '@brigade/contracts'

const run = promisify(execFile)
const HELPER = '/usr/local/sbin/brigade-teammate'

/** Set the desktop's clipboard to `text`, or read it. Returns the clipboard text. */
export async function desktopClipboard(text?: string) {
  if (text === undefined) {
    const { stdout } = await run('sudo', ['-n', HELPER, 'clipboard', 'get'], {
      cwd: '/',
      maxBuffer: CLIPBOARD_MAX * 4,
      timeout: 5000,
    })
    return stdout.slice(0, CLIPBOARD_MAX)
  }
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      'sudo',
      ['-n', HELPER, 'clipboard', 'set'],
      { cwd: '/', timeout: 5000 },
      (error) => (error ? reject(error) : resolve()),
    )
    child.stdin?.end(text)
  })
  return text
}
