import { contextBridge, ipcRenderer } from 'electron'

/**
 * Preload injected into every Pod's web content. It exposes a tiny bridge to
 * the page's main world; main then injects (via `executeJavaScript`, which is
 * not subject to the page's CSP) a hook that wraps `window.Notification` and
 * calls this bridge whenever the web app raises a notification. That lets main
 * flag the Pod (and the taskbar) as unread — see PodManager / notifications.
 *
 * Nothing else from Node/Electron is exposed to untrusted Pod content.
 *
 * NOTE: kept self-contained (no `@types` import) on purpose. A sandboxed preload
 * cannot `require` a shared chunk, so sharing code with `preload/index.ts` would
 * make Rollup split out a chunk and break BOTH preloads at runtime. The channel
 * string must stay in sync with `IpcChannels.podNotification`.
 */
contextBridge.exposeInMainWorld('__deskpods', {
  // Payload: { title, body?, icon? } captured from the wrapped Notification, so
  // main can render a themed toast instead of the web app's native popup.
  notify: (payload: unknown) => ipcRenderer.send('pods:notification', payload)
})
