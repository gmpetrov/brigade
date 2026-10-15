'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { GoogleSignIn } from '@/components/google-sign-in'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { authClient } from '@/lib/auth-client'
import { markSignedIn } from '@/lib/signed-in'

export default function SignIn() {
  const router = useRouter()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  // Back from Google with ?error=: the API names what went wrong.
  useEffect(() => {
    const failed = new URLSearchParams(location.search).get('error')
    if (failed) setError(`Could not sign in with Google (${failed.replaceAll('_', ' ')})`)
  }, [])

  async function submit(form: FormData) {
    setError(undefined)
    setBusy(true)
    try {
      const { error } = await authClient.signIn.email({
        email: String(form.get('email')),
        password: String(form.get('password')),
      })
      if (error) return setError(error.message ?? 'Could not sign in')
      markSignedIn()
      router.push('/app')
    } catch {
      setError('Could not reach Brigade. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
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
            <h1 className="text-3xl font-extrabold tracking-tight">Sign in to Brigade</h1>
            <p className="text-sm text-muted-foreground">Your AI teammates are waiting.</p>
          </div>
        </div>
        <Card>
          <CardContent className="flex flex-col gap-5">
            <GoogleSignIn onError={setError} />
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>
            <form action={submit} className="flex flex-col gap-5">
              <div className="flex flex-col gap-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" autoComplete="email" required />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </div>
              {error && <p className="text-sm text-destructive-text">{error}</p>}
              <Button type="submit" size="lg" className="w-full" disabled={busy}>
                Sign in
              </Button>
            </form>
          </CardContent>
        </Card>
        <p className="text-center text-sm text-muted-foreground">
          New here?{' '}
          <Link
            href="/sign-up"
            className="font-semibold text-primary underline-offset-4 hover:underline"
          >
            Create an account
          </Link>
        </p>
      </div>
    </main>
  )
}
