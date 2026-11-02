// How a project's settings page (app/app/projects/[id]/settings) keeps track of its saves, which
// go one at a time while the person goes on changing other fields.

/**
 * The preferred accounts once `chosen` is picked among one App's `accounts` (null: no preference):
 * the App's other accounts leave the list, other Apps' stay. Built on the list as the last pick left
 * it, not on the project as last loaded, so two picks made before the first save returns both stay.
 */
export function preferAccount(preferred: string[], accounts: string[], chosen: string | null) {
  const app = new Set(accounts)
  const others = preferred.filter((id) => !app.has(id))
  return chosen ? [...others, chosen] : others
}

/**
 * How a section's saves stand. An error stays with its field until that field saves, so a later
 * save of another field never hides it.
 */
export type SaveState = { saving: number; errors: Record<string, string>; saved: boolean }

export const idle: SaveState = { saving: 0, errors: {}, saved: false }

export function saveStarted(state: SaveState): SaveState {
  return { ...state, saving: state.saving + 1, saved: false }
}

export function saveFailed(state: SaveState, fields: string[], message: string): SaveState {
  const errors = { ...state.errors }
  for (const field of fields) errors[field] = message
  return { saving: Math.max(0, state.saving - 1), errors, saved: false }
}

export function saveSucceeded(state: SaveState, fields: string[]): SaveState {
  const errors = { ...state.errors }
  for (const field of fields) delete errors[field]
  const saving = Math.max(0, state.saving - 1)
  return { saving, errors, saved: saving === 0 }
}

/** An error found before saving (an image that cannot be a logo); null clears it. */
export function fieldError(state: SaveState, field: string, message: string | null): SaveState {
  const errors = { ...state.errors }
  if (message) errors[field] = message
  else delete errors[field]
  return { ...state, errors, saved: false }
}

/** What the section says: its errors first, then whether it is saving or just saved. */
export function saveMessage(state: SaveState): { error: boolean; text: string } | null {
  const errors = [...new Set(Object.values(state.errors))]
  if (errors.length) return { error: true, text: errors.join(' ') }
  if (state.saving) return { error: false, text: 'Saving…' }
  if (state.saved) return { error: false, text: 'Saved' }
  return null
}
