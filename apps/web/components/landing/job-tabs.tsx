'use client'

import { type KeyboardEvent, type ReactNode, useRef, useState } from 'react'
import { c } from './parts'

export type Job = { id: string; tab: ReactNode; panel: ReactNode }

/** "Give each teammate a job": every panel is in the markup; this only switches which one
 * shows, and plays its little conversation again from the start each time it is shown. */
export function JobTabs({ jobs }: { jobs: Job[] }) {
  const [selected, setSelected] = useState(0)
  // Bumped on each pick: the shown panel remounts, so its animation starts over.
  const [run, setRun] = useState(0)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])

  function pick(i: number, focus = false) {
    setSelected(i)
    setRun((n) => n + 1)
    if (focus) tabs.current[i]?.focus()
  }

  function onKeyDown(e: KeyboardEvent, i: number) {
    const n = jobs.length
    const next =
      e.key === 'ArrowRight'
        ? (i + 1) % n
        : e.key === 'ArrowLeft'
          ? (i - 1 + n) % n
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? n - 1
              : null
    if (next === null) return
    e.preventDefault()
    pick(next, true)
  }

  return (
    <>
      <div className={c('tabbar')} role="tablist" aria-label="Jobs">
        {jobs.map((job, i) => (
          <button
            key={job.id}
            ref={(el) => {
              tabs.current[i] = el
            }}
            type="button"
            className={c('tab')}
            role="tab"
            id={`tab-${job.id}`}
            aria-selected={i === selected}
            aria-controls={`job-${job.id}`}
            tabIndex={i === selected ? 0 : -1}
            onClick={() => pick(i)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {job.tab}
          </button>
        ))}
      </div>
      {jobs.map((job, i) => (
        <div
          key={i === selected ? `${job.id}-${run}` : job.id}
          className={c(i === selected ? 'panel play' : 'panel')}
          role="tabpanel"
          id={`job-${job.id}`}
          aria-labelledby={`tab-${job.id}`}
          hidden={i !== selected}
        >
          {job.panel}
        </div>
      ))}
    </>
  )
}
