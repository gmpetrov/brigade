'use client'
import { useState } from 'react'
import { useDashboard } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { authClient } from '@/lib/auth-client'
import { markSignedOut } from '@/lib/signed-in'

/**
 * In the browser, opened by Brigade.app's window to sign it in (lib/brigade-app.ts): this
 * session issues a one-time code, which goes back to the app as brigade://sign-in?code=….
 * Only on a click: a page that sent codes by itself would sign the app in from any link.
 */
export default function DesktopSignIn() {
  const { me } = useDashboard()
  const [challenge] = useState(() =>
    typeof window === 'undefined' ? null : new URLSearchParams(location.search).get('challenge'),
  )
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle')
  const [error, setError] = useState<string>()

  async function open() {
    if (!challenge) return
    setError(undefined)
    setState('busy')
    const { data, error } = await authClient.$fetch<{ code: string }>('/desktop/code', {
      method: 'POST',
      body: { challenge },
    })
    if (error || !data) {
      setError(error?.message ?? 'Could not sign Brigade.app in. Try again from the app.')
      return setState('idle')
    }
    location.href = `brigade://sign-in?${new URLSearchParams({ code: data.code })}`
    setState('sent')
  }

  async function switchAccount() {
    await authClient.signOut()
    markSignedOut()
    location.replace(`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`)
  }

  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-12">
      <div className="flex w-full max-w-sm flex-col gap-7">
        <div className="flex flex-col items-center gap-4 text-center">
          <span
            aria-hidden
            className="flex size-14 items-center justify-center rounded-2xl bg-primary text-2xl font-extrabold text-primary-foreground"
          >
            B
          </span>
          <div className="flex flex-col gap-1.5">
            <h1 className="text-3xl font-extrabold tracking-tight">Sign in to Brigade.app</h1>
            <p className="text-sm text-muted-foreground">
              {state === 'sent'
                ? 'You can go back to Brigade.app and close this tab.'
                : `As ${me.user.email}`}
            </p>
          </div>
        </div>
        <Card>
          <CardContent className="flex flex-col gap-5">
            {challenge ? (
              <Button size="lg" className="w-full" disabled={state === 'busy'} onClick={open}>
                {state === 'sent' ? 'Open Brigade.app again' : 'Open Brigade.app'}
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                This link is incomplete. In Brigade.app, choose Sign in with your browser again.
              </p>
            )}
            {error && <p className="text-sm text-destructive-text">{error}</p>}
          </CardContent>
        </Card>
        <p className="text-center text-sm text-muted-foreground">
          Not you?{' '}
          <button
            type="button"
            onClick={switchAccount}
            className="font-semibold text-primary underline-offset-4 hover:underline"
          >
            Use another account
          </button>
        </p>
      </div>
    </main>
  )
}
