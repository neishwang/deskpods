import { DialogsHost } from '@renderer/features/pods/DialogsHost'
import { Sidebar } from '@renderer/features/pods/Sidebar'
import { usePodStore } from '@renderer/features/pods/usePodStore'
import { useCommands } from '@renderer/hooks/useCommands'
import { ipc } from '@renderer/lib/ipc'
import { Outlet } from '@tanstack/react-router'
import { useEffect } from 'react'

/** App chrome: persistent sidebar + routed content region. */
export function RootLayout(): React.JSX.Element {
  const load = usePodStore((s) => s.load)
  const run = useCommands()

  useEffect(() => {
    void load()
  }, [load])

  // Apply title/favicon updates pushed by main.
  useEffect(() => {
    return ipc.onPodUpdated((pod) => usePodStore.getState().applyPodUpdate(pod))
  }, [])

  // Run the dialog-opening actions raised by main's native context menus.
  useEffect(() => ipc.onUiCommand(run), [run])

  // Replace state after native-menu mutations (move / delete / folder edits).
  useEffect(() => {
    return ipc.onStateChanged((state) => usePodStore.getState().replaceState(state))
  }, [])

  return (
    <div className="flex h-full w-full">
      <Sidebar />
      <main className="relative flex-1">
        <Outlet />
      </main>
      <DialogsHost />
    </div>
  )
}
