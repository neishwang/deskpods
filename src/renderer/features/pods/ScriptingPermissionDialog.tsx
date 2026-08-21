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
import { TriangleAlert } from 'lucide-react'
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

/**
 * Asked the first time a Pod's page calls `window.__deskpods.openPage(...)`.
 *
 * The grant is per Pod and covers any site it later drives, so the prompt shows
 * the first target as an example rather than as the limit of what is allowed.
 */
export function ScriptingPermissionDialog({
  id,
  origin,
  target
}: { id: PodId; origin: string; target: string }): React.JSX.Element | null {
  const pod = usePodStore((s) => s.pods.find((p) => p.id === id))
  const setDialog = usePodStore((s) => s.setDialog)
  // The page is waiting on a promise: answer exactly once, and closing counts
  // as a refusal.
  const answered = useRef(false)

  const answer = (allowed: boolean) => {
    if (answered.current) return
    answered.current = true
    void ipc.resolveScriptingPermission(id, allowed)
    setDialog(null)
  }

  if (!pod) return null

  return (
    <Dialog open onOpenChange={(next) => !next && answer(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Let “{pod.name}” drive other sites?</DialogTitle>
          <DialogDescription>
            This page wants to open sites in the background and run its own scripts on them, using
            this Pod’s session.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-xs text-[var(--color-muted)]">
          <div>
            Asking: <span className="break-all text-[var(--color-text)]">{origin || pod.url}</span>
          </div>
          <div>
            First target: <span className="text-[var(--color-text)]">{hostOf(target)}</span>
          </div>
        </div>

        <div className="flex gap-2 rounded-lg border border-[#f59e0b]/30 bg-[#f59e0b]/10 px-3 py-2 text-xs text-[var(--color-muted)]">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#f59e0b]" />
          <span>
            Allowing this covers <strong className="font-semibold">any</strong> site, not just this
            one, and pages load logged in as this Pod — so it can read whatever this Pod can reach.
            You can take it back from the Pod’s right-click menu.
          </span>
        </div>

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
