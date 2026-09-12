import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { cn } from '@renderer/lib/utils'
import type { FolderId } from '@types'
import { Check, Pencil } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { usePodStore } from './usePodStore'

/** Preset folder colours (two rows). */
const PALETTE = [
  '#5865f2',
  '#3ba55d',
  '#4098d7',
  '#9b59b6',
  '#e91e63',
  '#f1c40f',
  '#e67e22',
  '#e74c3c',
  '#95a5a6',
  '#607d8b',
  '#7289da',
  '#2ecc71',
  '#3498db',
  '#8e44ad',
  '#c2185b',
  '#f39c12',
  '#d35400',
  '#c0392b',
  '#7f8c8d',
  '#34495e'
]

export function FolderSettingsDialog({ id }: { id: FolderId }): React.JSX.Element | null {
  const folder = usePodStore((s) => s.folders.find((f) => f.id === id))
  const updateFolder = usePodStore((s) => s.updateFolder)
  const close = usePodStore((s) => s.setDialog)
  const [name, setName] = useState(folder?.name ?? '')
  const [color, setColor] = useState(folder?.color ?? PALETTE[0])
  const [icon, setIcon] = useState(folder?.icon ?? '')

  if (!folder) return null

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    // Empty string clears the emoji (undefined would be dropped by the IPC
    // serialization and leave the old icon in place).
    updateFolder(id, { name: name.trim() || folder.name, color, icon: icon.trim() })
    close(null)
  }

  return (
    <Dialog open onOpenChange={(next) => !next && close(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Folder Settings</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="grid gap-5">
          <div className="grid gap-2">
            {/* biome-ignore lint/a11y/noLabelWithoutControl: Input renders the control */}
            <label className="text-sm font-medium">Folder Name</label>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="grid gap-2">
            {/* biome-ignore lint/a11y/noLabelWithoutControl: Input renders the control */}
            <label className="text-sm font-medium">Icon (emoji, optional)</label>
            <Input
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              placeholder="📁  shown when the folder is open"
              maxLength={4}
            />
          </div>

          <div className="grid gap-3">
            <span className="text-sm font-medium">Folder Color</span>

            <label
              className="relative flex h-16 w-24 cursor-pointer items-center justify-center rounded-lg border border-[var(--color-border)]"
              style={{ backgroundColor: color }}
            >
              <Pencil className="h-4 w-4 text-white/90" />
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="absolute inset-0 cursor-pointer opacity-0"
              />
            </label>

            <div className="grid grid-cols-10 gap-2">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  style={{ backgroundColor: c }}
                  className={cn(
                    'flex aspect-square items-center justify-center rounded-md transition-transform hover:scale-110',
                    color.toLowerCase() === c.toLowerCase() && 'ring-2 ring-white'
                  )}
                >
                  {color.toLowerCase() === c.toLowerCase() && (
                    <Check className="h-3.5 w-3.5 text-white" />
                  )}
                </button>
              ))}
            </div>
          </div>

          <Button type="submit" className="w-full">
            Done
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
