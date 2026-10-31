'use client'
// Members: the people of the organization, in every one of its workspaces, with their role.
// Owners and admins invite more by email (only an owner invites an owner): the invited person
// gets a link, signs in with that address and joins. Open invitations show below, to mail
// again or cancel. Owners and admins also change a member's role or remove them (only an owner
// touches an owner); the organization keeps at least one owner.
import { EllipsisVertical, Mail, Plus } from 'lucide-react'
import { useState } from 'react'
import { isAdmin, useDashboard } from '@/components/dashboard'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, useApi, type MembersResponse } from '@/lib/api'

type Member = MembersResponse['members'][number]
type Role = Member['role']

const ROLES: { value: Role; label: string; description: string }[] = [
  {
    value: 'viewer',
    label: 'Viewer',
    description: 'Sees threads, tasks and files, changes nothing',
  },
  { value: 'member', label: 'Member', description: 'Starts threads and works with teammates' },
  { value: 'admin', label: 'Admin', description: 'Also manages teammates, Apps, billing' },
  { value: 'owner', label: 'Owner', description: 'Also deletes workspaces' },
]
const roleLabel = (role: string) => ROLES.find((r) => r.value === role)?.label ?? role

const initial = (name: string) => name.trim().charAt(0).toUpperCase() || '?'

/** In how many days an invitation closes, in a few words. */
function closesIn(iso: string) {
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000)
  return days <= 1 ? 'closes today' : `closes in ${days} days`
}

export default function MembersPage() {
  const { me } = useDashboard()
  const admin = isAdmin(me)
  const data = useApi<MembersResponse>('/members')
  const organization = me.organizations.find((o) => o.id === me.activeOrganizationId)
  const [inviting, setInviting] = useState(false)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('member')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [note, setNote] = useState<string>()

  async function invite(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    setNote(undefined)
    try {
      const sent = await api<{ email: string }>('/members/invitations', { body: { email, role } })
      setNote(`Invitation sent to ${sent.email}.`)
      setEmail('')
      setRole('member')
      setInviting(false)
      await data.reload()
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }

  async function resend(invitation: MembersResponse['invitations'][number]) {
    setError(undefined)
    setNote(undefined)
    try {
      await api('/members/invitations', {
        body: { email: invitation.email, role: invitation.role },
      })
      setNote(`Invitation sent again to ${invitation.email}.`)
      await data.reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function cancel(invitation: MembersResponse['invitations'][number]) {
    if (!confirm(`Cancel the invitation to ${invitation.email}? Its link stops working.`)) return
    setError(undefined)
    setNote(undefined)
    await api(`/members/invitations/${invitation.id}`, { method: 'DELETE' }).catch((e) =>
      setError((e as Error).message),
    )
    await data.reload()
  }

  async function changeRole(member: Member, to: Role) {
    if (to === member.role) return
    setError(undefined)
    setNote(undefined)
    try {
      await api(`/members/${member.id}`, { method: 'PATCH', body: { role: to } })
      setNote(`${member.name || member.email} is now ${roleLabel(to).toLowerCase()}.`)
    } catch (e) {
      setError((e as Error).message)
    }
    await data.reload()
  }

  async function remove(member: Member) {
    const who = member.name || member.email
    const from = organization?.name ?? 'the organization'
    if (
      !confirm(
        `Remove ${who} from ${from}? They lose access to every workspace. Threads they started on their own computer are deleted; the others become yours.`,
      )
    )
      return
    setError(undefined)
    setNote(undefined)
    try {
      await api(`/members/${member.id}`, { method: 'DELETE' })
      setNote(`${who} was removed from ${from}.`)
    } catch (e) {
      setError((e as Error).message)
    }
    await data.reload()
  }

  /** An owner changes anyone, their own role too; an admin anyone but an owner, and not themselves. */
  const canChange = (m: Member) =>
    admin && (me.role === 'owner' || (m.role !== 'owner' && m.id !== me.memberId))

  // An admin may not invite an owner: the choice isn't offered.
  const roles = ROLES.filter((r) => r.value !== 'owner' || me.role === 'owner')
  const invitations = data.data?.invitations ?? []

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <h1 className="text-3xl font-extrabold tracking-tight">Members</h1>
            <p className="max-w-prose text-muted-foreground">
              The people of {organization?.name ?? 'your organization'}, in each of its workspaces.{' '}
              {!admin && 'Ask an owner or admin to invite someone.'}
            </p>
          </div>
          {admin && !inviting && (
            <Button onClick={() => setInviting(true)}>
              <Plus />
              Invite
            </Button>
          )}
        </div>
        {error && <p className="text-sm text-destructive-text">{error}</p>}
        {note && (
          <p role="status" className="text-sm text-muted-foreground">
            {note}
          </p>
        )}
      </header>

      {inviting && (
        <Card className="max-w-xl px-6 py-5">
          <form onSubmit={invite} className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
                maxLength={320}
                required
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="invite-role">Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as Role)}>
                <SelectTrigger id="invite-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                      <span className="text-xs text-muted-foreground">{r.description}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-sm text-muted-foreground">
              They get an email with a link, sign in with this address and join every workspace of{' '}
              {organization?.name ?? 'the organization'}. The link works for 7 days.
            </p>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || !email.trim()}>
                Send invitation
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setInviting(false)
                  setError(undefined)
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      {data.error && <p className="text-sm text-destructive-text">{data.error.message}</p>}

      {data.data && (
        <Card className="gap-0 divide-y py-0">
          {data.data.members.map((m) => (
            <div
              key={m.id}
              className={`flex items-center gap-3 py-2.5 pl-4 ${admin ? 'pr-3' : 'pr-4'}`}
            >
              <Avatar className="size-8">
                {m.image && <AvatarImage src={m.image} alt="" referrerPolicy="no-referrer" />}
                <AvatarFallback className="bg-secondary text-sm font-bold">
                  {initial(m.name || m.email)}
                </AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">
                  {m.name || m.email}
                  {m.id === me.memberId && (
                    <span className="font-normal text-muted-foreground"> (you)</span>
                  )}
                </span>
                <span className="truncate text-xs text-muted-foreground">{m.email}</span>
              </div>
              <span className="text-sm text-muted-foreground">{roleLabel(m.role)}</span>
              {canChange(m) ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${m.name || m.email} options`}
                    >
                      <EllipsisVertical aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      Role
                    </DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={m.role}
                      onValueChange={(v) => void changeRole(m, v as Role)}
                    >
                      {roles.map((r) => (
                        <DropdownMenuRadioItem
                          key={r.value}
                          value={r.value}
                          className="flex-col items-start gap-0 [&>span:first-child]:top-2.5"
                        >
                          {r.label}
                          <span className="text-xs text-muted-foreground">{r.description}</span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                    {m.id !== me.memberId && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => void remove(m)}>
                          Remove from {organization?.name ?? 'the organization'}
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                admin && <span aria-hidden className="size-8 shrink-0" />
              )}
            </div>
          ))}
        </Card>
      )}

      {invitations.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-bold tracking-tight">Invited</h2>
          <Card className="gap-0 divide-y py-0">
            {invitations.map((i) => (
              <div key={i.id} className="flex items-center gap-3 py-2.5 pr-3 pl-4">
                <span
                  aria-hidden
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground"
                >
                  <Mail className="size-4" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{i.email}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    Invited by {i.invitedBy} · {closesIn(i.expiresAt)}
                  </span>
                </div>
                <span className="text-sm text-muted-foreground">{roleLabel(i.role)}</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`${i.email} options`}>
                      <EllipsisVertical aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuItem onSelect={() => void resend(i)}>Send again</DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onSelect={() => void cancel(i)}>
                      Cancel invitation
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}
          </Card>
        </section>
      )}
    </div>
  )
}
