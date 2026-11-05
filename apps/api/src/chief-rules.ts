// A person's rules (docs/chief-answers.md): a text in their words that every teammate working for
// them reads (ThreadSpec.rules), deciding what it settles and asking them only the rest. They keep
// it in Preferences → Chief, write it with Chief in a thread (chief_rules), and take the rules
// Chief's daily pass proposes from their answers (decideRule). With their daily pass (chiefPass),
// set here too, Chief answers in their name what the rules settle (src/chief-pass.ts).
import {
  CHIEF_PASS_HOUR,
  CHIEF_RULES_MAX,
  CHIEF_RULES_REFUSED_MAX,
  type ChiefRuleDecision,
  type ChiefSettings,
  type SetChief,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit } from './audit.js'
import type { Scope, ScopedDb } from './db.js'

/** A timezone the platform knows (IANA): a pass runs in the person's morning by it. */
export function validTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

/** A rule as a line of the rules. */
const asLine = (line: string) => `- ${line.replace(/\s+/g, ' ').trim()}`

/** Whether the rules hold that line already, however it was written. */
const holds = (rules: string, line: string) => {
  const want = line.replace(/\s+/g, ' ').trim().toLowerCase()
  return rules
    .split('\n')
    .map((l) =>
      l
        .replace(/^\s*[-*]\s*/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase(),
    )
    .includes(want)
}

/** What a member set for Chief (GET /me/chief). */
export async function chiefSettings(db: ScopedDb, memberId: string): Promise<ChiefSettings> {
  const member = await db.member.findFirst({
    where: { id: memberId },
    select: { chiefPass: true, chiefRules: true, timezone: true },
  })
  return {
    pass: member?.chiefPass ?? false,
    rules: member?.chiefRules ?? '',
    timezone: member?.timezone ?? null,
    hour: CHIEF_PASS_HOUR,
  }
}

/** A member turns their pass on or off, sets their rules, or says their timezone (PUT /me/chief). */
export async function setChief(
  db: ScopedDb,
  scope: Scope & { memberId: string },
  input: SetChief,
): Promise<ChiefSettings> {
  if (input.timezone !== undefined && !validTimezone(input.timezone))
    throw new HTTPException(400, { message: `Unknown timezone: ${input.timezone}` })
  const rules = input.rules === undefined ? undefined : input.rules.trim() || null
  await db.member.update({
    where: { id: scope.memberId },
    data: {
      ...(input.pass !== undefined ? { chiefPass: input.pass } : {}),
      ...(rules !== undefined ? { chiefRules: rules } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    },
  })
  if (input.pass !== undefined || rules !== undefined)
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action:
        input.pass === true
          ? 'chief.pass_on'
          : input.pass === false
            ? 'chief.pass_off'
            : 'chief.rules_changed',
      target: { type: 'member', id: scope.memberId },
    })
  return chiefSettings(db, scope.memberId)
}

/**
 * The person takes a rule Chief's pass proposed (a line at the end of their rules), or refuses it
 * (kept so Chief does not propose it again). POST /me/chief/rules.
 */
export async function decideRule(
  db: ScopedDb,
  scope: Scope & { memberId: string },
  input: ChiefRuleDecision,
): Promise<ChiefSettings> {
  const member = await db.member.findFirst({
    where: { id: scope.memberId },
    select: { chiefRules: true, chiefRulesRefused: true },
  })
  if (!member) throw new HTTPException(404, { message: 'No such member' })
  const rules = member.chiefRules ?? ''
  if (input.add) {
    if (!holds(rules, input.line)) {
      const next = rules.trim() ? `${rules.trimEnd()}\n${asLine(input.line)}` : asLine(input.line)
      if (next.length > CHIEF_RULES_MAX)
        throw new HTTPException(400, {
          message: `Your rules would be longer than ${CHIEF_RULES_MAX} characters: shorten them first, in Preferences.`,
        })
      await db.member.update({ where: { id: scope.memberId }, data: { chiefRules: next } })
    }
  } else {
    const line = input.line.replace(/\s+/g, ' ').trim()
    const refused = [...member.chiefRulesRefused.filter((r) => r !== line), line].slice(
      -CHIEF_RULES_REFUSED_MAX,
    )
    await db.member.update({
      where: { id: scope.memberId },
      data: { chiefRulesRefused: refused },
    })
  }
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: input.add ? 'chief.rule_added' : 'chief.rule_refused',
    target: { type: 'member', id: scope.memberId },
    data: { line: input.line },
  })
  return chiefSettings(db, scope.memberId)
}

/** Where a proposed rule stands for a person: in their rules, refused, or still a proposal. */
export function ruleState(
  member: { chiefRules: string | null; chiefRulesRefused: string[] },
  line: string,
): 'added' | 'refused' | 'proposed' {
  if (holds(member.chiefRules ?? '', line)) return 'added'
  const want = line.replace(/\s+/g, ' ').trim()
  return member.chiefRulesRefused.includes(want) ? 'refused' : 'proposed'
}

/** A person's rules as their teammates read them: null when they wrote none. */
export async function personRules(db: ScopedDb, memberId: string) {
  const member = await db.member.findFirst({
    where: { id: memberId },
    select: { chiefRules: true, chiefPass: true, user: { select: { name: true } } },
  })
  if (!member) return null
  const text = member.chiefRules?.trim() ?? ''
  return {
    person: member.user.name || 'the person',
    text: text ? text.slice(0, CHIEF_RULES_MAX) : null,
    pass: member.chiefPass,
  }
}

/**
 * Chief writes the person's rules with them in a thread (chief_rules): their rules, whole, as
 * they agreed to them. Only in a thread one person asks in, theirs.
 */
export async function setRulesByChief(
  db: ScopedDb,
  scope: Scope,
  personId: string | null,
  rules: string,
): Promise<object | { error: string }> {
  if (!personId)
    return {
      error:
        'This thread is not one person’s: write rules with the person in a thread of theirs, or they set them in Preferences → Chief.',
    }
  const text = rules.trim() || null
  await db.member.update({ where: { id: personId }, data: { chiefRules: text } })
  await audit({
    ...scope,
    actor: { type: 'teammate', id: 'chief' },
    action: 'chief.rules_changed',
    target: { type: 'member', id: personId },
  })
  return {
    ok: true,
    next: text
      ? 'Saved. Their teammates read these rules from their next session on. Read them back in a few lines.'
      : 'Their rules are cleared.',
  }
}
