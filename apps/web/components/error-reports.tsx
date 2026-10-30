'use client'
import { useEffect } from 'react'
import { listenForErrors } from '@/lib/error-reports'

/** Mounted in the dashboard and onboarding: their uncaught errors go to error tracking. */
export function ErrorReports() {
  useEffect(listenForErrors, [])
  return null
}
