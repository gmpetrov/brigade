import type { ConnectorDefinition } from './types.js'

const read = (description: string) => ({ description, write: false })
const write = (description: string) => ({ description, write: true })

/**
 * Mixpanel's own MCP server: queries, reports, dashboards, Lexicon, cohorts, experiments and
 * feature flags, as the person who signed in, with their project permissions. Mixpanel
 * registers Brigade as a client itself (dynamic client registration). Each data region has
 * its own server: the member picks theirs as the account signs in. An organization admin
 * must turn MCP on in Mixpanel (Settings → Org → Overview) before anyone can connect.
 */
export const mixpanel: ConnectorDefinition = {
  kind: 'mixpanel',
  label: 'Mixpanel',
  auth: 'mcp',
  operations: {},
  mcp: {
    url: 'https://mcp.mixpanel.com/mcp',
    regions: {
      us: { label: 'United States (mixpanel.com)', url: 'https://mcp.mixpanel.com/mcp' },
      eu: { label: 'Europe (eu.mixpanel.com)', url: 'https://mcp-eu.mixpanel.com/mcp' },
      in: { label: 'India (in.mixpanel.com)', url: 'https://mcp-in.mixpanel.com/mcp' },
    },
    // A sign-in reaches every organization of the person: an account shows as their names.
    account: { tool: 'List-Organizations', name: mixpanelAccountName },
    // Brigade's list wins over the server's hints, so a read-only grant still gets the reads.
    tools: {
      'Run-Query': read('Run an insights, funnels, flows or retention query.'),
      'Get-Query-Schema': read('The full JSON schema for building a query.'),
      'Get-Report': read('Read a saved report, optionally with its results.'),
      'Display-Query': read('Show a chart of a query already run.'),
      'List-Dashboards': read('List the dashboards in a project.'),
      'Get-Dashboard': read('Read a dashboard: its details, text cards and reports.'),
      'Create-Dashboard': write('Create a dashboard with text cards and reports.'),
      'Update-Dashboard': write('Change a dashboard’s details, rows and layout.'),
      'Duplicate-Dashboard': write('Copy a dashboard.'),
      'Delete-Dashboard': write('Delete a dashboard.'),
      'Get-Business-Context': read('The organization’s and project’s business context.'),
      'Get-Projects': read('List the projects and workspaces.'),
      'List-Organizations': read('List the organizations the account belongs to.'),
      'Get-Events': read('Browse and search the events in a project.'),
      'List-Properties': read('List and search event or user properties.'),
      'Get-Property-Values': read('The values of a property.'),
      'Search-Entities': read('Search dashboards, reports, experiments, flags and more.'),
      'Get-Issues': read('Data quality issues, by event, property, type or date.'),
      'Get-Lexicon-URL': read('A link to an event or property in Lexicon.'),
      'Edit-Event': write('Change an event’s description, name, tags or visibility.'),
      'Edit-Property': write('Change a property’s description, name, visibility or PII flag.'),
      'Bulk-Edit-Events': write('Edit up to 50 events at once.'),
      'Bulk-Edit-Properties': write('Edit up to 50 properties at once.'),
      'Create-Tag': write('Create a Lexicon tag.'),
      'Rename-Tag': write('Rename a Lexicon tag everywhere it is used.'),
      'Delete-Tag': write('Delete a Lexicon tag.'),
      'Dismiss-Issues': write('Dismiss data quality issues.'),
      'Update-Business-Context': write('Change the organization’s or project’s business context.'),
      'Find-Duplicate-Groups': read('Find events and properties with duplicate names.'),
      'Dismiss-Duplicate-Group': write('Dismiss a duplicate-names suggestion.'),
      'Merge-Group': write('Merge duplicate names into one.'),
      'Create-Custom-Property': write('Create a custom property.'),
      'Get-Custom-Property': read('Read a custom property’s definition.'),
      'Update-Custom-Property': write('Change a custom property’s definition.'),
      'List-Cohorts': read('List the cohorts in a project.'),
      'Get-Cohort': read('Read a cohort’s details and definition.'),
      'Describe-Cohort-Schema': read('How a cohort definition is written.'),
      'Create-Cohort': write('Create a cohort.'),
      'Update-Cohort': write('Change a cohort.'),
      'Delete-Cohort': write('Delete a cohort.'),
      'Get-Lookup-Table': read('Read a lookup table’s schema and first rows.'),
      'Create-Lookup-Table': write('Create a lookup table.'),
      'Update-Lookup-Table': write('Change a lookup table.'),
      'List-Metrics': read('List the saved metrics in a project.'),
      'Get-Metric': read('Read a saved metric’s definition.'),
      'Create-Metric': write('Save a metric for experiments.'),
      'Update-Metric': write('Change a saved metric.'),
      'Get-User-Replays-Data': read('A user’s session replays with their events.'),
      'List-Experiments': read('List and search the experiments in a project.'),
      'Get-Experiment': read('Read an experiment: its setup and results.'),
      'Create-Experiment': write('Create an experiment.'),
      'Update-Experiment': write('Change an experiment, or start or stop it.'),
      'Get-Experiment-Setup-Guidance': read('Advice on designing an experiment.'),
      'Get-Experiment-Results-Interpretation-Guidance': read(
        'Advice on reading an experiment’s results.',
      ),
      'Explain-Experiment-Health-Check': read('Why an experiment’s health check fires.'),
      'Run-Experiment-Pre-Launch-Checks': read('Check a draft experiment before it launches.'),
      'Search-Prior-Experiments': read('Find earlier experiments on the same surface.'),
      'List-Feature-Flags': read('List and search the feature flags in a project.'),
      'Get-Feature-Flag': read('Read a feature flag and its targeting.'),
      'Create-Feature-Flag': write('Create a feature flag.'),
      'Update-Feature-Flag': write('Change a feature flag or its targeting.'),
      'Get-Feature-Flag-Setup-Guidance': read('Advice on setting up a feature flag.'),
      'Get-Feature-Flag-Lifecycle-Guidance': read('Advice on rolling out and cleaning up a flag.'),
      'Get-Audit-Log': read('Who changed what in the organization, and when (beta, admins).'),
    },
  },
}

/**
 * The Mixpanel account as a row shows it: its organizations, from List-Organizations as a
 * list, an object holding one, or Mixpanel's usual map of organizations by id.
 */
export function mixpanelAccountName(output: unknown): string | null {
  const unwrap = (value: unknown): unknown => {
    if (Array.isArray(value) || !value || typeof value !== 'object') return value
    const o = value as { results?: unknown; organizations?: unknown; name?: unknown }
    if (typeof o.name === 'string') return [value]
    if (o.results !== undefined) return unwrap(o.results)
    if (o.organizations !== undefined) return unwrap(o.organizations)
    // A map by id: { "123": { name }, ... }.
    return Object.values(value)
  }
  const list = unwrap(output)
  if (!Array.isArray(list)) return null
  const names = list
    .map((o) => (o as { name?: unknown } | null)?.name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
  if (!names.length) return null
  return names.length === 1 ? names[0]! : `${names[0]} +${names.length - 1}`
}
