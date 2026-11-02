'use client'
// Notifications: the member's own, for this device: turn web push on and pick a preset
// (NotificationsPanel in components/notifications.tsx).
import { NotificationsPanel } from '@/components/notifications'
import { Card } from '@/components/ui/card'

export default function NotificationsPage() {
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-extrabold tracking-tight">Notifications</h1>
        <p className="text-muted-foreground max-w-prose">
          Brigade tells you when something needs you, and otherwise stays quiet.
        </p>
      </header>

      <Card className="max-w-xl px-6 py-5">
        <NotificationsPanel />
      </Card>
    </div>
  )
}
