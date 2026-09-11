import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { ipc } from '@renderer/lib/ipc'
import type { PodId } from '@types'
import { useRef } from 'react'
import { usePodStore } from './usePodStore'

/** Hostname of a URL, for a prompt that has to stay readable. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** File name at the end of a URL, when there is one worth showing. */
function fileOf(url: string): string {
  try {
    const name = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
    return decodeURIComponent(name)
  } catch {
    return ''
  }
}

/**
 * Asked the first time a Pod's page calls `window.__deskpods.download.start(…)`.
 *
 * Milder than the git/command prompts, and it says so: nothing runs, nothing is
 * read, and the user still answers a Save dialog for every single file. What is
 * being granted is the Pod's session — the file arrives logged in as this Pod,
 * which is the reason not to send it to the default browser in the first place.
 */
export function DownloadPermissionDialog({
  id,
  origin,
  url
}: { id: PodId; origin: string; url: string }): React.JSX.Element | null {
  const pod = usePodStore((s) => s.pods.find((p) => p.id === id))
  const setDialog = usePodStore((s) => s.setDialog)
  // The page is waiting on a promise: answer exactly once, and closing counts
  // as a refusal.
  const answered = useRef(false)

  const answer = (allowed: boolean) => {
    if (answered.current) return
    answered.current = true
    void ipc.resolveDownloadPermission(id, allowed)
    setDialog(null)
  }

  if (!pod) return null
  const file = fileOf(url)

  return (
    <Dialog open onOpenChange={(next) => !next && answer(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Let “{pod.name}” download files?</DialogTitle>
          <DialogDescription>
            This page wants to download files inside DeskPods, using this Pod’s session, instead of
            handing the link to your browser.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-xs text-[var(--color-muted)]">
          <div>
            Asking: <span className="break-all text-[var(--color-text)]">{origin || pod.url}</span>
          </div>
          <div>
            Downloading from: <span className="text-[var(--color-text)]">{hostOf(url)}</span>
          </div>
          {file && (
            <div>
              First file: <span className="break-all text-[var(--color-text)]">{file}</span>
            </div>
          )}
        </div>

        <p className="px-1 text-xs text-[var(--color-muted)]">
          You choose where every file goes — DeskPods asks each time. The page is only told how far
          along the download is. You can take this back from the Pod’s right-click menu.
        </p>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => answer(false)}>
            Deny
          </Button>
          <Button type="button" onClick={() => answer(true)}>
            Allow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
