'use client'
// Guests (docs/guests.md): Brigade.app's window can start without a sign-in. The API makes a
// guest and signs this window in as them (src/guests.ts there); their project is made here as
// onboarding makes one, and onboarding goes on from its next step. Later, the guest saves the
// account with an email and a code mailed to it.
import { api, type Me } from '@/lib/api'
import { authClient } from '@/lib/auth-client'
import { desktopPlatform, inCaptureWindow, inDesktopApp } from '@/lib/brigade-app'
import { markSignedIn } from '@/lib/signed-in'
import { signupSourceHere } from '@/lib/signup-source'

/** A guest's first project, renamed whenever they like. */
const FIRST_PROJECT = 'My project'

/**
 * Whether this window may offer to start without an account: Brigade.app's main window, on a
 * computer its runner works on (teammates do not run on Windows yet), with guests open.
 */
export async function guestOffered() {
  if (!inDesktopApp() || inCaptureWindow() || desktopPlatform() === 'win32') return false
  const { data } = await authClient.$fetch<{ available: boolean }>('/guest/available')
  return !!data?.available
}

const slug = () => `my-project-${Math.random().toString(36).slice(2, 8)}`

/** Become a guest, with a first project, ready for onboarding's next step. */
export async function startAsGuest() {
  const source = signupSourceHere()
  const started = await authClient.$fetch('/guest', {
    method: 'POST',
    body: source ? { signupSource: source } : {},
  })
  if (started.error) throw new Error(started.error.message ?? 'Could not start Brigade')
  markSignedIn()
  const made = await authClient.organization.create({ name: FIRST_PROJECT, slug: slug() })
  if (made.error) throw new Error(made.error.message ?? 'Could not make your project')
  // Reading /me makes the new organization the session's.
  await api<Me>('/me')
  await api('/workspaces', { body: { name: FIRST_PROJECT } })
}

/** Mail a code to the address the guest saves their account with. */
export async function sendSavingCode(email: string) {
  const { error } = await authClient.$fetch('/guest/save/code', {
    method: 'POST',
    body: { email },
  })
  if (error) throw new Error(error.message ?? 'Could not send the code')
}

/** Save the guest's account with that address, once its code is right. */
export async function saveAccount(email: string, code: string) {
  const { error } = await authClient.$fetch('/guest/save', {
    method: 'POST',
    body: { email, code },
  })
  if (error) throw new Error(error.message ?? 'Could not save your account')
}
