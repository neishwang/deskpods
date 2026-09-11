import { ipc } from '@renderer/lib/ipc'
import type { PodId } from '@types'
import { useEffect } from 'react'
import { AddPodDialog } from './AddPodDialog'
import { DownloadPermissionDialog } from './DownloadPermissionDialog'
import { ExecPermissionDialog } from './ExecPermissionDialog'
import { FolderSettingsDialog } from './FolderSettingsDialog'
import { GitPermissionDialog } from './GitPermissionDialog'
import { PromptDialog } from './PromptDialog'
import { ScriptingPermissionDialog } from './ScriptingPermissionDialog'
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

  // Two dialogs of the same kind can follow each other out of the queue (two
  // Pods asking for git, say). Without a key React would REUSE the component,
  // and a permission dialog that has already answered once refuses to answer
  // again — the second page would wait forever. The key forces a fresh one.
  const key = `${dialog.type}:${'id' in dialog ? dialog.id : (dialog.folderId ?? 'root')}`

  switch (dialog.type) {
    case 'add-pod':
      return <AddPodDialog key={key} folderId={dialog.folderId} />
    case 'rename-pod':
      return <RenamePod key={key} id={dialog.id} />
    case 'edit-pod-url':
      return <EditPodUrl key={key} id={dialog.id} />
    case 'folder-settings':
      return <FolderSettingsDialog key={key} id={dialog.id} />
    case 'git-permission':
      return <GitPermissionDialog key={key} id={dialog.id} origin={dialog.origin} />
    case 'exec-permission':
      return (
        <ExecPermissionDialog
          key={key}
          id={dialog.id}
          origin={dialog.origin}
          command={dialog.command}
        />
      )
    case 'scripting-permission':
      return (
        <ScriptingPermissionDialog
          key={key}
          id={dialog.id}
          origin={dialog.origin}
          target={dialog.target}
        />
      )
    case 'download-permission':
      return (
        <DownloadPermissionDialog
          key={key}
          id={dialog.id}
          origin={dialog.origin}
          url={dialog.url}
        />
      )
  }
}
