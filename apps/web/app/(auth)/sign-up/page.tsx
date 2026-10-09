'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { authClient } from '@/lib/auth-client'

export default function SignUp() {
  const router = useRouter()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function submit(form: FormData) {
    setBusy(true)
    const { error } = await authClient.signUp.email({
      name: String(form.get('name')),
      email: String(form.get('email')),
      password: String(form.get('password')),
    })
    setBusy(false)
    if (error) return setError(error.message ?? 'Could not create the account')
    router.push('/onboarding')
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
          <h1 className="text-3xl font-extrabold tracking-tight">Create your account</h1>
        </div>
        <Card>
          <CardContent>
            <form action={submit} className="flex flex-col gap-5">
              <div className="flex flex-col gap-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" autoComplete="name" required />
              </div>
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
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </div>
              {error && <p className="text-sm text-destructive-text">{error}</p>}
              <Button type="submit" size="lg" className="w-full" disabled={busy}>
                Create account
              </Button>
            </form>
          </CardContent>
        </Card>
        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{' '}
          <Link
            href="/sign-in"
            className="font-semibold text-primary underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        </p>
      </div>
    </main>
  )
}
