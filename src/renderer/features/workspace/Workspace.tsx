import { usePodStore } from '@renderer/features/pods/usePodStore'
import { FindBar } from './FindBar'
import { useWorkspaceBounds } from './useWorkspaceBounds'

/**
 * The workspace is intentionally empty in the DOM: it is just the placeholder
 * region whose bounds are handed to main, which layers the active Pod's
 * WebContentsView on top. When there is no Pod, a hint is shown.
 *
 * The find bar is a sibling BELOW that region rather than an overlay on top of
 * it: a native view always paints over the chrome, so the only way to show UI
 * against a Pod is to give the Pod less room.
 */
export function Workspace(): React.JSX.Element {
  const ref = useWorkspaceBounds()
  const hasActive = usePodStore((s) => s.activePodId !== null)
  const findOpen = usePodStore((s) => s.findOpen)

  return (
    <div className="flex h-full w-full flex-col">
      <div ref={ref} className="relative flex-1">
        {!hasActive && (
          <div className="flex h-full w-full items-center justify-center text-[var(--color-muted)]">
            Select or add a Pod to get started.
          </div>
        )}
      </div>
      {findOpen && <FindBar />}
    </div>
  )
}
