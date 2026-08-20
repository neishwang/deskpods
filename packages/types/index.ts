/**
 * Shared domain + IPC contracts between main, preload and renderer.
 * Kept infrastructure-agnostic (no Electron imports here).
 */

export type PodId = string
export type FolderId = string

export interface PodSettings {
  /** Zoom factor applied to the Pod's contents (1 = 100%). Set with
   *  Ctrl+wheel / Ctrl+`+`-`-` inside the Pod and remembered across restarts. */
  zoom?: number
}

export interface Pod {
  id: PodId
  name: string
  url: string
  /** Detected favicon URL, or an emoji/letter fallback. */
  icon?: string
  /** Partition key -> Chromium partition `persist:<profile>`. */
  profile: string
  /** Visual grouping only; null means root level. */
  folderId: FolderId | null
  order: number
  settings?: PodSettings
  /** Runtime-only: the Pod has an unread notification (red dot). Derived by
   *  main from the page title; never persisted. */
  unread?: boolean
  /** Runtime-only: the Pod's page is currently loading. Never persisted. */
  loading?: boolean
}

/** Purely visual organisation in the sidebar. Never affects isolation. */
export interface Folder {
  id: FolderId
  name: string
  icon?: string
  color?: string
  collapsed: boolean
  order: number
}

/** Persisted application state. */
export interface AppState {
  pods: Pod[]
  folders: Folder[]
  activePodId: PodId | null
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** A tooltip request: text plus the anchor point (right-centre of the icon). */
export interface TooltipPayload {
  text: string
  x: number
  y: number
}

/** Pod page -> main: fields captured from a web app's `window.Notification`. */
export interface PodNotifyPayload {
  title: string
  body?: string
  icon?: string
}

/** main -> overlay: a themed toast drawn above the Pods (replaces the web
 *  app's native/OS notification so it fits DeskPods and never blocks). */
export interface OverlayToast {
  podId: PodId
  podName: string
  title: string
  body?: string
}

/** Progress of an in-page search, pushed by main while the user types. */
export interface FindResult {
  /** Total number of matches on the page. */
  matches: number
  /** 1-based index of the highlighted match, 0 when there is none. */
  activeMatch: number
}

/** Payload to create a Pod; id/order/profile are assigned by main. */
export interface CreatePodInput {
  /** Optional; when empty, main derives it from the URL hostname and later
   *  from the page title once the Pod has loaded. */
  name?: string
  url: string
  icon?: string
  folderId?: FolderId | null
  /** Optional id of an existing Pod whose session (Chromium partition) to
   *  share, so one login (e.g. Google) covers several Pods. Distinct from
   *  `folderId`, which is purely visual and never affects isolation. */
  linkTo?: PodId
}

/** How the next `findInPage` call should move through the matches. */
export interface FindOptions {
  /** Search downwards (default) or upwards. */
  forward?: boolean
  /** True jumps to the next match of the text already being searched; leave it
   *  unset to start a new search. */
  findNext?: boolean
  /** Distinguish "Polski" from "polski". */
  matchCase?: boolean
}

/** Fields of a Pod the user can edit directly. */
export type PodPatch = Partial<Pick<Pod, 'name' | 'url' | 'icon'>>

/** Fields of a Folder the user can edit directly. */
export type FolderPatch = Partial<Pick<Folder, 'name' | 'icon' | 'color' | 'collapsed'>>

/** New placement of a Pod after a drag & drop operation. */
export interface PodPlacement {
  id: PodId
  folderId: FolderId | null
  order: number
}

/** New placement of a Folder after reordering. */
export interface FolderPlacement {
  id: FolderId
  order: number
}

/**
 * Actions raised inside main that the chrome has to carry out: the native
 * context menus (which must paint above the Pods' native views) and the
 * page-level keys pressed while a Pod has focus. Both travel over `uiCommand`.
 */
export type UiCommand =
  | { type: 'add-pod-in-folder'; folderId: FolderId }
  /** Ctrl+F inside a Pod: open the find bar under the active Pod. */
  | { type: 'find-in-page' }
  | { type: 'rename-pod'; id: PodId }
  | { type: 'edit-pod-url'; id: PodId }
  | { type: 'folder-settings'; id: FolderId }

/**
 * The IPC surface exposed to the renderer as `window.deskpods`.
 * Every channel is explicit and typed.
 */
export interface DeskPodsApi {
  getState(): Promise<AppState>
  createPod(input: CreatePodInput): Promise<Pod>
  activatePod(id: PodId): Promise<void>
  /** Report the workspace region so main can position the active WebContentsView. */
  updateBounds(bounds: Rect): Promise<void>
  /** Hide the active Pod's web view while an HTML overlay (dialog) is shown,
   *  since native views always paint above the renderer chrome. */
  setOverlay(active: boolean): Promise<void>

  // Editing & organisation.
  updatePod(id: PodId, patch: PodPatch): Promise<void>
  reorderPods(placements: PodPlacement[]): Promise<void>
  createFolder(name: string): Promise<Folder>
  updateFolder(id: FolderId, patch: FolderPatch): Promise<void>
  reorderFolders(placements: FolderPlacement[]): Promise<void>

  // In-page search of the active Pod (Chromium's own find, so matches are
  // highlighted by the engine itself).
  findInPage(text: string, options?: FindOptions): Promise<void>
  stopFindInPage(): Promise<void>
  /** Subscribe to match counts for the running search. Returns an unsubscribe
   *  function. */
  onFindResult(listener: (result: FindResult) => void): () => void

  // Native context menus (rendered by main to avoid z-order issues with the
  // Pod's native web view).
  showPodMenu(id: PodId): Promise<void>
  showFolderMenu(id: FolderId): Promise<void>

  /** Open a native file picker (PDF/HTML) and return the chosen file as a
   *  `file://` URL, or null if the dialog was cancelled. */
  pickFile(): Promise<string | null>

  // Tooltips are drawn in a transparent overlay window so they can sit above
  // the Pod's native web view.
  showTooltip(payload: TooltipPayload): Promise<void>
  hideTooltip(): Promise<void>
  /** Overlay window only: receive tooltip payloads (null hides). */
  onTooltip(listener: (payload: TooltipPayload | null) => void): () => void
  /** Overlay window only: receive themed toasts to display above the Pods.
   *  Returns an unsubscribe function. */
  onToast(listener: (toast: OverlayToast) => void): () => void
  /** Overlay window only: receive the active Pod's zoom level (in percent) to
   *  flash above the page. Returns an unsubscribe function. */
  onZoomIndicator(listener: (percent: number) => void): () => void
  /** Overlay window only: report that no tooltip/toast is visible any more, so
   *  main can hide the overlay window (a hidden window costs the compositor
   *  nothing; a visible transparent one is blended every frame). */
  overlayIdle(): void

  /** Subscribe to Pod metadata updates pushed by main (title, favicon).
   *  Returns an unsubscribe function. */
  onPodUpdated(listener: (pod: Pod) => void): () => void
  /** Subscribe to actions raised by main's native context menus (the ones that
   *  open a dialog in the chrome). Returns an unsubscribe function. */
  onUiCommand(listener: (command: UiCommand) => void): () => void
  /** Subscribe to full-state replacements pushed by main after a native
   *  context-menu mutation. Returns an unsubscribe function. */
  onStateChanged(listener: (state: AppState) => void): () => void
}

/** IPC channel names, kept in one place to avoid string drift. */
export const IpcChannels = {
  getState: 'app:getState',
  createPod: 'pods:create',
  activatePod: 'pods:activate',
  updateBounds: 'pods:updateBounds',
  setOverlay: 'ui:setOverlay',
  updatePod: 'pods:update',
  findInPage: 'pods:findInPage',
  stopFindInPage: 'pods:stopFindInPage',
  reorderPods: 'pods:reorder',
  createFolder: 'folders:create',
  updateFolder: 'folders:update',
  reorderFolders: 'folders:reorder',
  showPodMenu: 'ui:podMenu',
  showFolderMenu: 'ui:folderMenu',
  /** renderer -> main: open a native file picker, returns a file:// URL. */
  pickFile: 'dialog:pickFile',
  /** Pod page -> main: the web app raised a Notification (via the Pod preload). */
  podNotification: 'pods:notification',
  tooltipShow: 'ui:tooltip:show',
  tooltipHide: 'ui:tooltip:hide',
  /** main -> renderer push. */
  podUpdated: 'pods:updated',
  /** main -> renderer push: match count for the running in-page search. */
  findResult: 'pods:findResult',
  uiCommand: 'ui:command',
  stateChanged: 'app:stateChanged',
  /** overlay window -> main: nothing visible, the overlay can be hidden. */
  overlayIdle: 'ui:overlay:idle',
  /** main -> overlay window push. */
  tooltip: 'ui:tooltip',
  /** main -> overlay window push: a themed notification toast. */
  overlayToast: 'ui:toast',
  /** main -> overlay window push: the zoom level to flash above the Pod. */
  zoomIndicator: 'ui:zoom'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]
