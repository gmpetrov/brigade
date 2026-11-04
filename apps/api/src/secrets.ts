// The one list of secrets (in @brigade/contracts, which the runner shares to mask a reply's
// deltas as it streams them): what blocks mail (mail/text.ts) and masks a thread's events
// before they are stored (hub/runner-messages.ts).
export {
  MaskedStream,
  maskSecrets,
  maskSecretsIn,
  redacted,
  SECRET_PATTERNS,
  secretIn,
} from '@brigade/contracts'
