'use client'
import { useEffect, useRef, useState } from 'react'
import { AccountLoginSteps, machineName } from '@/components/account-card'
import { Button } from '@/components/ui/button'
import { api, harnessLabel, useApi, type Account, type AccountLogin } from '@/lib/api'
import { catchUpAfterReconnect, shownLogin, underWay } from '@/lib/thread-sign-in'
import { useLive } from '@/lib/use-live'

/**
 * A turn that failed because its account's login is gone ("Not logged in · Please run /login"):
 * its error card says so in words and, to whoever added the account, offers to sign in again
 * right here, with the same steps as the Accounts page. Once signed in, the turn runs again on
 * its own. Others see whose account it is; an account on a member's own machine is signed in on
 * that machine. Only on the thread's latest turn: an older one was dealt with since.
 */
export function SignedOutError({
  accountId,
  message,
  latest,
  onRetry,
  retrying,
}: {
  accountId: string
  /** The harness's own words. */
  message: string
  /** Nothing came after it but notes, and no turn runs. */
  latest: boolean
  /** Tries the failed turn again. Unset when they cannot (or it is not the latest turn). */
  onRetry?: () => void
  retrying: boolean
}) {
  // Its sign-in as last heard: on the socket, or caught up from the list after it reconnected.
  const [live, setLive] = useState<AccountLogin | null>(null)
  const [done, setDone] = useState(false)
  // A sign-in this card followed ended while the socket was down, and the account is not ready.
  const [interrupted, setInterrupted] = useState(false)
  const followed = useRef(false)
  // The sign-in's messages heard on the socket: a catch-up that loaded meanwhile is older.
  const heard = useRef(0)
  const accounts = useApi<Account[]>(latest || live || done ? '/accounts' : null)
  const account = accounts.data?.find((a) => a.id === accountId)
  // Whoever signs in sees its progress, wherever they started it (here, or on Accounts).
  const login = shownLogin(live, account)
  const going = underWay(login)
  if (going) followed.current = true
  const [error, setError] = useState<string>()
  // The retry once signed in, called once: the card stays mounted while the turn runs again.
  const retried = useRef(false)
  const [resent, setResent] = useState(false)
  const retry = useRef(onRetry)
  retry.current = onRetry

  useLive(
    (m) => {
      if (m.type !== 'account.login' || m.accountId !== accountId) return
      heard.current++
      setLive(m)
      setInterrupted(false)
      if (m.state === 'done') setDone(true)
    },
    () => {
      // What the socket said while it was down is lost: catch up from the list. A later
      // reconnect's catch-up makes this one's older, as a message heard meanwhile does.
      heard.current++
      void accounts.reload()
      void catchUpAfterReconnect(
        () => api<Account[]>('/accounts'),
        accountId,
        () => followed.current,
        () => heard.current,
      )
        .then((next) => {
          if (!next) return
          setLive(next.live)
          if (next.done) setDone(true)
          if (next.interrupted) setInterrupted(true)
        })
        .catch(() => {})
    },
  )

  useEffect(() => {
    if (!done || retried.current || !retry.current) return
    retried.current = true
    setResent(true)
    retry.current()
  }, [done])

  const provider = account ? harnessLabel(account.provider) : undefined
  const card = (body: React.ReactNode, action?: React.ReactNode, below?: React.ReactNode) => (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-2.5 text-sm text-destructive-text"
    >
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">{body}</div>
        {action}
      </div>
      {below}
    </div>
  )
  const tryAgain = onRetry && (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className="shrink-0"
      disabled={retrying}
      onClick={onRetry}
    >
      Try again
    </Button>
  )
  const said = (
    <span className="wrap-anywhere whitespace-pre-wrap text-xs opacity-80">{message}</span>
  )

  if (done)
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-success" />
        <span>
          Signed in to {provider ?? 'your account'}
          {resent ? ' · sending your message again' : '. Send a message to go on.'}
        </span>
      </div>
    )

  // Not the latest turn, or an account they cannot see: the error as the harness said it.
  if (!account || (!latest && !going))
    return card(
      <span className="wrap-anywhere whitespace-pre-wrap">{message}</span>,
      latest && tryAgain,
    )

  const where =
    account.computer.kind === 'cloud' ? 'the cloud computer' : machineName(account.computer)
  if (!account.mine)
    return card(
      <>
        <span>
          {account.addedBy}&apos;s {provider} account on {where} is signed out. Only{' '}
          {account.addedBy} can sign it in again.
        </span>
        {said}
      </>,
      tryAgain,
    )

  if (account.source === 'machine')
    return card(
      <>
        <span>
          {provider} is signed out on {where}. Sign in to {provider} on that machine, then try
          again.
        </span>
        {said}
      </>,
      tryAgain,
    )

  const start = async () => {
    setError(undefined)
    setInterrupted(false)
    setLive({ state: 'starting' })
    try {
      await api(`/accounts/${account.id}/sign-in`, { method: 'POST' })
    } catch (e) {
      setLive(null)
      setError((e as Error).message)
    }
  }
  const failed = login?.state === 'failed'

  return card(
    <>
      <span>
        Your {provider} account on {where} is signed out, so this turn could not run.
      </span>
      {said}
    </>,
    !going && (
      <Button type="button" size="xs" className="shrink-0" onClick={() => void start()}>
        {failed || interrupted ? 'Try signing in again' : `Sign in to ${provider}`}
      </Button>
    ),
    <>
      {going && login && (
        <AccountLoginSteps
          account={account}
          login={login}
          className="text-foreground"
          onAct={async (p) => {
            setError(undefined)
            try {
              await p
            } catch (e) {
              setError((e as Error).message)
            }
          }}
        />
      )}
      {failed && <span>Sign-in failed: {login.error}</span>}
      {interrupted && <span>The sign-in did not finish. Try again.</span>}
      {error && <span>{error}</span>}
    </>,
  )
}
