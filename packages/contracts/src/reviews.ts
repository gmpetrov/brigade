// Reviews: another teammate reviews a pull request in a child thread of the thread that
// opened it, started by Brigade with a standard brief (src/reviews.ts in the API). Its
// report wakes the author, who fixes what it found and may ask it to look again.
import { z } from 'zod'
import { RepositoryName } from './repositories.js'

/**
 * Whether a project's pull requests get a review. teammate: the teammate that opens one
 * says whether it does, and why. manual: only when someone asks for one.
 */
export const ReviewPolicy = z.enum(['teammate', 'manual'])
export type ReviewPolicy = z.infer<typeof ReviewPolicy>

/** How long the thread that opened a pull request waits for its review, then hears what is done. */
export const REVIEW_WAIT_MINUTES = 3 * 60

/**
 * Looks a review takes at most, its first included. The author asks for another while the
 * review converges and stops on its own when it goes in circles (its instructions); this
 * ceiling, which the API keeps (messageChild), is for when that judgment fails.
 */
export const REVIEW_LOOKS = 8

/** A teammate asks for a review of a pull request of its thread (request_review), as a schedule.call operation. */
export const ReviewOperations = [
  z.object({
    name: z.literal('request_review'),
    repository: RepositoryName,
    number: z.number().int().positive(),
    /** A teammate's id or name; unset: Brigade picks one, on another model when it can. */
    reviewer: z.string().trim().min(1).max(200).optional(),
  }),
] as const

/**
 * What a teammate says of its pull request's review when it opens one, where it decides
 * (github_create_pull_request's review): whether another teammate reviews it, and why.
 */
export const ReviewChoice = z.object({
  wanted: z.boolean(),
  reason: z.string().trim().min(1).max(300),
})
export type ReviewChoice = z.infer<typeof ReviewChoice>
