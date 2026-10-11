'use client'
// Who may use a credential: every teammate or the ones picked, and which of
// them may use it without asking. In the Vault's form; the Security page's
// matrix shows the same thing for every credential at once.
import type { CredentialAccess, SetCredentialAccess } from '@brigade/contracts'
import { TeammateAvatar } from '@/components/dashboard'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { CredentialGrantLevel, Teammate } from '@/lib/api'

export type AccessValue = { access: CredentialAccess; grants: SetCredentialAccess['grants'] }

/** A teammate's level under this access: with access all, everyone may at least use it. */
export function levelOf(value: AccessValue, teammateId: string): CredentialGrantLevel {
  const grant = value.grants.find((g) => g.teammateId === teammateId)
  if (grant?.withoutAsking) return 'without_asking'
  return grant || value.access === 'all' ? 'use' : 'none'
}

export function withLevel(
  value: AccessValue,
  teammateId: string,
  level: CredentialGrantLevel,
): AccessValue {
  const others = value.grants.filter((g) => g.teammateId !== teammateId)
  return {
    ...value,
    grants:
      level === 'none'
        ? others
        : [...others, { teammateId, withoutAsking: level === 'without_asking' }],
  }
}

export const LEVEL_LABEL: Record<CredentialGrantLevel, string> = {
  none: 'No access',
  use: 'Can use, asks first',
  without_asking: 'Without asking',
}

export function CredentialAccessPicker({
  value,
  onChange,
  teammates,
  idPrefix,
  disabled,
}: {
  value: AccessValue
  onChange: (value: AccessValue) => void
  teammates: Pick<Teammate, 'id' | 'name' | 'harness'>[]
  idPrefix: string
  disabled?: boolean
}) {
  return (
    <fieldset className="flex flex-col gap-3" disabled={disabled}>
      <legend className="mb-2 text-sm font-medium">Who can use it</legend>
      <RadioGroup
        value={value.access}
        onValueChange={(access) => onChange({ ...value, access: access as CredentialAccess })}
        className="flex flex-wrap gap-x-6 gap-y-2"
      >
        <div className="flex items-center gap-2">
          <RadioGroupItem value="all" id={`${idPrefix}-all`} />
          <Label htmlFor={`${idPrefix}-all`} className="font-normal">
            All teammates, including new ones
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="selected" id={`${idPrefix}-selected`} />
          <Label htmlFor={`${idPrefix}-selected`} className="font-normal">
            Only the teammates picked below
          </Label>
        </div>
      </RadioGroup>
      {teammates.length === 0 ? (
        <p className="text-sm text-muted-foreground">No teammates yet.</p>
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {teammates.map((t) => {
            const level = levelOf(value, t.id)
            return (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <TeammateAvatar teammate={t} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.name}</span>
                <Select
                  value={level}
                  disabled={disabled}
                  onValueChange={(v) => onChange(withLevel(value, t.id, v as CredentialGrantLevel))}
                >
                  <SelectTrigger size="sm" aria-label={`${t.name}: access`} className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Shared with every teammate: nobody can be left out. */}
                    {value.access === 'selected' && (
                      <SelectItem value="none">{LEVEL_LABEL.none}</SelectItem>
                    )}
                    <SelectItem value="use">{LEVEL_LABEL.use}</SelectItem>
                    <SelectItem value="without_asking">{LEVEL_LABEL.without_asking}</SelectItem>
                  </SelectContent>
                </Select>
              </li>
            )
          })}
        </ul>
      )}
      <p className="text-sm text-muted-foreground">
        A teammate that can use it still needs a mention in the thread or a person’s approval.{' '}
        <span className="font-medium text-foreground">Without asking</span> lets it use the secret
        in any thread, triggered or scheduled ones too.
      </p>
    </fieldset>
  )
}
