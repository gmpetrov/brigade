/**
 * Whether a person has apps (docs/apps.md). The feature was `tools` before the rename: an API
 * deployed before this dashboard still names it so.
 */
export const hasApps = (features: readonly string[] | undefined) =>
  Boolean(features?.includes('apps') || features?.includes('tools'))
