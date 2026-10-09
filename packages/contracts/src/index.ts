// Zod schemas shared by api, runner and web. The single source of types.
export * from './api.js'
export * from './events.js'
export * from './runner.js'

/** Bump when the runner protocol changes incompatibly. */
export const PROTOCOL_VERSION = 1
/** The API rejects runners below this protocol version. */
export const MIN_PROTOCOL_VERSION = 1
