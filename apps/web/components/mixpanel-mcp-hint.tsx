/**
 * Mixpanel lets nobody connect over MCP until an admin of the organization turns it on (new
 * Free and Growth organizations have it on already): this says where, for a sign-in that fails.
 */
export function MixpanelMcpHint() {
  return (
    <p className="text-sm text-muted-foreground">
      If Mixpanel refuses the connection, an admin of your Mixpanel organization turns MCP on in
      Settings → Org → Overview. It can take 15 minutes to apply; then you sign in again.
    </p>
  )
}
