'use client'
import { modelLabel } from '@brigade/contracts'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { AttachButton, UploadList, useFileDrop, useUploads } from '@/components/attachments'
import { Composer } from '@/components/composer'
import { isAdmin, TeammateAvatar, useDashboard } from '@/components/dashboard'
import { TeammateAccess } from '@/components/teammate-access'
import { TeammateBrowser } from '@/components/teammate-browser'
import { TeammateForm } from '@/components/teammate-form'
import { TeammateCaps, TeammateStatus, useTeammateTimeline } from '@/components/teammate-oversight'
import { ThreadList } from '@/components/thread-list'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  api,
  harnessLabel,
  useApi,
  usableComputers,
  computerName,
  type Account,
  type ComputersResponse,
  type ThreadSummary,
} from '@/lib/api'
import { cn } from '@/lib/utils'

export default function TeammatePage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { me, teammates, reloadTeammates } = useDashboard()
  const teammate = teammates.find((t) => t.id === id)
  const threads = useApi<ThreadSummary[]>(`/threads?teammateId=${id}`)
  const computers = useApi<ComputersResponse>('/computers')
  const accounts = useApi<Account[]>('/accounts')
  const [computerId, setComputerId] = useState<string>()
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const formRef = useRef<HTMLFormElement>(null)
  const files = useUploads()
  const drop = useFileDrop(files.add)
  const oversight = useTeammateTimeline(id)

  if (!teammate) return <p className="text-sm text-muted-foreground">Loading…</p>
  const online = usableComputers(computers.data)
  const selectedComputer = computerId ?? online[0]?.id
  const usable = (accounts.data ?? []).filter(
    (a) =>
      a.computer.id === selectedComputer &&
      a.provider === teammate.harness &&
      (a.status === 'ready' || a.status === 'unverified') &&
      !(a.exhaustedUntil && new Date(a.exhaustedUntil) > new Date()),
  )

  const ready = (text.trim() || files.ids.length > 0) && !files.busy && !files.failed

  async function start(form: FormData) {
    if (busy || !ready || !online.length) return
    setBusy(true)
    setError(undefined)
    try {
      const thread = await api<{ id: string }>('/threads', {
        body: {
          teammateId: id,
          computerId: String(form.get('computerId')),
          text: String(form.get('text')),
          attachmentIds: files.ids,
          ...(form.get('accountId') ? { accountId: String(form.get('accountId')) } : {}),
        },
      })
      files.clear()
      router.push(`/app/threads/${thread.id}`)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  async function archive() {
    if (!confirm(`Archive ${teammate!.name}? Its threads stay in the run log.`)) return
    await api(`/teammates/${id}`, { method: 'DELETE' })
    await reloadTeammates()
    router.push('/app')
  }

  const link = 'font-medium text-primary hover:underline'

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-wrap items-center gap-4">
        <TeammateAvatar teammate={teammate} className="size-16 text-2xl" />
        <div className="flex flex-[1_1_16rem] flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            <h1 className="text-3xl font-extrabold tracking-tight">{teammate.name}</h1>
            <Badge
              className={
                teammate.harness === 'codex'
                  ? 'bg-accent text-accent-foreground'
                  : 'bg-primary/15 text-primary'
              }
            >
              {harnessLabel(teammate.harness)} · {modelLabel(teammate.harness, teammate.model)}
            </Badge>
          </div>
          {!editing && teammate.instructions && (
            <p className="text-sm whitespace-pre-wrap text-muted-foreground">
              {teammate.instructions}
            </p>
          )}
        </div>
        {isAdmin(me) && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setEditing(!editing)}>
              {editing ? 'Close' : 'Edit'}
            </Button>
            <Button variant="danger" onClick={archive}>
              Archive
            </Button>
          </div>
        )}
      </header>
      {editing && (
        <TeammateForm
          initial={teammate}
          submitLabel="Save"
          onSubmit={async (input) => {
            await api(`/teammates/${id}`, { method: 'PATCH', body: input })
            await reloadTeammates()
            setEditing(false)
          }}
        />
      )}

      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[999_1_32rem] flex-col gap-5">
          <Card>
            <CardHeader>
              <CardTitle>
                <h2 className="text-base font-bold">
                  <Label htmlFor="text" className="text-base font-bold">
                    New thread
                  </Label>
                </h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form ref={formRef} action={start} className="flex flex-col gap-3.5">
                <div
                  className={cn(
                    'flex flex-col gap-2 rounded-md',
                    drop.dragging && 'ring-[3px] ring-primary/30',
                  )}
                  {...drop.props}
                >
                  <Composer
                    id="text"
                    name="text"
                    rows={4}
                    value={text}
                    onChange={setText}
                    onSubmit={() => formRef.current?.requestSubmit()}
                    placeholder={`What should ${teammate.name} do? @ to mention a repository, connection, credential or thread. Drop files to attach them`}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <AttachButton onFiles={files.add} />
                    <UploadList uploads={files.uploads} onRemove={files.remove} />
                  </div>
                </div>
                {online.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No computer is online.{' '}
                    <Link href="/app/computers" className={link}>
                      Link your machine
                    </Link>{' '}
                    to run threads on it.
                  </p>
                ) : (
                  <div className="flex flex-wrap items-center gap-2.5">
                    <Label htmlFor="computerId" className="text-muted-foreground">
                      Run on
                    </Label>
                    <Select
                      name="computerId"
                      value={computerId ?? online[0]!.id}
                      onValueChange={setComputerId}
                    >
                      <SelectTrigger id="computerId" size="sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {online.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {computerName(c)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {usable.length === 0 ? (
                      <span className="text-sm text-muted-foreground">
                        No {harnessLabel(teammate.harness)} account here.{' '}
                        <Link href="/app/accounts" className={link}>
                          Add one
                        </Link>
                      </span>
                    ) : (
                      <Select
                        key={selectedComputer}
                        name="accountId"
                        defaultValue={(usable.find((a) => a.isDefault) ?? usable[0]!).id}
                      >
                        <SelectTrigger size="sm" aria-label="Account" className="max-w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {usable.map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.label}
                              {a.email ? ` (${a.email})` : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <Button type="submit" className="ml-auto" disabled={busy || !ready}>
                      Start thread
                    </Button>
                  </div>
                )}
                {error && <p className="text-sm text-destructive-text">{error}</p>}
              </form>
            </CardContent>
          </Card>

          <TeammateAccess
            teammate={teammate}
            editable={isAdmin(me)}
            onPolicyChange={() => void reloadTeammates()}
          />

          <TeammateBrowser
            teammate={teammate}
            computer={computers.data?.computers.find(
              (c) => c.kind === 'cloud' && !['destroyed', 'error'].includes(c.status),
            )}
          />

          <TeammateCaps
            teammate={teammate}
            usage={oversight.timeline.data?.usage}
            editable={isAdmin(me)}
            onSaved={() => {
              void reloadTeammates()
              oversight.refresh()
            }}
          />
        </div>

        <div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-5">
          <TeammateStatus {...oversight} />
          <section className="flex flex-col gap-3">
            <h2 className="text-base font-bold">Threads</h2>
            {threads.data && <ThreadList threads={threads.data} showTeammate={false} />}
          </section>
        </div>
      </div>
    </div>
  )
}
