import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cleanTitle, setTaskbarBadge, titleUnreadCount } from '@main/notifications'
import { saveState } from '@main/persistence/store'
import type { PodManager } from '@main/pods/PodManager'
import {
  type AppState,
  type CreatePodInput,
  type FindOptions,
  type Folder,
  type FolderId,
  type FolderPatch,
  type FolderPlacement,
  IpcChannels,
  type OverlayToast,
  type Pod,
  type PodId,
  type PodPatch,
  type PodPlacement,
  type Rect,
  type TooltipPayload,
  type UiCommand
} from '@types'
import {
  type BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  dialog,
  ipcMain
} from 'electron'

/** Preset folder colours offered in the native context menu. */
const FOLDER_COLORS = [
  '#6d6dff',
  '#ef4444',
  '#f59e0b',
  '#10b981',
  '#3b82f6',
  '#a855f7',
  '#ec4899',
  '#64748b'
]

/**
 * Initial Pod name derived from the URL: the main domain label between the
 * protocol and the TLD (e.g. https://mail.google.com -> "Google"). Replaced by
 * the real page title once the Pod loads.
 */
function defaultNameFromUrl(url: string): string {
  try {
    if (/^file:\/\//i.test(url)) {
      const name = basename(fileURLToPath(url))
      return name || url
    }
    const host = new URL(url).hostname.replace(/^www\./i, '')
    const parts = host.split('.')
    const core = parts.length >= 2 ? parts[parts.length - 2] : parts[0]
    return core ? core.charAt(0).toUpperCase() + core.slice(1) : host
  } catch {
    return url
  }
}

/**
 * Registers every IPC handler. Holds the authoritative AppState in the main
 * process; the renderer is a view over it.
 */
export function registerIpc(
  pods: PodManager,
  window: BrowserWindow,
  overlay: BrowserWindow | null,
  state: AppState
): AppState {
  pods.setPods(state.pods)

  // Pods whose name was auto-derived and may still be replaced by the first
  // page title. Cleared once the title is applied so the sidebar name stops
  // following later title changes (e.g. unread counters).
  const autoNamed = new Set<PodId>()

  const persist = () => {
    saveState(state)
    pods.setPods(state.pods)
  }
  const send = (channel: string, payload: unknown) => {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }

  // --- unread notifications (runtime only; never persisted) ---
  // Unread is DERIVED from each Pod's latest title: the count in "(2) Discord"
  // is the source of truth, so the badge persists even while that Pod is active
  // and clears only once the web app itself drops the count (i.e. once you've
  // actually read it). A Notification raised by an app that doesn't put a count
  // in its title contributes 1 until you view that Pod (its only "read" signal).
  //
  // Everything is EVENT-driven — `page-title-updated` (via onMeta), captured
  // notifications, Pod activation and window focus. No polling: an idle
  // DeskPods schedules zero wakeups in main.
  const lastTitle = new Map<PodId, string>()
  const notified = new Set<PodId>()
  const unreadCount = new Map<PodId, number>()
  const loading = new Set<PodId>()

  // Merge the runtime flags (unread, loading) onto a Pod before it goes to the
  // renderer, which shows them as sidebar indicators.
  const withRuntime = (pod: Pod): Pod => ({
    ...pod,
    unread: (unreadCount.get(pod.id) ?? 0) > 0,
    loading: loading.has(pod.id)
  })
  const stateForRenderer = (): AppState => ({ ...state, pods: state.pods.map(withRuntime) })
  const pushPod = (pod: Pod) => send(IpcChannels.podUpdated, withRuntime(pod))

  /** Re-derive every Pod's unread count in one pass; push the ones that changed
   *  and update the taskbar badge: a NUMBER when titles carry real counts, a
   *  plain dot when unread comes only from caught notifications. */
  const refreshUnread = (forceBadge = false) => {
    let dirty = false
    let titleTotal = 0
    let anyUnread = false
    for (const pod of state.pods) {
      const fromTitle = titleUnreadCount(lastTitle.get(pod.id) ?? '')
      titleTotal += fromTitle
      const want = fromTitle > 0 ? fromTitle : notified.has(pod.id) ? 1 : 0
      if (want > 0) anyUnread = true
      if (want !== (unreadCount.get(pod.id) ?? 0)) {
        if (want > 0) unreadCount.set(pod.id, want)
        else unreadCount.delete(pod.id)
        pushPod(pod)
        dirty = true
      }
    }
    if (dirty || forceBadge) {
      setTaskbarBadge(window, titleTotal, anyUnread && titleTotal === 0)
    }
  }

  // Focusing the window "reads" the Pod on screen: clear its notification
  // signal (a notification that arrived for the active Pod while DeskPods was
  // in the background stops flagging unread once you come back to it).
  window.on('focus', () => {
    const active = pods.activePodId
    if (active && notified.delete(active)) refreshUnread()
  })

  /** Persist and push the full state to the renderer (for main-driven edits). */
  const pushState = () => {
    persist()
    send(IpcChannels.stateChanged, stateForRenderer())
  }

  // --- internal mutations shared by IPC handlers and native menus ---

  const removePod = (id: PodId) => {
    state.pods = state.pods.filter((p) => p.id !== id)
    if (state.activePodId === id) state.activePodId = state.pods[0]?.id ?? null
    pods.destroy(id)
    lastTitle.delete(id)
    notified.delete(id)
    unreadCount.delete(id)
    loading.delete(id)
    // Force the badge: the removed Pod no longer appears in the loop, so its
    // vanished count would otherwise leave a stale number on the taskbar.
    refreshUnread(true)
  }

  const movePodToFolder = (id: PodId, folderId: FolderId | null) => {
    const pod = state.pods.find((p) => p.id === id)
    if (!pod) return
    const siblings = state.pods.filter((p) => p.folderId === folderId && p.id !== id)
    pod.folderId = folderId
    pod.order = siblings.length
  }

  const applyFolderPatch = (id: FolderId, patch: FolderPatch) => {
    const folder = state.folders.find((f) => f.id === id)
    if (folder) Object.assign(folder, patch)
  }

  const deleteFolder = (id: FolderId) => {
    for (const pod of state.pods) {
      if (pod.folderId === id) pod.folderId = null
    }
    state.folders = state.folders.filter((f) => f.id !== id)
  }

  // Discord-style: drop any folder left without Pods. Returns whether the set
  // of folders changed, so callers can decide to push state to the renderer.
  const cleanupEmptyFolders = (): boolean => {
    const used = new Set(state.pods.map((p) => p.folderId))
    const before = state.folders.length
    state.folders = state.folders.filter((f) => used.has(f.id))
    return state.folders.length !== before
  }

  // Ctrl+F inside a Pod: ask the chrome to slide its find bar in.
  pods.onFindRequested = () => send(IpcChannels.uiCommand, { type: 'find-in-page' })

  // Match count of the running in-page search, for the find bar's counter.
  pods.onFindResult = (id, result) => {
    if (id === pods.activePodId) send(IpcChannels.findResult, result)
  }

  // The user zoomed a Pod (Ctrl+wheel or Ctrl+±): remember the factor so the
  // Pod reopens at the size they chose.
  pods.onZoom = (id, zoom) => {
    const pod = state.pods.find((p) => p.id === id)
    if (!pod) return
    if (zoom === 1) {
      pod.settings = undefined
    } else {
      pod.settings = { ...pod.settings, zoom }
    }
    persist()
  }

  // Mouse back/forward buttons drive the active Pod's history, like a browser.
  window.on('app-command', (_e, command) => {
    if (command === 'browser-backward') pods.navigate('back')
    else if (command === 'browser-forward') pods.navigate('forward')
  })

  // Loading indicator for the sidebar (runtime-only, like unread).
  pods.onLoading = (id, isLoading) => {
    if (isLoading === loading.has(id)) return
    if (isLoading) loading.add(id)
    else loading.delete(id)
    const pod = state.pods.find((p) => p.id === id)
    if (pod) pushPod(pod)
  }

  // The overlay window is shown only while it has content to draw; a hidden
  // window costs the compositor nothing, a visible transparent one is blended
  // every frame. It reports back (overlayIdle) once everything faded out.
  const showOverlay = () => {
    if (overlay && !overlay.isDestroyed() && !overlay.isVisible()) overlay.showInactive()
  }
  ipcMain.on(IpcChannels.overlayIdle, () => {
    if (overlay && !overlay.isDestroyed()) overlay.hide()
  })

  // A Pod's web app raised a notification → flag unread AND draw a themed toast
  // above the Pods (replacing the app's own out-of-theme/blocking popup). The
  // toast shows regardless of which Pod is active. If the window isn't focused,
  // flash the taskbar so a reminder isn't missed while DeskPods is in the back.
  pods.onNotification = (id, payload) => {
    // A notification for the Pod you are currently looking at is already read;
    // otherwise it flags unread until that Pod is viewed (or the window
    // refocused, for the active Pod).
    const onScreen = id === pods.activePodId && !window.isDestroyed() && window.isFocused()
    if (!onScreen) {
      notified.add(id)
      refreshUnread()
    }
    const pod = state.pods.find((p) => p.id === id)
    if (pod && overlay && !overlay.isDestroyed()) {
      const toast: OverlayToast = {
        podId: id,
        podName: pod.name,
        title: payload?.title ?? '',
        body: payload?.body
      }
      showOverlay()
      overlay.webContents.send(IpcChannels.overlayToast, toast)
    }
    if (!window.isDestroyed() && !window.isFocused()) window.flashFrame(true)
  }

  // Receive title/favicon updates from the Pod views and reflect them.
  pods.onMeta = (id, meta) => {
    const pod = state.pods.find((p) => p.id === id)
    if (!pod) return
    let changed = false

    if (meta.title && autoNamed.has(id)) {
      const name = cleanTitle(meta.title)
      if (name) {
        pod.name = name
        autoNamed.delete(id)
        changed = true
      }
    }
    if (meta.favicon && pod.icon !== meta.favicon) {
      pod.icon = meta.favicon
      changed = true
    }

    // Remember the latest title so unread can be re-derived on any change
    // (a count in the title, e.g. "(2) Discord", means unread once backgrounded).
    if (typeof meta.title === 'string') lastTitle.set(id, meta.title)

    if (changed) {
      saveState(state)
      pushPod(pod)
    }
    refreshUnread()
  }

  // --- renderer-driven handlers ---

  ipcMain.handle(IpcChannels.getState, (): AppState => stateForRenderer())

  // Root Pods and folders share ONE visual order sequence; a new root entry
  // must therefore go after the max across BOTH, not after its own kind's
  // count, or the two independent counters collide and it lands mid-list.
  const nextRootOrder = (): number =>
    Math.max(
      -1,
      ...state.pods.filter((p) => p.folderId === null).map((p) => p.order),
      ...state.folders.map((f) => f.order)
    ) + 1

  ipcMain.handle(IpcChannels.createPod, (_e, input: CreatePodInput): Pod => {
    const id = randomUUID()
    const providedName = (input.name ?? '').trim()
    const folderId = input.folderId ?? null
    // A linked Pod reuses the referenced Pod's partition so one login (e.g.
    // Google) is shared; otherwise it gets its own isolated profile.
    const linkedProfile = input.linkTo
      ? state.pods.find((p) => p.id === input.linkTo)?.profile
      : undefined
    const pod: Pod = {
      id,
      name: providedName || defaultNameFromUrl(input.url),
      url: input.url,
      icon: input.icon,
      profile: linkedProfile ?? id,
      folderId,
      order:
        folderId === null
          ? nextRootOrder()
          : Math.max(-1, ...state.pods.filter((p) => p.folderId === folderId).map((p) => p.order)) +
            1
    }
    if (!providedName) autoNamed.add(id)
    state.pods.push(pod)
    persist()
    return pod
  })

  ipcMain.handle(IpcChannels.activatePod, (_e, id: PodId): void => {
    // Leave no search highlighted behind on the Pod we are stepping away from.
    pods.stopFind()
    state.activePodId = id
    pods.activate(id)
    // Viewing a Pod clears a title-less Notification signal (its only "read"
    // cue). A count carried in the title is NOT cleared here — it clears only
    // when the web app itself drops it, so the badge survives switching Pods.
    notified.delete(id)
    refreshUnread()
    saveState(state)
  })

  ipcMain.handle(IpcChannels.updateBounds, (_e, bounds: Rect): void => {
    pods.updateBounds(bounds)
  })

  ipcMain.handle(IpcChannels.setOverlay, (_e, active: boolean): void => {
    pods.setOverlay(active)
  })

  ipcMain.handle(IpcChannels.findInPage, (_e, text: string, options?: FindOptions): void => {
    pods.find(text, options)
  })

  ipcMain.handle(IpcChannels.stopFindInPage, (): void => {
    pods.stopFind()
  })

  ipcMain.handle(IpcChannels.updatePod, (_e, id: PodId, patch: PodPatch): void => {
    const pod = state.pods.find((p) => p.id === id)
    if (!pod) return
    if (patch.name !== undefined) {
      pod.name = patch.name
      autoNamed.delete(id) // explicit name; stop auto-titling.
    }
    if (patch.icon !== undefined) pod.icon = patch.icon
    if (patch.url !== undefined && patch.url !== pod.url) {
      pod.url = patch.url
      pods.loadUrl(id, patch.url)
    }
    persist()
  })

  ipcMain.handle(IpcChannels.reorderPods, (_e, placements: PodPlacement[]): void => {
    for (const { id, folderId, order } of placements) {
      const pod = state.pods.find((p) => p.id === id)
      if (pod) {
        pod.folderId = folderId
        pod.order = order
      }
    }
    // If the move emptied a folder, push the pruned state so the renderer drops
    // it too; otherwise the optimistic renderer update already matches.
    if (cleanupEmptyFolders()) pushState()
    else persist()
  })

  ipcMain.handle(IpcChannels.createFolder, (_e, name: string): Folder => {
    const folder: Folder = {
      id: randomUUID(),
      name: name.trim() || 'New Folder',
      color: FOLDER_COLORS[0],
      collapsed: false,
      order: nextRootOrder()
    }
    state.folders.push(folder)
    persist()
    return folder
  })

  ipcMain.handle(IpcChannels.updateFolder, (_e, id: FolderId, patch: FolderPatch): void => {
    applyFolderPatch(id, patch)
    persist()
  })

  ipcMain.handle(IpcChannels.reorderFolders, (_e, placements: FolderPlacement[]): void => {
    for (const { id, order } of placements) {
      const folder = state.folders.find((f) => f.id === id)
      if (folder) folder.order = order
    }
    persist()
  })

  // --- native context menus (main-driven; push full state on mutation) ---

  ipcMain.handle(IpcChannels.showPodMenu, (_e, id: PodId): void => {
    const pod = state.pods.find((p) => p.id === id)
    if (!pod) return

    const moveTargets: MenuItemConstructorOptions[] = [
      {
        label: 'No folder',
        type: 'checkbox',
        checked: pod.folderId === null,
        enabled: pod.folderId !== null,
        click: () => {
          movePodToFolder(id, null)
          cleanupEmptyFolders()
          pushState()
        }
      },
      ...state.folders
        .slice()
        .sort((a, b) => a.order - b.order)
        .map<MenuItemConstructorOptions>((folder) => ({
          label: folder.name,
          type: 'checkbox',
          checked: pod.folderId === folder.id,
          click: () => {
            movePodToFolder(id, folder.id)
            cleanupEmptyFolders()
            pushState()
          }
        }))
    ]

    const template: MenuItemConstructorOptions[] = [
      { label: 'Rename', click: () => send(IpcChannels.uiCommand, { type: 'rename-pod', id }) },
      { label: 'Edit URL', click: () => send(IpcChannels.uiCommand, { type: 'edit-pod-url', id }) },
      { type: 'separator' },
      { label: 'Move to', submenu: moveTargets },
      { type: 'separator' },
      {
        // Free the Pod's renderer/GPU cost now; its session stays on disk and
        // the next click reloads it. Only meaningful when a live view exists.
        label: 'Suspend',
        enabled: pods.hasView(id),
        click: () => pods.suspend(id)
      },
      {
        label: 'Delete',
        click: () => {
          removePod(id)
          pushState()
        }
      }
    ]
    Menu.buildFromTemplate(template).popup({ window })
  })

  // Tooltips: forward to the transparent overlay window that sits above Pods.
  const sendTooltip = (payload: TooltipPayload | null) => {
    if (!overlay || overlay.isDestroyed()) return
    if (payload) showOverlay()
    overlay.webContents.send(IpcChannels.tooltip, payload)
  }
  ipcMain.handle(IpcChannels.tooltipShow, (_e, payload: TooltipPayload): void =>
    sendTooltip(payload)
  )
  ipcMain.handle(IpcChannels.tooltipHide, (): void => sendTooltip(null))

  ipcMain.handle(IpcChannels.pickFile, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      filters: [
        { name: 'Documents', extensions: ['pdf', 'html', 'htm'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    const filePath = result.filePaths[0]
    return filePath ? pathToFileURL(filePath).href : null
  })

  ipcMain.handle(IpcChannels.showFolderMenu, (_e, id: FolderId): void => {
    const folder = state.folders.find((f) => f.id === id)
    if (!folder) return

    const command = (c: UiCommand) => () => send(IpcChannels.uiCommand, c)

    const template: MenuItemConstructorOptions[] = [
      { label: 'Folder Settings', click: command({ type: 'folder-settings', id }) },
      { label: 'New Pod here', click: command({ type: 'add-pod-in-folder', folderId: id }) },
      { type: 'separator' },
      {
        label: 'Delete Folder',
        click: () => {
          deleteFolder(id)
          pushState()
        }
      }
    ]
    Menu.buildFromTemplate(template).popup({ window })
  })

  return state
}
