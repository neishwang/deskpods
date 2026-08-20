import { cn } from '@renderer/lib/utils'
import type * as React from 'react'

export function Input({
  className,
  type,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <input
      type={type}
      className={cn(
        'flex h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1 text-sm text-white',
        'placeholder:text-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
}
