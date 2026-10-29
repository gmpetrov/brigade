'use client'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { BrigadeMark } from '@/components/brigade-mark'
import { EmailSignIn } from '@/components/email-sign-in'
import { GoogleSignIn } from '@/components/google-sign-in'
import { AuthLink } from '@/components/landing/auth-link'
import { LegalConsent } from '@/components/legal-consent'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { authClient } from '@/lib/auth-client'
import { inCaptureWindow, signInWithBrowser } from '@/lib/brigade-app'
import { afterSignIn, markSignedIn } from '@/lib/signed-in'

export default function SignIn() {
  const router = useRouter()
  const [error, setError] = useState<string>()
  // In Brigade.app's window, the browser signs in (lib/brigade-app.ts): its own session is
  // out of reach here. 'waiting': the browser is open; 'form': the form here after all.
  const [app, setApp] = useState<'browser' | 'waiting' | 'form'>()
  // Back from Google with ?error=: the API names what went wrong. With ?signed, signed in
  // with Google on the way to ?next=. In Brigade.app's window, with ?desktop_code= and
  // ?verifier=: the browser's sign-in, brought back by the app.
  useEffect(() => {
    const query = new URLSearchParams(location.search)
    if (query.has('signed')) {
      markSignedIn()
      return location.replace(afterSignIn())
    }
    const failed = query.get('error')
    if (failed) setError(`Could not sign in with Google (${failed.replaceAll('_', ' ')})`)
    if (!inCaptureWindow()) return
    setApp('browser')
    const code = query.get('desktop_code')
    const verifier = query.get('verifier')
    if (!code || !verifier) return
    history.replaceState(null, '', '/sign-in')
    void authClient
      .$fetch('/desktop/redeem', { method: 'POST', body: { code, verifier } })
      .then(({ error }) => {
        if (error) return setError(error.message ?? 'Could not sign in')
        markSignedIn()
        location.replace('/app/capture')
      })
      .catch(() => setError('Could not reach Brigade. Check your connection and try again.'))
  }, [])

  async function browser() {
    setError(undefined)
    try {
      await signInWithBrowser()
      setApp('waiting')
    } catch {
      setError('Could not open your browser.')
    }
  }

  function signedIn() {
    markSignedIn()
    const next = afterSignIn()
    if (next === '/app') router.push(next)
    else location.assign(next)
  }

  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-12">
      <div className="flex w-full max-w-sm flex-col gap-7">
        <div className="flex flex-col items-center gap-4 text-center">
          <BrigadeMark className="size-14" />
          <div className="flex flex-col gap-1.5">
            <h1 className="text-3xl font-extrabold tracking-tight">Sign in to Brigade</h1>
            <p className="text-sm text-muted-foreground">Your AI teammates are waiting.</p>
          </div>
        </div>
        {app === 'browser' || app === 'waiting' ? (
          <Card>
            <CardContent className="flex flex-col gap-5">
              <Button size="lg" className="w-full" onClick={browser}>
                Sign in with your browser
              </Button>
              <p className="text-sm text-muted-foreground">
                {app === 'waiting'
                  ? 'Finish in your browser: Brigade.app signs in once you choose Open Brigade.app there.'
                  : 'Already signed in to Brigade in your browser? Nothing to type.'}
              </p>
              {error && <p className="text-sm text-destructive-text">{error}</p>}
              <button
                type="button"
                onClick={() => setApp('form')}
                className="self-center text-sm text-muted-foreground underline-offset-4 hover:underline"
              >
                Sign in here instead
              </button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="flex flex-col gap-5">
              <GoogleSignIn onError={setError} />
              {error && <p className="text-sm text-destructive-text">{error}</p>}
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                or
                <span className="h-px flex-1 bg-border" />
              </div>
              <EmailSignIn withPassword submitLabel="Sign in" onSignedIn={signedIn} />
              <LegalConsent />
            </CardContent>
          </Card>
        )}
        <p className="text-center text-sm text-muted-foreground">
          New here?{' '}
          <AuthLink
            passOn
            href="/sign-up"
            className="font-semibold text-primary underline-offset-4 hover:underline"
          >
            Create an account
          </AuthLink>
        </p>
      </div>
    </main>
  )
}
