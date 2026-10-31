'use client'
// Where an invitation's link leads (the mail of src/invitation-mail.ts in the API). Signed out,
// to sign in first and back here. Signed in with the invited address: join, then on to the
// dashboard, which asks for an AI account first. Signed in with another one: say so, and offer
// to sign in with the right one.
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { BrigadeMark } from '@/components/brigade-mark'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { api, ApiError, type InvitationView } from '@/lib/api'
import { authClient } from '@/lib/auth-client'
import { markSignedIn, markSignedOut } from '@/lib/signed-in'

const AS = { owner: 'an owner', admin: 'an admin', member: 'a member', viewer: 'a viewer' } as const

export default function Invite() {
  const { id } = useParams<{ id: string }>()
  const [invitation, setInvitation] = useState<InvitationView>()
  const [error, setError] = useState<string>()
  const [closed, setClosed] = useState(false)
  const [busy, setBusy] = useState(false)
  const here = `/invite/${encodeURIComponent(id)}`
  const signIn = useCallback(
    () => location.replace(`/sign-in?next=${encodeURIComponent(here)}`),
    [here],
  )

  useEffect(() => {
    api<InvitationView>(`/invitations/${encodeURIComponent(id)}`)
      .then((found) => {
        markSignedIn()
        setInvitation(found)
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) {
          markSignedOut()
          signIn()
        } else if (e instanceof ApiError && e.status === 404) setClosed(true)
        else setError((e as Error).message)
      })
  }, [id, signIn])

  async function join() {
    setBusy(true)
    setError(undefined)
    try {
      await api(`/invitations/${encodeURIComponent(id)}/accept`, { body: {} })
      location.assign('/app')
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  async function switchAccount() {
    setBusy(true)
    await authClient.signOut().catch(() => {})
    markSignedOut()
    signIn()
  }

  let title = 'Invitation'
  let body: React.ReactNode = <p className="text-center text-sm text-muted-foreground">Loading…</p>
  if (closed) {
    title = 'This invitation is no longer open'
    body = (
      <>
        <p className="text-sm text-muted-foreground">
          It was used, canceled or has expired. Ask whoever invited you to send a new one.
        </p>
        <Button asChild size="lg" className="w-full">
          <Link href="/app">Open Brigade</Link>
        </Button>
      </>
    )
  } else if (invitation && !invitation.forYou) {
    title = 'This invitation is for another address'
    body = (
      <>
        <p className="text-sm text-muted-foreground">
          You are signed in as{' '}
          <span className="font-medium text-foreground">{invitation.signedInAs}</span>. Sign in with
          the address the invitation was sent to.
        </p>
        <Button size="lg" className="w-full" disabled={busy} onClick={switchAccount}>
          Sign in with another address
        </Button>
      </>
    )
  } else if (invitation?.member) {
    title = `You're in ${invitation.organization}`
    body = (
      <>
        <p className="text-sm text-muted-foreground">You are a member already.</p>
        <Button asChild size="lg" className="w-full">
          <Link href="/app">Open Brigade</Link>
        </Button>
      </>
    )
  } else if (invitation) {
    title = `Join ${invitation.organization}`
    body = (
      <>
        <p className="text-sm text-muted-foreground">
          {invitation.invitedBy} invited you to join {invitation.organization} on Brigade as{' '}
          {AS[invitation.role]}. You&apos;ll share its threads, tasks and files with the team.
        </p>
        <Button size="lg" className="w-full" disabled={busy} onClick={join}>
          Join {invitation.organization}
        </Button>
        <p className="text-xs text-muted-foreground">
          Signed in as {invitation.signedInAs}.{' '}
          <button
            type="button"
            onClick={switchAccount}
            className="underline-offset-4 hover:underline"
          >
            Not you?
          </button>
        </p>
      </>
    )
  }

  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-12">
      <div className="flex w-full max-w-sm flex-col gap-7">
        <div className="flex flex-col items-center gap-4 text-center">
          <BrigadeMark className="size-14" />
          <h1 className="text-3xl font-extrabold tracking-tight">{title}</h1>
        </div>
        <Card>
          <CardContent className="flex flex-col gap-5">
            {body}
            {error && <p className="text-sm text-destructive-text">{error}</p>}
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
