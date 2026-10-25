// Names on Brigade's mail domain. An address is <name>[.<project>][.<token>]@<domain>: the name
// is an agent's or a project inbox's, unique across Brigade and never given again (MailAddress);
// the project is the project's slug in that workspace (MailProject), fixed once used; the token
// marks a sign-up address (MailAlias). Dots only separate, so no part has one.
import { randomBytes } from 'node:crypto'
import { env } from '../config.js'

export const NAME_MIN = 2
export const NAME_MAX = 30
const NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/** Words no one may take: they read as the domain's own roles, or as Brigade speaking. */
export const RESERVED = new Set([
  'abuse',
  'admin',
  'administrator',
  'billing',
  'brigade',
  'help',
  'hostmaster',
  'info',
  'mailer-daemon',
  'no-reply',
  'noreply',
  'postmaster',
  'root',
  'security',
  'support',
  'team',
  'webmaster',
])

/** Why a name cannot be taken, or null when it can (taken by someone else aside). */
export function nameProblem(name: string): string | null {
  if (name.length < NAME_MIN || name.length > NAME_MAX)
    return `A name has ${NAME_MIN} to ${NAME_MAX} characters`
  if (!NAME.test(name))
    return 'A name has only lowercase letters, digits and hyphens, and starts and ends with a letter or a digit'
  if (name.includes('--')) return 'A name has no two hyphens in a row'
  if (RESERVED.has(name)) return `"${name}" is reserved`
  return null
}

/** Letters and digits of any text as a name's material: "Rïley Bot!" → "riley-bot". */
export function slugOf(text: string, max = NAME_MAX) {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
  return slug
}

/**
 * The names to offer for a teammate, best first: its own name, then name-2, name-3… The caller
 * takes the first one free. A name too short or reserved starts at name-2.
 */
export function* candidates(base: string) {
  let root = slugOf(base, NAME_MAX - 3) || 'agent'
  if (root.length < NAME_MIN) root = `${root}-agent`
  if (!nameProblem(root)) yield root
  for (let n = 2; n < 1000; n++) yield `${root}-${n}`
}

/** A sign-up address's token: 6 letters and digits, starting with a digit so it never reads as a project. */
export function aliasToken() {
  const bytes = randomBytes(6)
  const letters = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let token = String(bytes[0]! % 10)
  for (let i = 1; i < 6; i++) token += letters[bytes[i]! % letters.length]
  return token
}

export const mailDomain = () => env.MAIL_DOMAIN.toLowerCase()

export const addressOf = (local: string) => `${local}@${mailDomain()}`

/** The bare, lower-cased address in "Name <a@b>" or "a@b". */
export function bareAddress(value: string) {
  const inAngles = value.match(/<([^<>\s]+@[^<>\s]+)>/)
  return (inAngles?.[1] ?? value).trim().replace(/^mailto:/i, '').toLowerCase()
}

/** The part before the @ when the address is on Brigade's mail domain, else null. */
export function localOn(address: string, domain = mailDomain()) {
  const bare = bareAddress(address)
  const at = bare.lastIndexOf('@')
  if (at < 1 || bare.slice(at + 1) !== domain) return null
  return bare.slice(0, at)
}

/** A local part's pieces: name, then the project slug and the token when there are. */
export function partsOf(local: string) {
  const [name = '', ...rest] = local.split('.')
  return { name, rest }
}
