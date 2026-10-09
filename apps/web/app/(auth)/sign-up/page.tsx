'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
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
    <main className="narrow">
      <h1>Create your account</h1>
      <form action={submit} className="card">
        <div className="field">
          <label htmlFor="name">Name</label>
          <input id="name" name="name" autoComplete="name" required />
        </div>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
          />
        </div>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          Create account
        </button>
      </form>
      <p className="hint" style={{ marginTop: 12 }}>
        Already have an account? <Link href="/sign-in">Sign in</Link>
      </p>
    </main>
  )
}
