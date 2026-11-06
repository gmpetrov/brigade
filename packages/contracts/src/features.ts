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
} as const satisfies Record<string, { description: string; default: boolean }>

export type Feature = keyof typeof FEATURES

export const isFeature = (key: string): key is Feature => Object.hasOwn(FEATURES, key)

/** The App kinds behind a feature: hidden, and not connectable, for people without it. */
export const APP_FEATURES: Partial<Record<string, Feature>> = {
  gmail: 'gmail',
  google_drive: 'google_drive',
}
