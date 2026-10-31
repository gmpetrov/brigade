'use client'
// Members' names by id, for what others wrote in a thread: one list, fetched once per page.
import { useMemo } from 'react'
import { useApi, type MembersResponse } from '@/lib/api'

export function useMemberNames(enabled = true) {
  const members = useApi<MembersResponse>(enabled ? '/members' : null)
  return useMemo(
    () => new Map((members.data?.members ?? []).map((m) => [m.id, m.name || m.email])),
    [members.data],
  )
}
