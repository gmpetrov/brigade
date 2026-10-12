'use client'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/** A placeholder page to check that a new dashboard route shows up in the sidebar. */
export default function Test42() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-extrabold tracking-tight">Test 42</h1>
        <p className="max-w-prose text-muted-foreground">A test page in the dashboard.</p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>It works</CardTitle>
          <CardDescription>This page lives at /app/test-42.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">Nothing to do here yet.</CardContent>
      </Card>
    </div>
  )
}
