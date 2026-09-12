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

/**
 * The program a command line invokes, for the narrow grant. Mirrors
 * `commandName` in `@main/shellCommand`; the renderer cannot import from main,
 * and main checks the real thing anyway - this only labels the button.
 */
function programOf(command: string): string {
  const line = command.trim()
  const quoted = line.match(/^"([^"]*)"/)
  const token = quoted ? quoted[1] : line.split(/\s+/)[0]
  const name = (token.split(/[/]/).pop() ?? '').replace(/\.(exe|cmd|bat|com|ps1)$/i, '')
  return name.toLowerCase()
}

/**
 * Asked the first time a Pod's page calls `window.__deskpods.exec(...)`, and
 * again whenever it reaches for a program the Pod was not granted.
 *
 * The command is shown as it will run: an authorisation asked on a concrete
 * case gets decided, asked in the abstract it gets clicked. Allowing just that
 * program is the ordinary answer; allowing everything is the deliberate one.
 */
export function ExecPermissionDialog({
  id,
  origin,
  command
}: {
  id: PodId
  origin: string
  command: string
}): React.JSX.Element | null {
  const pod = usePodStore((s) => s.pods.find((p) => p.id === id))
  const setDialog = usePodStore((s) => s.setDialog)
  // The page is waiting on a promise: answer exactly once, and closing counts
  // as a refusal.
  const answered = useRef(false)

  const answer = (allowed: boolean, allow: string[] | null) => {
    if (answered.current) return
    answered.current = true
    void ipc.resolveExecPermission(id, allowed, allow)
    setDialog(null)
  }

  if (!pod) return null

  const program = programOf(command)

  return (
    <Dialog open onOpenChange={(next) => !next && answer(false, null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Let “{pod.name}” run commands on this PC?</DialogTitle>
          <DialogDescription>
            This page is asking DeskPods to run a command line on your machine, with your rights.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-xs text-[var(--color-muted)]">
          <div>
            Asking: <span className="break-all text-[var(--color-text)]">{origin || pod.url}</span>
          </div>
          <div className="break-all font-mono text-[var(--color-text)]">{command}</div>
        </div>

        <div className="flex gap-2 rounded-lg border border-[#f59e0b]/30 bg-[#f59e0b]/10 px-3 py-2 text-xs text-[var(--color-muted)]">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#f59e0b]" />
          <span>
            A Pod is a web site. Allowing <strong className="font-semibold">every command</strong>{' '}
            hands it this machine, not just a folder - anything you can run, it can run. Allowing
            only <span className="font-mono">{program}</span> keeps it to that program, and DeskPods
            will ask again for the next one. You can take it back from the Pod’s right-click menu.
          </span>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => answer(false, null)}>
            Deny
          </Button>
          <Button type="button" variant="outline" onClick={() => answer(true, null)}>
            Allow every command
          </Button>
          <Button type="button" disabled={!program} onClick={() => answer(true, [program])}>
            Allow “{program}”
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
