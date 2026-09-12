import { ipc } from '@renderer/lib/ipc'
import type {
  AppState,
  CreatePodInput,
  Folder,
  FolderId,
  FolderPatch,
  FolderPlacement,
  MediaCommand,
  MediaInfo,
  Pod,
  PodId,
  PodPatch,
  PodPlacement
} from '@types'
import { create } from 'zustand'

/** Which editing dialog (if any) is currently shown. */
type SidebarDialog =
  | { type: 'add-pod'; folderId?: FolderId | null }
  | { type: 'rename-pod'; id: PodId }
  | { type: 'edit-pod-url'; id: PodId }
  | { type: 'folder-settings'; id: FolderId }
  | { type: 'git-permission'; id: PodId; origin: string }
  | { type: 'exec-permission'; id: PodId; origin: string; command: string }
  | { type: 'scripting-permission'; id: PodId; origin: string; target: string }
  | { type: 'download-permission'; id: PodId; origin: string; url: string }
  | { type: 'music-pod' }

interface PodStore extends AppState {
  /** Narrowed from AppState, where it is optional because a state file written
   *  before it existed has no such key. In the store it is always an array:
   *  `replaceState` fills the gap, so nothing reading it has to. */
  musicUrls: string[]
  /** What the music Pod is playing, pushed by main. Null when it is playing
   *  nothing, or has not been loaded yet - the mini player then shows the Pod
   *  itself and waits to be clicked. */
  media: MediaInfo | null
  /** The dialog on screen: the head of the queue below. */
  dialog: SidebarDialog | null
  /**
   * Dialogs waiting their turn. A permission prompt is a QUESTION a Pod's page
   * is blocked on: showing one dialog at a time used to mean the second one
   * replaced the first, and the page waiting on the replaced one never got an
   * answer at all. They queue instead, and each is answered in turn.
   */
  dialogQueue: SidebarDialog[]
  /** The find bar is showing under the active Pod. */
  findOpen: boolean
  /** Bumped on every Ctrl+F so the bar re-focuses and selects its input, even
   *  when it is already open. */
  findToken: number

  /** Queue a dialog, or close the one on screen with null. */
  setDialog: (dialog: SidebarDialog | null) => void
  toggleFind: () => void
  closeFind: () => void
  load: () => Promise<void>
  setActive: (id: PodId) => Promise<void>
  addPod: (input: CreatePodInput) => Promise<void>
  updatePod: (id: PodId, patch: PodPatch) => void
  /** Merge a single Pod update pushed by main (title/favicon detection). */
  applyPodUpdate: (pod: Pod) => void
  /** Replace the whole state (pushed by main after a native-menu mutation). */
  replaceState: (state: AppState) => void

  /** Give the music-Pod role to an existing Pod, or drop it with null. */
  setMusicPod: (id: PodId | null) => Promise<void>
  /**
   * Point the music Pod at `url`. Switches the Pod that already holds the role
   * rather than making a second one - the slot is a fixture, and keeping it
   * also keeps its partition, so going back to a service you used before finds
   * you still signed in.
   */
  setMusicService: (url: string, name: string) => Promise<void>
  applyMedia: (info: MediaInfo | null) => void
  sendMediaCommand: (command: MediaCommand, value?: number) => void

  /** Discord-style: drop one Pod on another to create a folder holding both. */
  createFolderWithPods: (podIds: PodId[]) => Promise<void>
  updateFolder: (id: FolderId, patch: FolderPatch) => void
  toggleFolder: (id: FolderId) => void

  reorderPods: (placements: PodPlacement[]) => void
  reorderFolders: (placements: FolderPlacement[]) => void
  /** Reorder the root level (root Pods + folders share one order sequence). */
  reorderRoot: (entries: Array<{ kind: 'pod' | 'folder'; id: string }>) => void
}

export const usePodStore = create<PodStore>((set, get) => ({
  pods: [],
  folders: [],
  activePodId: null,
  musicPodId: null,
  musicUrls: [],
  media: null,
  dialogQueue: [],
  loaded: false,
  dialog: null,
  findOpen: false,
  findToken: 0,

  setDialog: (next) => {
    const queue = get().dialogQueue
    if (next === null) {
      // Done with the one on screen; the next question, if any, comes up.
      const rest = queue.slice(1)
      set({ dialogQueue: rest, dialog: rest[0] ?? null })
      return
    }
    const queued = [...queue, next]
    set({ dialogQueue: queued, dialog: queued[0] })
  },

  /** Ctrl+F opens the bar, and closes it when it is already open. */
  toggleFind: () => {
    if (get().findOpen) get().closeFind()
    else set({ findOpen: true, findToken: get().findToken + 1 })
  },

  closeFind: () => {
    set({ findOpen: false })
    void ipc.stopFindInPage()
  },

  load: async () => {
    const state = await ipc.getState()
    set(state)
    if (state.activePodId) await ipc.activatePod(state.activePodId)
  },

  setActive: async (id) => {
    // A search belongs to the page it was run on; main clears the highlighting.
    set({ activePodId: id, findOpen: false })
    await ipc.activatePod(id)
  },

  addPod: async (input) => {
    const pod = await ipc.createPod(input)
    set({ pods: [...get().pods, pod] })
    await get().setActive(pod.id)
  },

  updatePod: (id, patch) => {
    set({ pods: get().pods.map((p) => (p.id === id ? { ...p, ...patch } : p)) })
    void ipc.updatePod(id, patch)
  },

  applyPodUpdate: (pod) => {
    set({ pods: get().pods.map((p) => (p.id === pod.id ? pod : p)) })
  },

  replaceState: (state) =>
    set({
      pods: state.pods,
      folders: state.folders,
      activePodId: state.activePodId,
      musicPodId: state.musicPodId ?? null,
      musicUrls: state.musicUrls ?? []
    }),

  setMusicPod: async (id) => {
    set({ musicPodId: id, media: null })
    await ipc.setMusicPod(id)
  },

  setMusicService: async (url, name) => {
    const current = get().musicPodId
    if (current) {
      // One call, and main owns the whole switch: the url, the name, the icon,
      // the navigation and the activation. Doing it here as a patch plus an
      // activate is what let a switch quietly do nothing, because the patch
      // only navigated when the url differed from the one on record.
      set({ media: null })
      await ipc.setMusicService(url, name || undefined)
      return
    }
    // A Pod already pointing at this service is REUSED rather than duplicated:
    // that Pod holds the login. Without this, emptying the music slot and then
    // picking the same service again built a second Pod with a fresh profile,
    // and the account that was signed in stayed behind on the old one.
    const existing = get().pods.find((p) => p.url === url)
    if (existing) {
      set({ musicPodId: existing.id, media: null })
      await ipc.setMusicPod(existing.id)
      await get().setActive(existing.id)
      return
    }

    const pod = await ipc.createPod({ url, name: name || undefined })
    set({ pods: [...get().pods, pod], musicPodId: pod.id, media: null })
    await ipc.setMusicPod(pod.id)
    await get().setActive(pod.id)
  },

  applyMedia: (info) => set({ media: info }),

  sendMediaCommand: (command, value) => {
    void ipc.sendMediaCommand(command, value)
  },

  createFolderWithPods: async (podIds) => {
    // The first id is the drop TARGET: the new folder takes its place in the
    // root sequence, so merging two Pods keeps the folder where you dropped it.
    const targetId = podIds[0]
    const rootBefore = rootEntriesFrom(get().pods, get().folders)
    const folder = await ipc.createFolder('New Folder')
    set({ folders: [...get().folders, folder] })
    get().reorderPods(podIds.map((id, order) => ({ id, folderId: folder.id, order })))

    const rootAfter: Array<{ kind: 'pod' | 'folder'; id: string }> = []
    for (const entry of rootBefore) {
      if (entry.kind === 'pod' && entry.id === targetId) {
        rootAfter.push({ kind: 'folder', id: folder.id })
      } else if (entry.kind === 'pod' && podIds.includes(entry.id)) {
        // Now lives inside the folder; no longer a root entry.
      } else {
        rootAfter.push(entry)
      }
    }
    get().reorderRoot(rootAfter)
  },

  updateFolder: (id, patch) => {
    set({ folders: get().folders.map((f) => (f.id === id ? { ...f, ...patch } : f)) })
    void ipc.updateFolder(id, patch)
  },

  toggleFolder: (id) => {
    const folder = get().folders.find((f) => f.id === id)
    if (folder) get().updateFolder(id, { collapsed: !folder.collapsed })
  },

  reorderPods: (placements) => {
    const byId = new Map(placements.map((p) => [p.id, p]))
    const pods = get().pods.map((p) => {
      const next = byId.get(p.id)
      return next ? { ...p, folderId: next.folderId, order: next.order } : p
    })
    set({ pods, folders: dropEmptyFolders(pods, get().folders) })
    void ipc.reorderPods(placements)
  },

  reorderFolders: (placements) => {
    const byId = new Map(placements.map((p) => [p.id, p.order]))
    set({
      folders: get().folders.map((f) => {
        const order = byId.get(f.id)
        return order === undefined ? f : { ...f, order }
      })
    })
    void ipc.reorderFolders(placements)
  },

  reorderRoot: (entries) => {
    const podPlacements: PodPlacement[] = []
    const folderPlacements: FolderPlacement[] = []
    entries.forEach((e, order) => {
      if (e.kind === 'pod') podPlacements.push({ id: e.id, folderId: null, order })
      else folderPlacements.push({ id: e.id, order })
    })
    const podById = new Map(podPlacements.map((p) => [p.id, p]))
    const folderById = new Map(folderPlacements.map((f) => [f.id, f.order]))
    const pods = get().pods.map((p) => {
      const next = podById.get(p.id)
      return next ? { ...p, folderId: null, order: next.order } : p
    })
    const folders = get().folders.map((f) => {
      const order = folderById.get(f.id)
      return order === undefined ? f : { ...f, order }
    })
    set({ pods, folders: dropEmptyFolders(pods, folders) })
    void ipc.reorderPods(podPlacements)
    void ipc.reorderFolders(folderPlacements)
  }
}))

/** Discord-style: a folder with no Pods left is removed automatically. */
function dropEmptyFolders(pods: Pod[], folders: Folder[]): Folder[] {
  const used = new Set(pods.map((p) => p.folderId))
  return folders.filter((f) => used.has(f.id))
}

const byOrder = <T extends { order: number }>(a: T, b: T) => a.order - b.order

/** One entry of the root level, where Pods and folders share a single order. */
interface RootEntry {
  kind: 'pod' | 'folder'
  id: string
  key: string
  order: number
}

export const folderKey = (id: FolderId): string => `folder:${id}`

/** The root level (root Pods + folders) merged into one sorted sequence. */
export function rootEntriesFrom(pods: Pod[], folders: Folder[]): RootEntry[] {
  const entries: RootEntry[] = [
    ...pods
      .filter((p) => p.folderId === null)
      .map<RootEntry>((p) => ({ kind: 'pod', id: p.id, key: p.id, order: p.order })),
    ...folders.map<RootEntry>((f) => ({
      kind: 'folder',
      id: f.id,
      key: folderKey(f.id),
      order: f.order
    }))
  ]
  return entries.sort((a, b) => a.order - b.order)
}

/** Root-level Pods (no folder), sorted. */
/**
 * Every Pod EXCEPT the music one, which has its own slot at the foot of the
 * sidebar and must not also appear in the list above. Filtered here, in one
 * place, so the list, the folders and the drag-and-drop sequence all agree.
 */
export const selectVisiblePods = (s: PodStore): Pod[] => s.pods.filter((p) => p.id !== s.musicPodId)

export const selectRootPods = (s: PodStore): Pod[] =>
  s.pods.filter((p) => p.folderId === null && p.id !== s.musicPodId).sort(byOrder)

/** Folders, sorted. */
export const selectFolders = (s: PodStore): Folder[] => s.folders.slice().sort(byOrder)

/** Pods inside a given folder, sorted. */
export const selectFolderPods =
  (folderId: FolderId) =>
  (s: PodStore): Pod[] =>
    s.pods.filter((p) => p.folderId === folderId && p.id !== s.musicPodId).sort(byOrder)
