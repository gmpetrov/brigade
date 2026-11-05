import { BrigadeMark } from '@/components/brigade-mark'

/** Centered column with the brand mark, shared by every onboarding step. */
export function Shell({
  title,
  description,
  children,
}: {
  title?: string
  description?: string
  children?: React.ReactNode
}) {
  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-12">
      <div className="flex w-full max-w-md flex-col gap-7">
        <div className="flex flex-col items-center gap-4 text-center">
          <BrigadeMark className="size-14" />
          {title && (
            <div className="flex flex-col gap-1.5">
              <h1 className="text-3xl font-extrabold tracking-tight">{title}</h1>
              {description && <p className="text-sm text-muted-foreground">{description}</p>}
            </div>
          )}
        </div>
        {children}
      </div>
    </main>
  )
}
