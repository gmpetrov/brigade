// Zod schemas shared by api, runner and web. The single source of types.
export * from './api.js'
export * from './attachments.js'
export * from './credentials.js'
export * from './events.js'
export * from './library.js'
export * from './mentions.js'
export * from './models.js'
export * from './pulls.js'
export * from './repositories.js'
export * from './runner.js'
export * from './schedules.js'
export * from './search.js'
export * from './tasks.js'

/**
 * Bump when the runner protocol changes. 2: threads with several teammates.
 * 3: self-update. 4: the library, memory and search. 5: git through the API's proxy.
 * 6: generated images. 7: attachments. 8: welcome lists running threads, to close lost turns.
 * 9: tasks. 10: schedules.
 */
export const PROTOCOL_VERSION = 10
/** The API rejects runners below this protocol version. */
export const MIN_PROTOCOL_VERSION = 1
