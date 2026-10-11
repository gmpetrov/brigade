'use client'
// Hello world: a test page to check a new dashboard route renders in the shell.
import { useState } from 'react'
import { useDashboard } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export default function HelloWorldPage() {
  const { me } = useDashboard()
  const [count, setCount] = useState(0)

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-extrabold tracking-tight">Hello world</h1>
        <p className="max-w-prose text-muted-foreground">A test page inside the dashboard.</p>
      </header>

      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>Hello, {me.user.name || 'world'}!</CardTitle>
          <CardDescription>Click the button to check the page is interactive.</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-4">
          <Button onClick={() => setCount((c) => c + 1)}>Say hello</Button>
          <span className="text-sm text-muted-foreground">
            {count === 0 ? 'No hellos yet' : `${count} hello${count === 1 ? '' : 's'}`}
          </span>
        </CardContent>
      </Card>
    </div>
  )
}
