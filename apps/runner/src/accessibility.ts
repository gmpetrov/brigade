// Accessibility for the commands teammates run on a member's Mac (agent-desktop,
// osascript with System Events, a desktop recorder…). macOS checks the app
// "responsible" for a process: Brigade.app when it started the runner, which asks
// for it on brigade://accessibility (apps/desktop/src-tauri/src/accessibility.rs);
// else the terminal the runner was started in. Brigade Computer Use holds its own,
// for the computer_* tools only.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const ACCESSIBILITY_SETTINGS =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'

/**
 * Which app macOS asks for the runner's commands: Brigade.app (`brigade`), an older Brigade.app that
 * can't ask for it yet (`brigade-old`: it set only the helper's path), or the terminal it was started in.
 */
export type Responsible = 'brigade' | 'brigade-old' | 'terminal'

export function responsibleApp(env: NodeJS.ProcessEnv = process.env): Responsible {
  if (env.BRIGADE_DESKTOP_APP) return 'brigade'
  if (env.BRIGADE_COMPUTER_USE_APP) return 'brigade-old'
  return 'terminal'
}

/** A command the runner starts, asked as any of its commands is: what they get is what this says. */
export async function accessibilityGranted(): Promise<boolean> {
  const { stdout } = await run(
    'osascript',
    ['-l', 'JavaScript', '-e', 'ObjC.import("ApplicationServices"); $.AXIsProcessTrusted()'],
    { timeout: 10_000 },
  )
  return stdout.trim() === 'true'
}

/** Opens a URL with macOS's `open`: brigade:// reaches the running Brigade.app. */
export async function openUrl(url: string) {
  await run('open', [url], { timeout: 10_000 })
}

export type AccessibilityDeps = {
  granted: () => Promise<boolean>
  responsible: () => Responsible
  open: (url: string) => Promise<void>
}

const ASK =
  'Turn on Brigade in the Accessibility list that just opened in System Settings (Privacy & Security): ' +
  'the commands your teammates run on this Mac can then click, type and read your apps’ windows. ' +
  'Turn it off there at any time to take it back.'

/** The check, and with `request` the ask, as the accessibility_permission tool answers it. */
export async function accessibility(deps: AccessibilityDeps, request: boolean) {
  if (await deps.granted())
    return {
      accessibility: 'granted' as const,
      note: 'Commands you start now get it; a command already running may need to be started again.',
    }
  const responsible = deps.responsible()
  if (responsible === 'terminal')
    return {
      accessibility: 'denied' as const,
      app: 'terminal',
      next:
        'The runner on this Mac was started in a terminal, so macOS asks for that terminal app, not Brigade. ' +
        'Ask the person to turn on that terminal app in System Settings → Privacy & Security → Accessibility, ' +
        'or to run teammates from Brigade.app instead.',
    }
  if (!request)
    return {
      accessibility: 'denied' as const,
      app: 'Brigade',
      next: 'Call again with request: true to ask the person for it, only when a command needs it.',
    }
  if (responsible === 'brigade-old') {
    await deps.open(ACCESSIBILITY_SETTINGS)
    return {
      accessibility: 'denied' as const,
      app: 'Brigade',
      requested: true,
      ask:
        'Brigade.app needs an update to ask for it itself. In the Accessibility list that just opened, ' +
        'add Brigade with + (in Applications) and turn it on: the commands your teammates run on this Mac ' +
        'can then click, type and read your apps’ windows. Turn it off there at any time to take it back.',
      next: 'Open a ticket (an action ask) with this line, then call again to check once they answer.',
    }
  }
  await deps.open('brigade://accessibility')
  return {
    accessibility: 'denied' as const,
    app: 'Brigade',
    requested: true,
    ask: ASK,
    next:
      'macOS showed its request and System Settings opened with Brigade in the list. Open a ticket ' +
      '(an action ask) with this line, then call again to check once they answer.',
  }
}

export const accessibilityDeps: AccessibilityDeps = {
  granted: accessibilityGranted,
  responsible: () => responsibleApp(),
  open: openUrl,
}
