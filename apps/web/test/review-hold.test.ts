import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PullRequestTracking } from '../lib/api'
import { reviewHold, reviewHolds } from '../lib/merge-method'

// Whether a pull request's review holds it, and why in a sentence: a teammate's merge button
// says it instead of merging (components/pull-action.tsx), and Merge on its card asks first.
const cody = { id: 't-cody', name: 'Cody' }
const pull = (review: PullRequestTracking['review']) => ({
  tracking: { mergeStatus: 'none', review } as PullRequestTracking,
})
const verdict = (state: 'approved' | 'changes_requested', changed?: boolean) =>
  pull({
    state,
    reviewer: cody,
    threadId: 'review-thread',
    at: '2026-11-04T16:00:00.000Z',
    ...(changed === undefined ? {} : { changed }),
  })

test('a review under way, asking for changes, or behind the latest commits holds the merge, and says why', () => {
  const holds: [ReturnType<typeof pull>, string][] = [
    [
      pull({ state: 'reviewing', reviewer: cody, threadId: 'review-thread' }),
      'Cody is still reviewing #693',
    ],
    [verdict('changes_requested'), 'Cody asked for changes on #693'],
    // Its words may say nothing blocks: the verdict is what holds it.
    [verdict('changes_requested', false), 'Cody asked for changes on #693'],
    // Fixes pushed after it asked, not read yet.
    [verdict('changes_requested', true), 'Cody has not reviewed the latest commits on #693'],
    // Commits pushed after it approved.
    [verdict('approved', true), 'Cody has not reviewed the latest commits on #693'],
  ]
  for (const [p, why] of holds) {
    assert.equal(reviewHold(p, 693), why)
    assert.ok(reviewHolds(p))
  }
  // A reviewer gone from the workspace is still a teammate.
  assert.equal(
    reviewHold(pull({ state: 'reviewing', reviewer: null, threadId: 'review-thread' }), 693),
    'A teammate is still reviewing #693',
  )
})

test('an approval of the latest commits, no review, or none needed holds nothing back', () => {
  for (const p of [
    verdict('approved'),
    verdict('approved', false),
    pull({ state: 'skipped', reason: 'a copy change' }),
    pull(null),
    { tracking: null },
  ]) {
    assert.equal(reviewHold(p, 693), null)
    assert.ok(!reviewHolds(p))
  }
})
