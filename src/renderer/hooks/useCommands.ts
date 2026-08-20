import { usePodStore } from '@renderer/features/pods/usePodStore'
import type { UiCommand } from '@types'
import { useCallback } from 'react'

/**
 * Turns a UiCommand raised by one of main's native context menus into the
 * matching dialog, so menu actions and mouse interactions open the exact same
 * UI.
 */
export function useCommands(): (command: UiCommand) => void {
  return useCallback((command: UiCommand) => {
    const store = usePodStore.getState()
    switch (command.type) {
      case 'find-in-page':
        store.toggleFind()
        break
      case 'add-pod-in-folder':
        store.setDialog({ type: 'add-pod', folderId: command.folderId })
        break
      case 'rename-pod':
        store.setDialog({ type: 'rename-pod', id: command.id })
        break
      case 'edit-pod-url':
        store.setDialog({ type: 'edit-pod-url', id: command.id })
        break
      case 'folder-settings':
        store.setDialog({ type: 'folder-settings', id: command.id })
        break
    }
  }, [])
}
