import { API_URL } from '@/lib/config'

/**
 * Atlassian lets an organization's MCP sign-ins come back only to domains it allows: its own
 * list (Claude, ChatGPT…), then those an admin adds. Brigade's is not on Atlassian's list, so
 * a sign-in can stop at "Access to this domain is restricted": this says what to add, and where.
 */
export function AtlassianDomainHint() {
  return (
    <p className="text-sm text-muted-foreground">
      If Atlassian says access to this domain is restricted, an admin of your Atlassian organization
      adds{' '}
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground select-all">
        {new URL(API_URL).origin}/**
      </code>{' '}
      under Rovo → Rovo MCP server → Domains in{' '}
      <a
        href="https://admin.atlassian.com"
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-2 hover:text-foreground"
      >
        Atlassian Administration
      </a>
      , then you sign in again.
    </p>
  )
}
