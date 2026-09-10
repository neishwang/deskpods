import { type IpcRendererEvent, contextBridge, ipcRenderer } from 'electron'

/**
 * Preload for the transparent overlay window — the layer that draws tooltips,
 * the zoom pill and notification toasts above the Pods.
 *
 * It gets its OWN bridge rather than the chrome's: the overlay only has to draw
 * what main pushes and say when it is idle. Handing it the full `DeskPodsApi`
 * meant a window whose content is built from text a web app supplies (a
 * notification title) could also create Pods and — worse — answer permission
 * prompts on their behalf. Nothing reaches it today (toasts are set with
 * `textContent`, under a strict CSP), and this is what keeps that a fact rather
 * than a hope.
 *
 * NOTE: self-contained on purpose, like `pod.ts`. A sandboxed preload cannot
 * `require` a shared chunk, so importing `IpcChannels` here — as
 * `preload/index.ts` does — would make Rollup split it out and break BOTH
 * preloads at runtime. The strings must stay in sync with `IpcChannels`.
 */

/** main -> overlay pushes. */
const TOOLTIP = 'ui:tooltip'
const TOAST = 'ui:toast'
const ZOOM = 'ui:zoom'
/** overlay -> main reports. */
const HIT_AREAS = 'ui:overlay:hitAreas'
const IDLE = 'ui:overlay:idle'

/** Subscribe to a main -> overlay channel; returns the unsubscribe function. */
function on<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('deskpods', {
  onTooltip: (listener: (payload: unknown) => void) => on(TOOLTIP, listener),
  onToast: (listener: (toast: unknown) => void) => on(TOAST, listener),
  onZoomIndicator: (listener: (percent: number) => void) => on(ZOOM, listener),
  reportHitAreas: (areas: unknown) => ipcRenderer.send(HIT_AREAS, areas),
  overlayIdle: () => ipcRenderer.send(IDLE)
})
