// Quitting: the runner stops first (it saves turns in progress, to carry on with them after the
// next start), then the app ends. Quit in the menu, an update's restart, a move to Applications,
// and macOS's own Quit (logging out, the Dock) all go through here.
import { app } from 'electron'
import { ctx } from './context.js'

let stopped = false

/** Stops the runner for good: whatever quits the app next goes through. */
export async function stopForQuit() {
  ctx.quitting = true
  await ctx.supervisor.stop()
  stopped = true
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
    void stopForQuit().then(() => app.quit())
  })
  // Closing its windows isn't quitting: Brigade lives in the menu bar.
  app.on('window-all-closed', () => {})
}
