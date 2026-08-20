import { ipc } from '@renderer/lib/ipc'
import type {
  AppState,
  CreatePodInput,
  Folder,
  FolderId,
  FolderPatch,
  FolderPlacement,
  Pod,
  PodId,
  PodPatch,
  PodPlacement
} from '@types'
import { create } from 'zustand'

/** Which editing dialog (if any) is currently shown. */
export type SidebarDialog =
  | { type: 'add-pod'; folderId?: FolderId | null }
  | { type: 'rename-pod'; id: PodId }
  | { type: 'edit-pod-url'; id: PodId }
  | { type: 'folder-settings'; id: FolderId }

interface PodStore extends AppState {
  loaded: boolean
  dialog: SidebarDialog | null

  setDialog: (dialog: SidebarDialog | null) => void
  load: () => Promise<void>
  setActive: (id: PodId) => Promise<void>
  addPod: (input: CreatePodInput) => Promise<void>
  updatePod: (id: PodId, patch: PodPatch) => void
  /** Merge a single Pod update pushed by main (title/favicon detection). */
  applyPodUpdate: (pod: Pod) => void
  /** Replace the whole state (pushed by main after a native-menu mutation). */
  replaceState: (state: AppState) => void

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
  loaded: false,
  dialog: null,

  setDialog: (dialog) => set({ dialog }),

  load: async () => {
    const state = await ipc.getState()
    set({ ...state, loaded: true })
    if (state.activePodId) await ipc.activatePod(state.activePodId)
  },

  setActive: async (id) => {
    set({ activePodId: id })
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
      activePodId: state.activePodId
    }),

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
export interface RootEntry {
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
export const selectRootPods = (s: PodStore): Pod[] =>
  s.pods.filter((p) => p.folderId === null).sort(byOrder)

/** Folders, sorted. */
export const selectFolders = (s: PodStore): Folder[] => s.folders.slice().sort(byOrder)

/** Pods inside a given folder, sorted. */
export const selectFolderPods =
  (folderId: FolderId) =>
  (s: PodStore): Pod[] =>
    s.pods.filter((p) => p.folderId === folderId).sort(byOrder)
