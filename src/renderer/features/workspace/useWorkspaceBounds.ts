import { ipc } from '@renderer/lib/ipc'
import { useEffect, useRef } from 'react'

/**
 * Reports the DOM region that should host the active Pod's WebContentsView.
 * Main uses these bounds to position the native view precisely over the gap
 * left in the React chrome. On unmount, collapses the view to zero size so it
 * no longer covers other UI (e.g. the settings page).
 */
export function useWorkspaceBounds(): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const report = () => {
      const r = el.getBoundingClientRect()
      void ipc.updateBounds({
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height)
      })
    }

    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    window.addEventListener('resize', report)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      void ipc.updateBounds({ x: 0, y: 0, width: 0, height: 0 })
    }
  }, [])

  return ref
}
