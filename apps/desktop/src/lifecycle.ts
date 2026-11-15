// Quitting: the runner stops first (it saves turns in progress, to carry on with them after the
// next start), then the app ends. Quit in the menu, an update's restart, a move to Applications,
// and macOS's own Quit (logging out, the Dock) all go through here.
import { app } from 'electron'
import { ctx } from './context.js'
import { closeDashboard } from './windows.js'

let stopped = false

/** Stops the runner for good: whatever quits the app next goes through. The dashboard is asked
 * first: with unsaved edits the person may keep it, and Brigade then doesn't quit (false). */
export async function stopForQuit() {
  if (!(await closeDashboard())) return false
  ctx.quitting = true
  await ctx.supervisor.stop()
  stopped = true
  return true
}

/** A quit that did not happen after all (the move to Applications failed): the runner again. */
export function cancelQuit() {
  ctx.quitting = false
  stopped = false
  void ctx.supervisor.start()
}

export function handleQuit() {
  app.on('before-quit', (event) => {
    if (stopped) return
    event.preventDefault()
    void stopForQuit().then((quit) => quit && app.quit())
  })
  // Closing its windows isn't quitting: Brigade keeps running, in the Dock and the menu bar.
  app.on('window-all-closed', () => {})
}
