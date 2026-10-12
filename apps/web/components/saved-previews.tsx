'use client'
// How each repository's preview starts, as a teammate saved it once its pages
// passed their check: what Preview runs without a turn. Any member reads them;
// an owner or admin forgets one, so the next preview is set up again. Beside
// each, the variables people gave it (preview-variables.tsx).
import type { SavedPreview } from '@brigade/contracts'
import { AppWindow, ChevronRight } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { isAdmin, timeAgo, useDashboard } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { PreviewVariables } from '@/components/preview-variables'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { api, useApi } from '@/lib/api'

export function SavedPreviews() {
  const { me } = useDashboard()
  const saved = useApi<SavedPreview[]>('/repositories/previews')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function forget(repository: string) {
    if (
      !confirm(
        `Forget the saved preview of ${repository}? The next one is set up again; its variables stay.`,
      )
    )
      return
    setBusy(true)
    setError(undefined)
    try {
      await api(`/repositories/${repository}/preview`, { method: 'DELETE' })
      await saved.reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const list = saved.data ?? []
  return (
    <section aria-labelledby="saved-previews" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="saved-previews" className="text-lg font-bold tracking-tight">
          Saved previews
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          How each repository&apos;s app starts for people to try, saved by a teammate once its
          pages passed their check. Preview in a thread or on a pull request starts it from here in
          one step, with the variables people gave it: API keys and settings the app gets each time
          it starts, which teammates never see.
        </p>
        {error && <p className="text-sm text-destructive-text">{error}</p>}
      </div>

      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {saved.data
            ? 'None yet. Ask a teammate for a preview in a thread: it sets one up and saves it.'
            : (saved.error?.message ?? 'Loading…')}
        </p>
      ) : (
        <Card className="gap-0 divide-y py-0">
          {list.map(({ repository, recipe, savedBy, savedFromSessionId, updatedAt, variables }) => {
            const env = Object.keys(recipe?.env ?? {})
            return (
              <Collapsible key={repository} className="flex flex-col gap-3 px-5 py-4">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <AppWindow aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
                    <span className="font-mono font-semibold">{repository}</span>
                    <span className="truncate text-sm text-muted-foreground">
                      {!recipe || !updatedAt
                        ? 'No saved setup yet'
                        : `${savedBy ? `Saved by ${savedBy.name}` : 'Saved'} ${timeAgo(updatedAt)}`}
                      {variables.length > 0 &&
                        ` · ${variables.length} variable${variables.length === 1 ? '' : 's'}`}
                      {savedFromSessionId && (
                        <>
                          {' · '}
                          <Link
                            href={`/app/threads/${savedFromSessionId}`}
                            className="underline-offset-4 hover:text-foreground hover:underline"
                          >
                            its thread
                          </Link>
                        </>
                      )}
                    </span>
                  </div>
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" size="sm" className="group">
                      <ChevronRight
                        aria-hidden
                        className="transition-transform group-data-[state=open]:rotate-90"
                      />
                      Details
                    </Button>
                  </CollapsibleTrigger>
                  {isAdmin(me) && recipe && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void forget(repository)}
                    >
                      Forget
                    </Button>
                  )}
                </div>
                <CollapsibleContent className="flex flex-col gap-4">
                  {recipe && (
                    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
                      {recipe.setup && (
                        <>
                          <dt className="text-muted-foreground">Setup</dt>
                          <dd>
                            <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">
                              {recipe.setup}
                            </pre>
                          </dd>
                        </>
                      )}
                      <dt className="text-muted-foreground">Command</dt>
                      <dd className="font-mono text-xs break-all">
                        {recipe.cwd ? `${recipe.cwd}$ ` : ''}
                        {recipe.command}
                      </dd>
                      <dt className="text-muted-foreground">Ports</dt>
                      <dd className="font-mono text-xs">
                        {[recipe.port, ...recipe.ports].join(', ')}
                      </dd>
                      {env.length > 0 && (
                        <>
                          <dt className="text-muted-foreground">Settings</dt>
                          <dd className="font-mono text-xs break-all">{env.join(', ')}</dd>
                        </>
                      )}
                      {recipe.credentials.length > 0 && (
                        <>
                          <dt className="text-muted-foreground">Credentials</dt>
                          <dd>
                            {recipe.credentials.length} from the vault: its teammate starts it, to
                            release them
                          </dd>
                        </>
                      )}
                      <dt className="text-muted-foreground">Pages checked</dt>
                      <dd className="font-mono text-xs">{recipe.paths.join(', ')}</dd>
                    </dl>
                  )}
                  <PreviewVariables
                    repository={repository}
                    variables={variables}
                    onChange={saved.reload}
                  />
                </CollapsibleContent>
              </Collapsible>
            )
          })}
        </Card>
      )}
    </section>
  )
}
