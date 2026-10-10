'use client'
// A GitHub connection is all a repository needs: pull requests start here
// when the workspace has none, or its connection stopped working.
import Link from 'next/link'
import { useState } from 'react'
import { isAdmin, useDashboard } from '@/components/dashboard'
import { ProviderTile } from '@/components/provider-logo'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { api, useApi, type ConnectionsResponse } from '@/lib/api'

/** Whether the workspace reaches GitHub. */
export type GitHubState = 'loading' | 'connected' | 'needs_reauth' | 'none' | 'unavailable'

export function useGitHub(): GitHubState {
  const { data } = useApi<ConnectionsResponse>('/connections')
  if (!data) return 'loading'
  const github = data.connections.filter((c) => c.kind === 'github')
  if (github.some((c) => c.status === 'active')) return 'connected'
  if (github.length) return 'needs_reauth'
  return data.available.github ? 'none' : 'unavailable'
}

/** The first step: a GitHub connection, which owners and admins make from here. */
export function ConnectGitHub({ state }: { state: Exclude<GitHubState, 'loading' | 'connected'> }) {
  const { me } = useDashboard()
  const admin = isAdmin(me)
  const [error, setError] = useState<string>()

  async function connect() {
    setError(undefined)
    try {
      const { url } = await api<{ url: string }>('/connections/github', { body: {} })
      window.location.href = url
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const text =
    state === 'needs_reauth'
      ? 'The GitHub connection stopped working: the app was uninstalled or lost access. Reconnect it to see pull requests again.'
      : state === 'unavailable'
        ? "GitHub needs Brigade's GitHub App configured on this Brigade server (GITHUB_APP_*)."
        : "Install Brigade's GitHub App on your account or organization and pick the repositories teammates may work on. Then give teammates access to it on the Connections page."
  return (
    <Card className="flex-row flex-wrap items-center gap-4 px-5 py-4">
      <ProviderTile kind="github" />
      <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
        <span className="font-semibold">
          {state === 'needs_reauth' ? 'Reconnect GitHub' : 'Connect GitHub first'}
        </span>
        <span className="text-sm text-muted-foreground">{text}</span>
        {error && <span className="text-sm text-destructive-text">{error}</span>}
      </div>
      {state !== 'unavailable' &&
        (admin ? (
          state === 'needs_reauth' ? (
            <Button asChild>
              <Link href="/app/connections">Open Connections</Link>
            </Button>
          ) : (
            <Button onClick={() => void connect()}>Connect GitHub</Button>
          )
        ) : (
          <span className="text-sm text-muted-foreground">
            Ask an owner or admin to connect it.
          </span>
        ))}
    </Card>
  )
}
