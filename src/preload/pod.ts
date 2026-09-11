import { type IpcRendererEvent, contextBridge, ipcRenderer } from 'electron'

/**
 * Preload injected into every Pod's web content. It exposes a tiny bridge to
 * the page's main world; main then injects (via `executeJavaScript`, which is
 * not subject to the page's CSP) a hook that wraps `window.Notification` and
 * calls this bridge whenever the web app raises a notification. That lets main
 * flag the Pod (and the taskbar) as unread — see PodManager / notifications.
 *
 * Nothing else from Node/Electron is exposed to untrusted Pod content.
 *
 * It also exposes `git()`, `exec()` and the file calls — the bridge a locally
 * hosted app can use to reach the machine. Calling them costs the page nothing
 * by itself: main asks the user to authorise THIS Pod (and pick the folder to
 * work in) the first time, and refuses every call until that answer exists.
 * `exec` is asked separately, on the command it is about to run.
 *
 * NOTE: kept self-contained (no `@types` import) on purpose. A sandboxed preload
 * cannot `require` a shared chunk, so sharing code with `preload/index.ts` would
 * make Rollup split out a chunk and break BOTH preloads at runtime. The channel
 * strings must stay in sync with `IpcChannels.podNotification`, `.podGit`,
 * `.podExec`, `.podExecStart`/`.podExecPoll`/`.podExecKill`, `.podListDir`,
 * `.podReadFile`, `.podWriteFile` and the `.podDownload*` trio.
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

  // Run a command line through the system shell, in the same folder. Needs its
  // own permission (git is one program, a shell is every program) and resolves
  // with the same { ok, code, stdout, stderr, error? } as `git`.
  // `options.stdin` is written to the command's standard input, which is then
  // closed — that is where a secret goes, never on the command line.
  exec: (command: unknown, options?: { cwd?: string; timeout?: number; stdin?: string }) =>
    ipcRenderer.invoke('pods:exec', {
      command,
      cwd: options?.cwd,
      timeout: options?.timeout,
      stdin: options?.stdin
    }),

  // The same command, when it outlives a single answer (an agent session, a
  // long build): start it, follow it, stop it. execStart resolves with
  // { ok, id, error? }; execPoll with { ok, running, stdout, stderr, code?,
  // truncated?, error? }, carrying only what was printed SINCE the last poll.
  execStart: (command: unknown, options?: { cwd?: string; timeout?: number; stdin?: string }) =>
    ipcRenderer.invoke('pods:execStart', {
      command,
      cwd: options?.cwd,
      timeout: options?.timeout,
      stdin: options?.stdin
    }),
  execPoll: (id: unknown) => ipcRenderer.invoke('pods:execPoll', { id }),
  execKill: (id: unknown) => ipcRenderer.invoke('pods:execKill', { id }),

  // Read and write inside the folder granted for git — the same paths, relative
  // to it. listDir resolves with { ok, entries: [{ name, directory }], error? },
  // one level only; readFile with { ok, content, size, encoding, error? }
  // ('utf8' by default, 'base64' for binary); writeFile with { ok, error? }.
  listDir: (path: unknown) => ipcRenderer.invoke('pods:listDir', { path }),
  readFile: (path: unknown, options?: { encoding?: 'utf8' | 'base64' }) =>
    ipcRenderer.invoke('pods:readFile', { path, encoding: options?.encoding }),
  writeFile: (path: unknown, content: unknown, options?: { encoding?: 'utf8' | 'base64' }) =>
    ipcRenderer.invoke('pods:writeFile', { path, content, encoding: options?.encoding }),

  // Drive a site in a hidden page on this Pod's session: open it once, run as
  // many scripts as needed against that same loaded document, then close it.
  // openPage resolves with { ok, id, url, error? }; runScript with
  // { ok, value, error? }, having awaited whatever the script returned.
  openPage: (url: unknown, options?: { waitFor?: string; timeout?: number }) =>
    ipcRenderer.invoke('pods:openPage', { url, options }),
  runScript: (id: unknown, code: unknown) => ipcRenderer.invoke('pods:runScript', { id, code }),
  closePage: (id: unknown) => ipcRenderer.invoke('pods:closePage', { id }),

  // Download a file with THIS Pod's session — the one the page is already
  // logged in with — instead of handing the link to the default browser. The
  // bytes go from Chromium to the disk and never through the page.
  //
  // `start` resolves as soon as the download has begun, with DeskPods' own id:
  // waiting for a 300 MB file would leave the page nothing to draw for minutes.
  // `onProgress` is one channel for the whole Pod — every event carries the id
  // of the download it is about — and returns its own unsubscribe function,
  // because a page that lives for hours must be able to let go of a listener.
  download: {
    start: (url: unknown, options?: { fileName?: string }) =>
      ipcRenderer.invoke('pods:download:start', { url, fileName: options?.fileName }),
    cancel: (id: unknown) => ipcRenderer.invoke('pods:download:cancel', { id }),
    reveal: (path: unknown) => ipcRenderer.invoke('pods:download:reveal', { path }),
    onProgress: (listener: (progress: unknown) => void) => {
      const handler = (_e: IpcRendererEvent, progress: unknown) => listener(progress)
      ipcRenderer.on('pods:download:progress', handler)
      return () => ipcRenderer.removeListener('pods:download:progress', handler)
    }
  }
})
