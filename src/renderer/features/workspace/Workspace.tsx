import { usePodStore } from '@renderer/features/pods/usePodStore'
import { useWorkspaceBounds } from './useWorkspaceBounds'

/**
 * The workspace is intentionally empty in the DOM: it is just the placeholder
 * region whose bounds are handed to main, which layers the active Pod's
 * WebContentsView on top. When there is no Pod, a hint is shown.
 */
export function Workspace(): React.JSX.Element {
  const ref = useWorkspaceBounds()
  const hasActive = usePodStore((s) => s.activePodId !== null)

  return (
    <div ref={ref} className="relative h-full w-full">
      {!hasActive && (
        <div className="flex h-full w-full items-center justify-center text-[var(--color-muted)]">
          Select or add a Pod to get started.
        </div>
      )}
    </div>
  )
}
