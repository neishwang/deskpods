import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { usePodStore } from '@renderer/features/pods/usePodStore'
import { type FormEvent, useState } from 'react'

interface PromptDialogProps {
  title: string
  label: string
  initialValue: string
  placeholder?: string
  submitLabel?: string
  /** Return an error message to block submission, or null when valid. */
  validate?: (value: string) => string | null
  /** Called with the (validated) value; dialog closes afterwards. */
  onSubmit: (value: string) => void
}

/** Single-text-field dialog reused for rename / edit-URL flows. */
export function PromptDialog({
  title,
  label,
  initialValue,
  placeholder,
  submitLabel = 'Save',
  validate,
  onSubmit
}: PromptDialogProps): React.JSX.Element {
  const close = usePodStore((s) => s.setDialog)
  const [value, setValue] = useState(initialValue)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const problem = validate?.(value) ?? null
    if (problem) {
      setError(problem)
      return
    }
    onSubmit(value)
    close(null)
  }

  return (
    <Dialog open onOpenChange={(next) => !next && close(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid gap-2">
            {/* biome-ignore lint/a11y/noLabelWithoutControl: Input renders the control */}
            <label className="text-sm text-[var(--color-muted)]">{label}</label>
            <Input
              autoFocus
              value={value}
              placeholder={placeholder}
              onChange={(e) => {
                setValue(e.target.value)
                if (error) setError(null)
              }}
            />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(null)}>
              Cancel
            </Button>
            <Button type="submit">{submitLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
