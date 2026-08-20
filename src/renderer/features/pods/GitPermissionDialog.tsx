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
import { FolderOpen, TriangleAlert } from 'lucide-react'
import { useRef, useState } from 'react'
import { usePodStore } from './usePodStore'

/**
 * Asked the first time a Pod's page calls `window.__deskpods.git(...)`.
 *
 * Granting is deliberately two decisions in one: which Pod, and which folder.
 * The answer is remembered with the Pod, so this appears once per Pod — and
 * again from scratch if that Pod is deleted and recreated.
 */
export function GitPermissionDialog({
  id,
  origin
}: { id: PodId; origin: string }): React.JSX.Element | null {
  const pod = usePodStore((s) => s.pods.find((p) => p.id === id))
  const setDialog = usePodStore((s) => s.setDialog)
  const [root, setRoot] = useState<string | null>(null)
  // The page is waiting on a promise: every way out of this dialog has to send
  // exactly one answer, and closing it counts as a refusal.
  const answered = useRef(false)

  const answer = (allowed: boolean) => {
    if (answered.current) return
    answered.current = true
    void ipc.resolveGitPermission(id, allowed, allowed ? root : null)
    setDialog(null)
  }

  const browse = async () => {
    const picked = await ipc.pickFolder()
    if (picked) setRoot(picked)
  }

  if (!pod) return null

  return (
    <Dialog open onOpenChange={(next) => !next && answer(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Allow “{pod.name}” to run git?</DialogTitle>
          <DialogDescription>
            This page is asking DeskPods to run git commands on your machine.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-xs text-[var(--color-muted)]">
          <span className="break-all text-[var(--color-text)]">{origin || pod.url}</span>
        </div>

        <div>
          <div className="mb-1 text-sm font-medium">Repository folder</div>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 truncate rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm">
              {root ?? <span className="text-[var(--color-muted)]">No folder chosen</span>}
            </div>
            <Button type="button" variant="ghost" onClick={browse}>
              <FolderOpen className="mr-1.5 h-4 w-4" />
              Choose…
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-[var(--color-muted)]">
            Commands run in this folder and can never step outside it.
          </p>
        </div>

        <div className="flex gap-2 rounded-lg border border-[#f59e0b]/30 bg-[#f59e0b]/10 px-3 py-2 text-xs text-[var(--color-muted)]">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#f59e0b]" />
          <span>
            Any page this Pod loads will be able to run git there, with no further prompt. Only
            allow it for an app you trust. You can take it back from the Pod’s right-click menu.
          </span>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => answer(false)}>
            Deny
          </Button>
          <Button type="button" disabled={!root} onClick={() => answer(true)}>
            Allow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
