// The chief: the teammate every workspace starts with. It sets up the team
// (an interview, then a proposal a person accepts) and answers or routes
// what people ask it.
import { z } from 'zod'

/** The chief's fixed name. Mentions match names in any case, so @chief finds it too. */
export const CHIEF_NAME = 'Chief'

/** A teammate's kind. Only the chief is special; every workspace has exactly one. */
export const TeammateKind = z.enum(['teammate', 'chief'])
export type TeammateKind = z.infer<typeof TeammateKind>

/** What a proposed teammate may do with a connection: read, or also write (each write asks a person first). */
export const ProposedConnection = z.object({
  kind: z.enum([
    'gmail',
    'google_calendar',
    'google_drive',
    'google_docs',
    'google_sheets',
    'stripe',
    'github',
  ]),
  scope: z.enum(['read', 'read_write']),
  /** Why the teammate needs it, in a few words. */
  why: z.string().max(200).optional(),
})
export type ProposedConnection = z.infer<typeof ProposedConnection>

export const ProposedTeammate = z.object({
  name: z.string().trim().min(1).max(80),
  /** One line: what it does, e.g. "Ships features and fixes bugs in acme/web". */
  role: z.string().trim().min(1).max(200),
  instructions: z.string().max(20_000),
  connections: z.array(ProposedConnection).max(4).default([]),
})
export type ProposedTeammate = z.infer<typeof ProposedTeammate>

/**
 * The team the chief proposes (its propose_team tool), shown as a card: a
 * person edits it and creates the teammates, or answers in their own words.
 */
export const PROPOSE_TEAM_TOOL = 'propose_team'
export const TeamProposal = z.object({
  teammates: z.array(ProposedTeammate).min(1).max(5),
})
export type TeamProposal = z.infer<typeof TeamProposal>

/** Creating the teammates of an accepted proposal, as a person edited it. */
export const CreateTeam = z.object({
  teammates: z.array(ProposedTeammate).min(1).max(5),
})
export type CreateTeam = z.infer<typeof CreateTeam>

/**
 * The message a proposal's "Create team" sends to the chief's thread. Plain
 * names: a mention would have them answer it instead of the chief.
 */
export const teamCreatedMessage = (teammates: { name: string }[]) =>
  `Created the team: ${teammates.map((t) => t.name).join(', ')}.`

/** The names a "Create team" message gives, or null when the message is not one. */
export function createdTeam(message: string) {
  const found = /^Created the team: (.+)\.$/.exec(message.trim())
  return found ? found[1]!.split(', ').map((name) => name.trim()) : null
}

/** A name the chief has: no other teammate may take it, in any case. */
export const isChiefName = (name: string) => name.trim().toLowerCase() === CHIEF_NAME.toLowerCase()
