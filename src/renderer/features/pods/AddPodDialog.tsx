import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { ipc } from '@renderer/lib/ipc'
import type { FolderId } from '@types'
import { type FormEvent, useState } from 'react'
import { normalizeUrl } from './url'
import { usePodStore } from './usePodStore'

// The native <select> popup ignores parent theming, so each <option> needs an
// explicit solid background/color or the list renders white on our dark chrome.
const optionStyle: React.CSSProperties = {
  backgroundColor: 'var(--color-surface)',
  color: 'white'
}

/** Add-a-Pod form. Rendered by DialogsHost while the dialog state is active. */
export function AddPodDialog({ folderId }: { folderId?: FolderId | null }): React.JSX.Element {
  const addPod = usePodStore((s) => s.addPod)
  const pods = usePodStore((s) => s.pods)
  const close = usePodStore((s) => s.setDialog)
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [linkTo, setLinkTo] = useState('')
  const [error, setError] = useState<string | null>(null)

  const browse = async () => {
    const fileUrl = await ipc.pickFile()
    if (fileUrl) {
      setUrl(fileUrl)
      if (error) setError(null)
    }
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const normalized = normalizeUrl(url)
    if (!normalized) {
      setError('Enter a valid URL (e.g. app.slack.com) or pick a local file.')
      return
    }
    await addPod({
      url: normalized,
      name: name.trim() || undefined,
      folderId: folderId ?? null,
      linkTo: linkTo || undefined
    })
    close(null)
  }

  return (
    <Dialog open onOpenChange={(next) => !next && close(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a Pod</DialogTitle>
          <DialogDescription>
            Paste any web app URL. The name and icon are detected automatically.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid gap-2">
            {/* biome-ignore lint/a11y/noLabelWithoutControl: Input renders the control */}
            <label className="text-sm text-[var(--color-muted)]">URL or local file</label>
            <div className="flex gap-2">
              <Input
                autoFocus
                className="flex-1"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value)
                  if (error) setError(null)
                }}
                placeholder="https://mail.google.com"
              />
              <Button type="button" variant="ghost" onClick={browse}>
                Browse…
              </Button>
            </div>
          </div>

          <div className="grid gap-2">
            {/* biome-ignore lint/a11y/noLabelWithoutControl: Input renders the control */}
            <label className="text-sm text-[var(--color-muted)]">Name (optional)</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Gmail" />
          </div>

          {pods.length > 0 && (
            <div className="grid gap-2">
              {/* biome-ignore lint/a11y/noLabelWithoutControl: select renders the control */}
              <label className="text-sm text-[var(--color-muted)]">
                Share session with (optional)
              </label>
              <select
                value={linkTo}
                onChange={(e) => setLinkTo(e.target.value)}
                className="h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm text-white outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              >
                <option value="" style={optionStyle}>
                  None (isolated session)
                </option>
                {pods.map((p) => (
                  <option key={p.id} value={p.id} style={optionStyle}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(null)}>
              Cancel
            </Button>
            <Button type="submit">Add Pod</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
