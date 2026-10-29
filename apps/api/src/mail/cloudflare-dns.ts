// A workspace's domain whose DNS is at Cloudflare gets its records added there in one click,
// through the workspace's Cloudflare App account, rather than copied by hand. The App is
// Cloudflare's own MCP server: its execute tool runs JavaScript against the Cloudflare API with
// the account's sign-in, so the whole change is one script (`addRecordsCode`), run there. A record
// already in place is left as it is; one that would clash with another at its name is never
// replaced, only reported, so nothing a domain already uses is overwritten.
import type { CloudflareDnsResult, CloudflareDnsSetup } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit } from '../audit.js'
import { authorisedFetch } from '../connector-calls.js'
import { cloudflare } from '../connectors/cloudflare.js'
import { callMcpTool } from '../connectors/mcp.js'
import type { ScopedDb } from '../db.js'
import type { WorkspaceScope } from '../scope.js'
import { checkDomain, lookup } from './domains.js'

type DomainRecord = { type: string; name: string; value: string; priority?: number }

/** Cloudflare's nameservers: a zone on Cloudflare is served by *.ns.cloudflare.com. */
const CLOUDFLARE_NS = /\.ns\.cloudflare\.com\.?$/i

/** The domain and each parent, closest first: team.acme.com, acme.com (never the bare TLD). */
export const zoneCandidates = (domain: string) => {
  const labels = domain.split('.')
  return labels.slice(0, -1).map((_, i) => labels.slice(i).join('.'))
}

/**
 * A record's full name. Resend names records relative to the registered domain, so a subdomain's
 * name carries its labels ("send.team" for team.acme.com); an apex domain's does not ("send").
 */
export function fqdnOf(name: string, domain: string) {
  const relative = name.replace(/\.$/, '').toLowerCase()
  if (relative === '@' || relative === '') return domain
  if (relative === domain || relative.endsWith(`.${domain}`)) return relative
  const labels = domain.split('.')
  for (let i = labels.length - 1; i >= 1; i--) {
    const head = labels.slice(0, i).join('.')
    if (relative.endsWith(`.${head}`)) return `${relative.slice(0, -head.length - 1)}.${domain}`
  }
  return `${relative}.${domain}`
}

/**
 * The zone that answers for the domain: the closest name with nameservers of its own (a subdomain
 * delegated elsewhere is its own zone, and its parent's records below it are never seen), and
 * whether Cloudflare serves it. Null when DNS says nothing.
 */
export async function authoritativeZone(domain: string) {
  for (const name of zoneCandidates(domain)) {
    const ns = await lookup(name, 'NS').catch(() => null)
    if (ns?.length)
      return { zone: name, onCloudflare: ns.some((a) => CLOUDFLARE_NS.test(a.data.trim())) }
  }
  return null
}

/** Whether the domain's DNS is served by Cloudflare: its zone's nameservers. */
export const dnsOnCloudflare = async (domain: string) =>
  (await authoritativeZone(domain))?.onCloudflare ?? false

/** The workspace's Cloudflare accounts this member may use: shared ones, and their own. */
const usableAccounts = (db: ScopedDb, scope: WorkspaceScope) =>
  db.connection.findMany({
    where: {
      kind: 'cloudflare',
      status: 'active',
      OR: [{ reach: 'workspace' }, { createdByMemberId: scope.memberId }],
    },
    select: { id: true, label: true, externalAccount: true, vaultSecretId: true, kind: true },
    orderBy: { createdAt: 'asc' },
  })

/** Whether a domain can be set up on Cloudflare here, and with which accounts. */
export async function cloudflareSetup(
  db: ScopedDb,
  scope: WorkspaceScope,
  domainId: string,
): Promise<CloudflareDnsSetup> {
  const row = await db.mailDomain.findFirst({ where: { id: domainId } })
  if (!row) throw new HTTPException(404, { message: 'No such domain' })
  const [onCloudflare, accounts] = await Promise.all([
    dnsOnCloudflare(row.name),
    usableAccounts(db, scope),
  ])
  return {
    onCloudflare,
    accounts: accounts.map((a) => ({ id: a.id, label: a.externalAccount ?? a.label })),
  }
}

/**
 * The script run on Cloudflare: find the domain's zone in the account (only the one that answers
 * for it, `authoritativeZone`: records written in another would never be seen), then for each record, keep it when it is there already, report a clash when
 * another record holds its name (a CNAME shares its name with nothing; two SPF or DKIM values
 * would break both), else add it. Returns the zone and each record's result.
 */
export function addRecordsCode(domain: string, zone: string, records: DomainRecord[]) {
  const wanted = records.map((r) => ({
    type: r.type.toUpperCase(),
    name: fqdnOf(r.name, domain),
    content: r.value,
    ...(r.priority !== undefined ? { priority: r.priority } : {}),
  }))
  return `async () => {
  const zones = ${JSON.stringify([zone])};
  const wanted = ${JSON.stringify(wanted)};
  const same = (type, a, b) => {
    const clean = (v) => String(v ?? '').trim().replace(/^"|"$/g, '').replace(/"\\s*"/g, '').replace(/\\.$/, '');
    return type === 'TXT' ? clean(a) === clean(b) : clean(a).toLowerCase() === clean(b).toLowerCase();
  };
  let zone = null;
  for (const name of zones) {
    const found = await cloudflare.request({ method: 'GET', path: '/zones', query: { name } });
    if (!found.success) return { error: (found.errors?.[0]?.message) || 'Cloudflare refused to list zones' };
    if (found.result?.length) { zone = found.result[0]; break; }
  }
  if (!zone) return { zone: null, results: [] };
  const results = [];
  for (const record of wanted) {
    const at = await cloudflare.request({ method: 'GET', path: '/zones/' + zone.id + '/dns_records', query: { name: record.name, per_page: 100 } });
    if (!at.success) { results.push({ ...record, result: 'failed', note: (at.errors?.[0]?.message) || 'Not read' }); continue; }
    const existing = at.result ?? [];
    const sameType = existing.filter((r) => r.type === record.type);
    const match = sameType.find((r) => same(record.type, r.content, record.content) && (record.type !== 'MX' || r.priority === record.priority));
    // Proxied, a CNAME shows Cloudflare's addresses to the world, not its target: Resend never sees it.
    if (match && match.proxied) {
      results.push({ ...record, result: 'conflict', note: 'proxied: set it to DNS only' });
      continue;
    }
    if (match) {
      results.push({ ...record, result: 'present' });
      continue;
    }
    const clash = record.type === 'CNAME' ? existing[0] : sameType[0] ?? existing.find((r) => r.type === 'CNAME');
    if (clash) {
      results.push({ ...record, result: 'conflict', note: clash.type + ' ' + String(clash.content).slice(0, 80) });
      continue;
    }
    const made = await cloudflare.request({
      method: 'POST',
      path: '/zones/' + zone.id + '/dns_records',
      body: { type: record.type, name: record.name, content: record.content, ttl: 1, ...(record.type === 'CNAME' ? { proxied: false } : {}), ...(record.priority !== undefined ? { priority: record.priority } : {}), comment: 'Added by Brigade for its mail' },
    });
    results.push(made.success ? { ...record, result: 'added' } : { ...record, result: 'failed', note: (made.errors?.[0]?.message) || 'Not added' });
  }
  return { zone: zone.name, results };
}`
}

type ScriptAnswer =
  | { error: string }
  | { zone: string | null; results: (CloudflareDnsResult & { content: string })[] }

/** What Cloudflare's execute tool gave back: the script's value, as JSON or as its text. */
export function readAnswer(output: unknown): ScriptAnswer {
  let value = output
  if (typeof output === 'string') {
    try {
      value = JSON.parse(output)
    } catch {
      return { error: output.slice(0, 300) || 'Cloudflare gave no answer' }
    }
  }
  if (value && typeof value === 'object' && 'result' in value && !('results' in value))
    value = (value as { result: unknown }).result
  if (!value || typeof value !== 'object') return { error: 'Cloudflare gave no answer' }
  return value as ScriptAnswer
}

/**
 * Add a domain's records on Cloudflare with one of the workspace's Cloudflare accounts, then
 * read Resend's check again. Owners and admins only (the route says so).
 */
export async function addRecordsOnCloudflare(
  db: ScopedDb,
  scope: WorkspaceScope,
  domainId: string,
  connectionId: string,
) {
  const row = await db.mailDomain.findFirst({ where: { id: domainId } })
  if (!row) throw new HTTPException(404, { message: 'No such domain' })
  const account = (await usableAccounts(db, scope)).find((a) => a.id === connectionId)
  if (!account) throw new HTTPException(404, { message: 'No such Cloudflare account' })
  const records = (row.records ?? []) as DomainRecord[]
  if (!records.length)
    throw new HTTPException(409, { message: 'Its records are not known yet: try again shortly' })

  const zone = await authoritativeZone(row.name)
  if (!zone?.onCloudflare)
    throw new HTTPException(409, { message: `${row.name}'s DNS is not served by Cloudflare` })

  const signedIn = await authorisedFetch(db, scope, account)
  const output = await callMcpTool(signedIn, cloudflare.mcp!, 'execute', {
    code: addRecordsCode(row.name, zone.zone, records),
  }).catch((error: unknown) => {
    throw new HTTPException(502, {
      message: `Cloudflare did not run it: ${error instanceof Error ? error.message : String(error)}`,
    })
  })
  const answer = readAnswer(output)
  if ('error' in answer)
    throw new HTTPException(502, {
      message: `Cloudflare refused: ${answer.error}. The account may need permission to edit DNS: reconnect it in Apps.`,
    })
  if (!answer.zone)
    throw new HTTPException(409, {
      message: `This Cloudflare account does not have the zone ${zone.zone}, which serves ${row.name}: connect the account that has it`,
    })
  const results: CloudflareDnsResult[] = answer.results.map((r) => ({
    type: r.type,
    name: r.name,
    result: r.result,
    ...(r.note ? { note: r.note } : {}),
  }))
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'email.domain.dns_added',
    target: { type: 'mail_domain', id: row.id },
    data: { name: row.name, zone: answer.zone, connectionId, results },
  })
  // Resend reads the new records on its next check; its answer now, as far as it goes.
  if (results.some((r) => r.result === 'added' || r.result === 'present'))
    await checkDomain(db, row.id).catch(() => undefined)
  return { zone: answer.zone, results }
}
