'use client'
import { useParams } from 'next/navigation'
import { PlaybookSheet } from '@/components/playbooks'

export default function Playbook() {
  const { id } = useParams<{ id: string }>()
  return <PlaybookSheet id={id} />
}
