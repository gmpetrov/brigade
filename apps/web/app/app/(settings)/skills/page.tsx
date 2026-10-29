'use client'
import { isAdmin, useDashboard } from '@/components/dashboard'
import { Skills } from '@/components/skills'

export default function SkillsPage() {
  const { me } = useDashboard()
  return <Skills admin={isAdmin(me)} />
}
