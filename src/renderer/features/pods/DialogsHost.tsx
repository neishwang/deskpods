import { ipc } from '@renderer/lib/ipc'
import type { PodId } from '@types'
import { useEffect } from 'react'
import { AddPodDialog } from './AddPodDialog'
import { FolderSettingsDialog } from './FolderSettingsDialog'
import { PromptDialog } from './PromptDialog'
import { normalizeUrl } from './url'
import { usePodStore } from './usePodStore'

function RenamePod({ id }: { id: PodId }): React.JSX.Element | null {
  const pod = usePodStore((s) => s.pods.find((p) => p.id === id))
  const updatePod = usePodStore((s) => s.updatePod)
  if (!pod) return null
  return (
    <PromptDialog
      title="Rename Pod"
      label="Name"
      initialValue={pod.name}
      validate={(v) => (v.trim() ? null : 'Name cannot be empty.')}
      onSubmit={(v) => updatePod(id, { name: v.trim() })}
    />
  )
}

function EditPodUrl({ id }: { id: PodId }): React.JSX.Element | null {
  const pod = usePodStore((s) => s.pods.find((p) => p.id === id))
  const updatePod = usePodStore((s) => s.updatePod)
  if (!pod) return null
  return (
    <PromptDialog
      title="Edit URL"
      label="URL"
      initialValue={pod.url}
      validate={(v) => (normalizeUrl(v) ? null : 'Enter a valid URL.')}
      onSubmit={(v) => {
        const url = normalizeUrl(v)
        if (url) updatePod(id, { url })
      }}
    />
  )
}

/**
 * Renders whichever editing dialog is active. Hides the active Pod's native web
 * view while any dialog is open, since it would otherwise paint over the dialog.
 */
export function DialogsHost(): React.JSX.Element | null {
  const dialog = usePodStore((s) => s.dialog)

  useEffect(() => {
    void ipc.setOverlay(dialog !== null)
    if (dialog !== null) void ipc.hideTooltip()
    return () => {
      void ipc.setOverlay(false)
    }
  }, [dialog])

  if (!dialog) return null
  switch (dialog.type) {
    case 'add-pod':
      return <AddPodDialog folderId={dialog.folderId} />
    case 'rename-pod':
      return <RenamePod id={dialog.id} />
    case 'edit-pod-url':
      return <EditPodUrl id={dialog.id} />
    case 'folder-settings':
      return <FolderSettingsDialog id={dialog.id} />
  }
}
