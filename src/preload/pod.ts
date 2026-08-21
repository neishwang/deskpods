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
 * It also exposes `git()`, the bridge a locally hosted app can use to run git
 * commands. Calling it costs the page nothing by itself: main asks the user to
 * authorise THIS Pod (and pick the folder to work in) the first time, and
 * refuses every call until that answer exists.
 *
 * NOTE: kept self-contained (no `@types` import) on purpose. A sandboxed preload
 * cannot `require` a shared chunk, so sharing code with `preload/index.ts` would
 * make Rollup split out a chunk and break BOTH preloads at runtime. The channel
 * strings must stay in sync with `IpcChannels.podNotification` / `.podGit`.
 */
contextBridge.exposeInMainWorld('__deskpods', {
  // Payload: { title, body?, icon? } captured from the wrapped Notification, so
  // main can render a themed toast instead of the web app's native popup.
  notify: (payload: unknown) => ipcRenderer.send('pods:notification', payload),

  // Run a git command in the folder granted to this Pod. `args` is an array
  // (never a shell string); `options.cwd` is a path relative to that folder.
  // Resolves with { ok, code, stdout, stderr, error? }.
  git: (args: unknown, options?: { cwd?: string }) =>
    ipcRenderer.invoke('pods:git', { args, cwd: options?.cwd }),

  // Drive a site in a hidden page on this Pod's session: open it once, run as
  // many scripts as needed against that same loaded document, then close it.
  // openPage resolves with { ok, id, url, error? }; runScript with
  // { ok, value, error? }, having awaited whatever the script returned.
  openPage: (url: unknown, options?: { waitFor?: string; timeout?: number }) =>
    ipcRenderer.invoke('pods:openPage', { url, options }),
  runScript: (id: unknown, code: unknown) => ipcRenderer.invoke('pods:runScript', { id, code }),
  closePage: (id: unknown) => ipcRenderer.invoke('pods:closePage', { id })
})
