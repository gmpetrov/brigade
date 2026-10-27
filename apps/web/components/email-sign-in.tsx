'use client'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { authClient } from '@/lib/auth-client'

/** Cloudflare Turnstile's site key: with it, a code is mailed only after its check (the API has the secret). */
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY

type Turnstile = {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string
      action?: string
      callback: (token: string) => void
      'expired-callback': () => void
      'error-callback': () => void
    },
  ) => string
  reset: (id: string) => void
  remove: (id: string) => void
}

declare global {
  interface Window {
    turnstile?: Turnstile
  }
}

let script: Promise<void> | undefined
function loadTurnstile() {
  script ??= new Promise<void>((resolve, reject) => {
    const tag = document.createElement('script')
    tag.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    tag.async = true
    tag.onload = () => resolve()
    tag.onerror = () => {
      script = undefined
      reject(new Error('Turnstile did not load'))
    }
    document.head.append(tag)
  })
  return script
}

/** Turnstile's widget, when the dashboard has its site key: its latest token, or undefined. */
function useTurnstile(slot: React.RefObject<HTMLDivElement | null>) {
  const [token, setToken] = useState<string>()
  const widget = useRef<string>(undefined)
  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return
    let gone = false
    void loadTurnstile()
      .then(() => {
        if (gone || !slot.current || !window.turnstile) return
        widget.current = window.turnstile.render(slot.current, {
          sitekey: TURNSTILE_SITE_KEY,
          action: 'sign-in-code',
          callback: setToken,
          'expired-callback': () => setToken(undefined),
          'error-callback': () => setToken(undefined),
        })
      })
      .catch(() => undefined)
    return () => {
      gone = true
      if (widget.current) window.turnstile?.remove(widget.current)
      widget.current = undefined
    }
  }, [slot])
  return {
    needed: Boolean(TURNSTILE_SITE_KEY),
    token,
    /** A token is good once: a new one for the next code. */
    reset() {
      setToken(undefined)
      if (widget.current) window.turnstile?.reset(widget.current)
    },
  }
}

/**
 * Whether the address signs in with a password (the API's src/password-sign-in.ts): only
 * accounts given one by hand, such as a test account, and the dev accounts locally.
 */
function usePasswordAccount(email: string) {
  const [account, setAccount] = useState<string>()
  useEffect(() => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return
    let gone = false
    const wait = setTimeout(() => {
      void authClient
        .$fetch<{ password: boolean }>('/password-sign-in', { method: 'GET', query: { email } })
        .then(({ data }) => {
          if (!gone && data?.password) setAccount(email)
        })
        .catch(() => undefined)
    }, 300)
    return () => {
      gone = true
      clearTimeout(wait)
    }
  }, [email])
  return account === email
}

/** The API's errors on a code (better-auth's emailOTP), said plainly. */
function codeError(error: { code?: string; status?: number }) {
  if (error.code === 'INVALID_OTP') return 'That code is not right. Check it, or send a new one.'
  if (error.code === 'OTP_EXPIRED') return 'This code has expired. Send a new one.'
  if (error.code === 'TOO_MANY_ATTEMPTS') return 'Too many tries with this code. Send a new one.'
  if (error.status === 429) return 'Too many tries. Wait a minute, then try again.'
}

/**
 * Signs in, or up, with a code mailed to the address (the API's emailOTP): an account is
 * only made by someone who reads its mail. With `withName`, a new account takes the name.
 * With `withPassword`, an account that has a password signs in with it instead.
 */
export function EmailSignIn({
  withName,
  withPassword,
  submitLabel,
  onSignedIn,
}: {
  withName?: boolean
  withPassword?: boolean
  submitLabel: string
  onSignedIn: () => void
}) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const slot = useRef<HTMLDivElement>(null)
  const turnstile = useTurnstile(slot)
  const [password, setPassword] = useState('')
  const passwordAccount = usePasswordAccount(withPassword ? email : '')

  async function sendCode() {
    setError(undefined)
    setBusy(true)
    try {
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: 'sign-in',
        fetchOptions: turnstile.token
          ? { headers: { 'x-captcha-response': turnstile.token } }
          : undefined,
      })
      if (error) return setError(codeError(error) ?? error.message ?? 'Could not send the code')
      setCode('')
      setSent(true)
    } catch {
      setError('Could not reach Brigade. Check your connection and try again.')
    } finally {
      turnstile.reset()
      setBusy(false)
    }
  }

  async function signIn() {
    setError(undefined)
    setBusy(true)
    try {
      const { error } = await authClient.signIn.emailOtp({
        email,
        otp: code.replace(/\s/g, ''),
        ...(withName && name.trim() ? { name: name.trim() } : {}),
      })
      if (error) return setError(codeError(error) ?? error.message ?? 'Could not sign in')
      onSignedIn()
    } catch {
      setError('Could not reach Brigade. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function signInWithPassword() {
    setError(undefined)
    setBusy(true)
    try {
      const { error } = await authClient.signIn.email({ email, password })
      if (error)
        return setError(
          error.status === 429
            ? 'Too many tries. Wait a minute, then try again.'
            : (error.message ?? 'Could not sign in'),
        )
      onSignedIn()
    } catch {
      setError('Could not reach Brigade. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  // One slot for Turnstile's widget, whichever step shows: it renders there once.
  return (
    <div className="flex flex-col gap-5">
      {sent ? (
        <form action={signIn} className="flex flex-col gap-5">
          <p className="text-sm text-muted-foreground">
            We sent a code to <span className="font-medium text-foreground">{email}</span>. It works
            for 10 minutes.
          </p>
          <div className="flex flex-col gap-2">
            <Label htmlFor="code">Code</Label>
            <Input
              id="code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]*"
              maxLength={7}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoFocus
              required
            />
          </div>
          {error && <p className="text-sm text-destructive-text">{error}</p>}
          <Button type="submit" size="lg" className="w-full" disabled={busy}>
            {submitLabel}
          </Button>
          <div className="flex justify-between text-sm text-muted-foreground">
            <button
              type="button"
              onClick={() => {
                setSent(false)
                setError(undefined)
              }}
              className="underline-offset-4 hover:underline"
            >
              Use another email
            </button>
            <button
              type="button"
              onClick={sendCode}
              disabled={busy || (turnstile.needed && !turnstile.token)}
              className="underline-offset-4 hover:underline disabled:opacity-50"
            >
              Send a new code
            </button>
          </div>
        </form>
      ) : (
        <form
          action={passwordAccount ? signInWithPassword : sendCode}
          className="flex flex-col gap-5"
        >
          {withName && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                name="name"
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value.trim())}
              required
            />
          </div>
          {passwordAccount && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
          )}
          {error && <p className="text-sm text-destructive-text">{error}</p>}
          <Button
            type="submit"
            size="lg"
            className="w-full"
            disabled={busy || (!passwordAccount && turnstile.needed && !turnstile.token)}
          >
            {passwordAccount ? submitLabel : 'Email me a code'}
          </Button>
        </form>
      )}
      {turnstile.needed && <div ref={slot} className="flex justify-center" />}
    </div>
  )
}
