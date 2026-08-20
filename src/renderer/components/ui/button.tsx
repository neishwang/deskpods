import { cn } from '@renderer/lib/utils'
import { type VariantProps, cva } from 'class-variance-authority'
import type * as React from 'react'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-[var(--color-accent)] text-white hover:opacity-90',
        secondary:
          'bg-[var(--color-surface)] text-white border border-[var(--color-border)] hover:border-[var(--color-muted)]',
        ghost: 'text-[var(--color-muted)] hover:bg-[var(--color-surface)] hover:text-white',
        outline: 'border border-[var(--color-border)] text-white hover:bg-[var(--color-surface)]'
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 px-3',
        icon: 'h-9 w-9'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps): React.JSX.Element {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

export { buttonVariants }
