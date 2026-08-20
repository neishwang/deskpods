import {
  type AppState,
  type CreatePodInput,
  type DeskPodsApi,
  type FindOptions,
  type FindResult,
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
import { type IpcRendererEvent, contextBridge, ipcRenderer } from 'electron'

/**
 * The only bridge between renderer and main. Exposes a typed, minimal API;
 * the renderer never gets raw ipcRenderer or Node access.
 */
const api: DeskPodsApi = {
  getState: () => ipcRenderer.invoke(IpcChannels.getState),
  createPod: (input: CreatePodInput) => ipcRenderer.invoke(IpcChannels.createPod, input),
  activatePod: (id: PodId) => ipcRenderer.invoke(IpcChannels.activatePod, id),
  updateBounds: (bounds: Rect) => ipcRenderer.invoke(IpcChannels.updateBounds, bounds),
  setOverlay: (active: boolean) => ipcRenderer.invoke(IpcChannels.setOverlay, active),
  updatePod: (id: PodId, patch: PodPatch) => ipcRenderer.invoke(IpcChannels.updatePod, id, patch),
  findInPage: (text: string, options?: FindOptions) =>
    ipcRenderer.invoke(IpcChannels.findInPage, text, options),
  stopFindInPage: () => ipcRenderer.invoke(IpcChannels.stopFindInPage),
  onFindResult: (listener: (result: FindResult) => void) => {
    const handler = (_e: IpcRendererEvent, result: FindResult) => listener(result)
    ipcRenderer.on(IpcChannels.findResult, handler)
    return () => ipcRenderer.removeListener(IpcChannels.findResult, handler)
  },
  reorderPods: (placements: PodPlacement[]) =>
    ipcRenderer.invoke(IpcChannels.reorderPods, placements),
  createFolder: (name: string) => ipcRenderer.invoke(IpcChannels.createFolder, name),
  updateFolder: (id: FolderId, patch: FolderPatch) =>
    ipcRenderer.invoke(IpcChannels.updateFolder, id, patch),
  reorderFolders: (placements: FolderPlacement[]) =>
    ipcRenderer.invoke(IpcChannels.reorderFolders, placements),
  showPodMenu: (id: PodId) => ipcRenderer.invoke(IpcChannels.showPodMenu, id),
  showFolderMenu: (id: FolderId) => ipcRenderer.invoke(IpcChannels.showFolderMenu, id),
  pickFile: () => ipcRenderer.invoke(IpcChannels.pickFile),
  pickFolder: () => ipcRenderer.invoke(IpcChannels.pickFolder),
  resolveGitPermission: (id: PodId, allowed: boolean, root: string | null) =>
    ipcRenderer.invoke(IpcChannels.gitPermission, id, allowed, root),
  showTooltip: (payload: TooltipPayload) => ipcRenderer.invoke(IpcChannels.tooltipShow, payload),
  hideTooltip: () => ipcRenderer.invoke(IpcChannels.tooltipHide),
  onTooltip: (listener: (payload: TooltipPayload | null) => void) => {
    const handler = (_e: IpcRendererEvent, payload: TooltipPayload | null) => listener(payload)
    ipcRenderer.on(IpcChannels.tooltip, handler)
    return () => ipcRenderer.removeListener(IpcChannels.tooltip, handler)
  },
  overlayIdle: () => ipcRenderer.send(IpcChannels.overlayIdle),
  reportHitAreas: (areas: Rect[]) => ipcRenderer.send(IpcChannels.overlayHitAreas, areas),
  onToast: (listener: (toast: OverlayToast) => void) => {
    const handler = (_e: IpcRendererEvent, toast: OverlayToast) => listener(toast)
    ipcRenderer.on(IpcChannels.overlayToast, handler)
    return () => ipcRenderer.removeListener(IpcChannels.overlayToast, handler)
  },
  onZoomIndicator: (listener: (percent: number) => void) => {
    const handler = (_e: IpcRendererEvent, percent: number) => listener(percent)
    ipcRenderer.on(IpcChannels.zoomIndicator, handler)
    return () => ipcRenderer.removeListener(IpcChannels.zoomIndicator, handler)
  },
  onPodUpdated: (listener: (pod: Pod) => void) => {
    const handler = (_e: IpcRendererEvent, pod: Pod) => listener(pod)
    ipcRenderer.on(IpcChannels.podUpdated, handler)
    return () => ipcRenderer.removeListener(IpcChannels.podUpdated, handler)
  },
  onUiCommand: (listener: (command: UiCommand) => void) => {
    const handler = (_e: IpcRendererEvent, command: UiCommand) => listener(command)
    ipcRenderer.on(IpcChannels.uiCommand, handler)
    return () => ipcRenderer.removeListener(IpcChannels.uiCommand, handler)
  },
  onStateChanged: (listener: (state: AppState) => void) => {
    const handler = (_e: IpcRendererEvent, state: AppState) => listener(state)
    ipcRenderer.on(IpcChannels.stateChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.stateChanged, handler)
  }
}

contextBridge.exposeInMainWorld('deskpods', api)
