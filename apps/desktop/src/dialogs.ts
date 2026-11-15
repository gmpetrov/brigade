// Alerts and questions. Brigade lives in the menu bar: it comes to the front first, or macOS
// shows them behind the app in front.
import { app, dialog } from 'electron'

function front() {
  if (process.platform === 'darwin') app.focus({ steal: true })
}

type Kind = 'info' | 'warning' | 'error'

export async function alert(title: string, message: string, type: Kind = 'info') {
  front()
  await dialog.showMessageBox({ type, title, message: title, detail: message, buttons: ['OK'] })
}

/** Whether the person picked `ok`. */
export async function confirm(options: {
  title: string
  message: string
  ok: string
  cancel?: string
  type?: Kind
}) {
  front()
  const { response } = await dialog.showMessageBox({
    type: options.type ?? 'info',
    title: options.title,
    message: options.title,
    detail: options.message,
    buttons: [options.ok, options.cancel ?? 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  return response === 0
}
