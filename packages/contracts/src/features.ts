// Features hidden until they are ready (docs/feature-flags.md): each is declared here, with
// whether people have it when the database says nothing of it, and opened to some people with a
// FeatureFlag row (everyone, addresses, email domains or workspaces).

export const FEATURES = {
  gmail: {
    description:
      'Connect Gmail accounts. Google blocks its restricted scopes for anyone not listed as a test ' +
      'user of the Google app until the app passes its CASA audit.',
    default: false,
  },
  google_drive: {
    description:
      'Connect Google Drive accounts (the full drive scope, restricted like Gmail’s until CASA).',
    default: false,
  },
  preview_machines: {
    description:
      'A machine of their own for threads (docs/previews.md): a member who has it can turn it on ' +
      'in Preferences, and each thread they start gets a cloud machine of its own, where its ' +
      'preview runs, with its code kept in sync as it changes, and where its teammates run heavy ' +
      'commands (renders, builds, test suites). Being tried by the team first.',
    default: false,
  },
  google_workspace_mcp: {
    description:
      'Connect Google Drive, Docs and Sheets through Google’s own MCP servers, ' +
      'beside the Apps on Google’s REST APIs. The servers are in Google’s Workspace Developer ' +
      'Preview Program, whose terms keep them to the team until Google makes them generally ' +
      'available.',
    default: false,
  },
  chief_acts: {
    description:
      "Chief acts on a person's rules (docs/chief-answers.md): their daily pass answers in their " +
      'name the questions their rules settle and tries failed threads again, and their teammates ' +
      'decide what the rules settle instead of asking. Without it, while rules are calibrated, ' +
      'the pass only recommends, and teammates still ask.',
    default: false,
  },
  tools: {
    description:
      'Tools (docs/tools.md): small web apps teammates make and save in the library, which people ' +
      'open beside a page or a thread. A tool lists library folders, keeps state, calls App ' +
      'accounts attached to it and sends messages to its thread. Being tried by the team first.',
    default: false,
  },
  google_ads: {
    description:
      'Connect Google Ads accounts. Until Brigade’s Google Cloud project has Basic access and the ' +
      'adwords scope passes Google’s verification, Google Ads accepts few calls a day and ' +
      'Google warns at sign-in that the app is unverified.',
    default: false,
  },
  meta_ads: {
    description:
      'Connect Meta Ads accounts (Facebook and Instagram ads). Until Brigade’s Meta app passes ' +
      'Meta’s business verification and App Review for ads_read and ads_management, only people ' +
      'with a role on the Meta app can sign in.',
    default: false,
  },
  missions: {
    description:
      'Missions (docs/missions.md): ongoing work a member delegates to a teammate, with its threads, ' +
      'routines, planned actions and what went out, on a Missions page with its week. An experiment, ' +
      'tried by the team first.',
    default: false,
  },
  pi_harness: {
    description:
      'Teammates on Pi (docs/harnesses.md), beside Claude Code and Codex: Pi runs inside the runner ' +
      'on the Claude or ChatGPT login already on the computer, for its model. It calls the ' +
      'providers as Claude Code and Codex do, which their terms do not allow a third-party client ' +
      'to, so a provider may suspend the login it runs on. Opened to Brigade’s own workspace only, ' +
      'to benchmark Pi against Claude Code and Codex.',
    default: false,
  },
  themes: {
    description:
      'Themes (docs/themes.md): a person asks a teammate to restyle their own dashboard (colours, ' +
      'fonts, a stylesheet, images), which applies live in their windows only. Tried by the team first.',
    default: false,
  },
} as const satisfies Record<string, { description: string; default: boolean }>

export type Feature = keyof typeof FEATURES

export const isFeature = (key: string): key is Feature => Object.hasOwn(FEATURES, key)

/** The App kinds behind a feature: hidden, and not connectable, for people without it. */
export const APP_FEATURES: Partial<Record<string, Feature>> = {
  gmail: 'gmail',
  google_drive: 'google_drive',
  google_ads: 'google_ads',
  meta_ads: 'meta_ads',
  google_drive_mcp: 'google_workspace_mcp',
  google_docs_mcp: 'google_workspace_mcp',
  google_sheets_mcp: 'google_workspace_mcp',
}
