// The setup checklist: a small window listing what this computer needs for Brigade, each step
// checked live (page/setup.js asks every 1.5 seconds) with the one action that fixes it. It
// opens on every launch while a step is missing, so a new customer never has to find it in the
// menu, and from the menu. Windows has nothing to set up: teammates don't run there yet.
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import * as autostart from './autostart.js'
import { ctx } from './context.js'
import { cancelQuit, stopForQuit } from './lifecycle.js'
import { showLogs } from './logs.js'
import { runnerSupported, workspace } from './runner.js'
import { dashboard } from './settings.js'

const SCREEN_SETTINGS =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
const ACCESSIBILITY_SETTINGS =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'

/** One row: done is null while it is on its way (installing, restarting). */
type Step = {
  id: string
  title: string
  detail: string
  done: boolean | null
  action: { id: string; label: string } | null
}

const step = (
  id: string,
  title: string,
  detail: string,
  done: boolean | null,
  action?: [string, string] | false,
): Step => ({
  id,
  title,
  detail,
  done,
  action: action ? { id: action[0], label: action[1] } : null,
})

export const hasSetup = () => runnerSupported()

/** "Mac" or "computer", as the checklist names this one. */
const computer = () => (process.platform === 'darwin' ? 'Mac' : 'computer')

export async function steps(): Promise<Step[]> {
  const steps: Step[] = []
  if (!hasSetup()) return steps

  // A development build runs from the repository: nothing to move.
  if (process.platform === 'darwin' && app.isPackaged) {
    const ok = app.isInApplicationsFolder()
    steps.push(
      step(
        'applications',
        'Brigade is in Applications',
        ok
          ? 'It updates itself from there.'
          : "It runs from the disk image or Downloads, where it can't update itself.",
        ok,
        !ok && ['move', 'Move to Applications'],
      ),
    )
  }

  const name = workspace()
  steps.push(
    step(
      'workspace',
      'Connected to a workspace',
      name
        ? `This computer runs ${name}'s teammates.`
        : 'In the dashboard, add this computer and open the link in Brigade.',
      !!name,
      !name && ['connect', 'Connect…'],
    ),
  )

  const status = ctx.supervisor.status
  const runner: Record<Status['kind'], [string, boolean | null, [string, string] | false]> = {
    running: ['Teammates can start work here.', true, false],
    elsewhere: ['A runner started in a terminal runs here instead.', true, false],
    installing: ['Setting up…', null, false],
    restarting: [
      `It stopped (${status.kind === 'restarting' ? status.reason : ''}) and starts again shortly.`,
      null,
      ['logs', 'Show logs'],
    ],
    notConnected: ['It starts once this computer is connected.', false, false],
    stopped: ['It is stopped.', false, ['restart', 'Start']],
    unsupported: ['Teammates run on macOS and Linux.', false, false],
  }
  const [detail, done, action] = runner[status.kind]
  steps.push(step('runner', 'The runner is running', detail, done, action))

  if (process.platform === 'darwin') {
    const helper = ctx.helper
    const permissions = await helper.permissions()
    const unknown = helper.app
      ? 'Checking Brigade Computer Use…'
      : 'This build of Brigade has no Brigade Computer Use.'
    steps.push(
      step(
        'screen',
        'Screen Recording',
        permissions?.screen
          ? 'Teammates can see your screen when you ask them to use your apps.'
          : permissions
            ? 'Turn on Brigade Computer Use in the list that opens.'
            : unknown,
        permissions ? permissions.screen : null,
        permissions && !permissions.screen && ['screen', 'Allow…'],
      ),
      step(
        'accessibility',
        'Accessibility',
        permissions?.accessibility
          ? 'Teammates can click and type in your apps when you ask them to.'
          : permissions
            ? 'Turn on Brigade Computer Use in the list that opens.'
            : unknown,
        permissions ? permissions.accessibility : null,
        permissions && !permissions.accessibility && ['accessibility', 'Allow…'],
      ),
    )
  }

  const login = autostart.isEnabled()
  steps.push(
    step(
      'login',
      'Opens at login',
      login
        ? 'Teammates can work here after a restart.'
        : "After a restart, teammates can't work here until you open Brigade.",
      login,
      !login && ['login', 'Turn on'],
    ),
  )
  return steps
}

type Status = typeof ctx.supervisor.status

/** The ids of the steps not done (in progress counts as not done). */
const missing = (steps: Step[]) => steps.filter((s) => s.done !== true).map((s) => s.id)

let window: BrowserWindow | undefined

async function act(id: string) {
  switch (id) {
    case 'move': {
      // Electron copies it to Applications, quits this copy and starts that one.
      // Kept open for unsaved edits: nothing moves.
      if (!(await stopForQuit())) return
      let moved = false
      try {
        moved = app.moveToApplicationsFolder({ conflictHandler: () => true })
      } catch {}
      if (!moved) {
        cancelQuit()
        throw new Error(
          'Brigade could not be copied to Applications: drag it there from the disk image.',
        )
      }
      return
    }
    case 'connect':
      return void (await shell.openExternal(`${dashboard()}/computers?desktop=1`))
    case 'restart':
      return void ctx.supervisor.start()
    case 'logs':
      return showLogs()
    case 'screen':
    case 'accessibility':
      // The helper asks macOS for its permissions when it starts; the list is where they're
      // turned on.
      ctx.helper.launch()
      return void (await shell.openExternal(
        id === 'screen' ? SCREEN_SETTINGS : ACCESSIBILITY_SETTINGS,
      ))
    case 'login':
      autostart.enable()
      return ctx.refreshMenu()
    case 'close':
      return window?.close()
    default:
      throw new Error(`unknown action ${id}`)
  }
}

export function registerSetup() {
  const fromSetup = (event: Electron.IpcMainInvokeEvent) =>
    !!window && !window.isDestroyed() && event.sender === window.webContents
  ipcMain.handle('setup:state', async (event) => {
    if (!fromSetup(event)) return null
    const list = await steps()
    return { steps: list, done: missing(list).length === 0, computer: computer() }
  })
  // Its error as a value: the page shows it under the step.
  ipcMain.handle('setup:action', async (event, id: unknown) => {
    if (!fromSetup(event) || typeof id !== 'string') return { error: 'Not allowed.' }
    try {
      await act(id)
      return {}
    } catch (error) {
      return { error: (error as Error).message }
    }
  })
}

export function show() {
  if (!hasSetup()) return
  if (window && !window.isDestroyed()) {
    window.show()
    window.focus()
    return
  }
  const created = new BrowserWindow({
    width: 480,
    height: 640,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'Set up Brigade',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'setup-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  window = created
  created.on('closed', () => {
    if (window === created) window = undefined
  })
  // Its page only: anything else it would open goes nowhere.
  created.webContents.on('will-navigate', (event) => event.preventDefault())
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  created.once('ready-to-show', () => {
    if (process.platform === 'darwin') app.focus({ steal: true })
    created.show()
    created.focus()
  })
  void created.loadFile(join(__dirname, '..', 'page', 'setup.html'))
}

/** On launch: opens the checklist when a step is missing. "Finish later" only closes it until
 * the next launch. */
export function showIfNeeded() {
  if (!hasSetup()) return
  // Let the runner start before judging it.
  setTimeout(() => {
    void steps().then((list) => {
      if (missing(list).length > 0) show()
    })
  }, 3_000)
}
