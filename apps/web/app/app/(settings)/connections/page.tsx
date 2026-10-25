'use client'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import { CircleCheck, ShieldCheck } from 'lucide-react'
import { isAdmin, useDashboard } from '@/components/dashboard'
import { AppSheet } from '@/components/app-sheet'
import { ConnectApps, type Open } from '@/components/connect-apps'
import { Skills } from '@/components/skills'
import { useApi, type ConnectionsResponse, type Trigger, type TriggerCatalog } from '@/lib/api'

/** Why an account was not connected, from the error a provider's redirect brought back. */
const CONNECT_ERRORS: Record<string, string> = {
  expired: 'The request expired. Start again.',
  forbidden: 'You are no longer in this workspace.',
  declined: 'Access was not granted.',
  google: 'Google did not complete the sign-in. Try again.',
  mcp: 'The sign-in did not complete. Try again.',
  stripe_accounts:
    'Brigade connects one Stripe account at a time, live or a sandbox: on Stripe’s page, choose a single one. Connect again for another.',
  github: 'GitHub did not complete the sign-in. Try again.',
  github_requested:
    "Your request to install Brigade was sent to the GitHub organization's owners. Connect GitHub again once they approve it.",
  github_not_yours:
    'Your GitHub account cannot reach that installation. Sign in to GitHub as someone who can, and try again.',
}

export default function AppsPage() {
  return (
    <Suspense>
      <Apps />
    </Suspense>
  )
}

function Apps() {
  const params = useSearchParams()
  // Back from a provider in the sign-in tab: the page that opened it shows the account.
  if (params.get('popup')) return <SignedIn error={params.get('error')} />
  return <AppsList />
}

/** The sign-in tab's last page: closes itself, or says to. */
function SignedIn({ error }: { error: string | null }) {
  useEffect(() => {
    if (!error) window.close()
  }, [error])
  return (
    <div className="flex flex-col gap-2 py-16 text-center">
      <p className="font-semibold">{error ? 'The account was not connected.' : 'Connected.'}</p>
      <p className="text-sm text-muted-foreground">
        {error
          ? (CONNECT_ERRORS[error] ?? `(${error})`)
          : 'You can close this tab and go back to Brigade.'}
      </p>
    </div>
  )
}

function AppsList() {
  const { me } = useDashboard()
  const params = useSearchParams()
  const router = useRouter()
  const data = useApi<ConnectionsResponse>('/connections')
  const triggers = useApi<Trigger[]>('/triggers')
  const catalog = useApi<TriggerCatalog>('/triggers/catalog')
  const [open, setOpen] = useState<Open>()

  const connections = data.data?.connections ?? []

  // Back from a provider's sign-in: open the App the new account belongs to.
  const connected = params.get('connected')
  const [shown, setShown] = useState<string>()
  useEffect(() => {
    const account = connected && connections.find((c) => c.id === connected)
    if (!account || shown === account.id) return
    setShown(account.id)
    setOpen({ kind: account.kind, appId: account.appId })
  }, [connected, connections, shown])

  function close() {
    setOpen(undefined)
    if (connected || params.get('error')) router.replace('/app/connections')
  }

  const reload = () => Promise.all([data.reload(), triggers.reload()])
  // A built-in App opened from the catalog becomes the added one once its first account connects.
  const sheetApp = data.data?.apps.find((a) =>
    open?.appId ? a.id === open.appId : a.key === open?.kind,
  )

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col">
        <ConnectApps
          data={data.data}
          onOpen={setOpen}
          intro={
            <>
              <p className="max-w-prose text-muted-foreground">
                The services your teammates work in. Connect your accounts, then choose which
                teammates get each one.
              </p>
              <div className="flex gap-3 rounded-lg bg-accent p-4 text-sm">
                <ShieldCheck
                  className="mt-0.5 size-4 shrink-0 text-accent-foreground"
                  aria-hidden
                />
                <p>
                  <span className="font-semibold text-accent-foreground">
                    An account’s key stays encrypted in Brigade and never reaches a computer:
                  </span>{' '}
                  every call goes through Brigade, which checks the teammate&apos;s access, asks a
                  person before changes when its policy says so, and logs the call.
                </p>
              </div>
              {connected && (
                <p className="flex items-center gap-2 rounded-lg bg-success/15 p-3 text-sm font-semibold text-success">
                  <CircleCheck className="size-4" aria-hidden />
                  Connected.
                </p>
              )}
              {params.get('error') && (
                <p className="text-sm text-destructive-text">
                  The account was not connected.{' '}
                  {CONNECT_ERRORS[params.get('error')!] ?? `(${params.get('error')})`}
                </p>
              )}
            </>
          }
        />
      </div>

      <Skills admin={isAdmin(me)} />

      {open && data.data && (
        <AppSheet
          key={open.appId ?? open.kind}
          kind={open.kind}
          app={sheetApp}
          data={data.data}
          triggers={triggers.data ?? []}
          catalog={catalog.data}
          reload={reload}
          onClose={close}
          onAdded={(appId) => setOpen({ kind: 'mcp', appId })}
        />
      )}
    </div>
  )
}
