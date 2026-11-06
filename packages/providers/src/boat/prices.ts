// boat's list prices (docs.boat.dev/pricing, read on 2026-11-06), the one place Brigade keeps
// them: what its VMs cost is estimated from these (docs/vm-costs.md, apps/api/src/vm-costs.ts).
// Change them here when boat changes its prices.
import type { ComputerSize } from '../types.js'

export const VM_PRICES = {
  /** Dollars per hour a VM of each size runs, billed by the second; a stopped VM costs nothing. */
  hourly: { '2x4': 0.018, '4x8': 0.036, '8x16': 0.072 } satisfies Record<ComputerSize, number>,
  /** boat's name for each size. */
  names: { '2x4': 'small', '4x8': 'default', '8x16': 'large' } satisfies Record<
    ComputerSize,
    string
  >,
  /**
   * Starts (a create, a fork or a resume each count one) the $20 plan includes, for the whole
   * account; past them, a start costs `extraStart` dollars, and only with extra starts turned on.
   */
  includedStarts: { perMinute: 12, perHour: 60, perDay: 200 },
  extraStart: { min: 0.03, max: 0.07 },
  /**
   * Saved snapshots: 10 included per $20 of plan, each one past them `savedSnapshotPerDay`
   * dollars a day. Automatic snapshots (the one each stop takes) are free. Brigade saves none.
   */
  includedSavedSnapshots: 10,
  savedSnapshotPerDay: 0.056,
} as const

/** What `hours` of a VM of `size` cost at list price. */
export const vmCost = (size: ComputerSize, hours: number) => hours * VM_PRICES.hourly[size]
