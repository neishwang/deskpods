import { join } from 'node:path'
import {
  type ExecHandleRequest,
  type ExecKillResult,
  type ExecPollResult,
  type ExecRequest,
  type ExecStartResult,
  type FindOptions,
  type FindResult,
  type GitRequest,
  type GitResult,
  IpcChannels,
  type ListDirRequest,
  type ListDirResult,
  type OpenPageOptions,
  type OpenPageResult,
  type Pod,
  type PodId,
  type PodNotifyPayload,
  type ReadFileRequest,
  type ReadFileResult,
  type Rect,
  type ScriptResult,
  type WriteFileRequest,
  type WriteFileResult
} from '@types'
import {
  type BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  WebContentsView,
  clipboard,
  shell
} from 'electron'

/**
 * What a Pod's pages may ask Chromium for.
 *
 * The line is drawn at data: these give a page a better time on screen without
 * telling it anything it did not already know. Notifications are the point —
 * the unread badge is built on them; the clipboard pair is what makes a web
 * app's own copy/paste buttons work; fullscreen and pointer lock are pure UI;
 * storage is where the app already keeps its own data.
 *
 * Everything else is refused, silently as far as the page is concerned:
 * microphone, camera, screen capture, location, MIDI, USB, serial, HID, and
 * idle detection (which tells a site whether you are at your desk). A Pod is a
 * web site; a web site that wants the microphone should be asked for, not
 * assumed. Refusing is also the safe default for whatever Chromium adds next.
 */
const ALLOWED_PERMISSIONS = new Set([
  'notifications',
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
  'pointerLock',
  'persistent-storage',
  'background-sync'
])

/**
 * Injected into each Pod's page (main world) to CAPTURE the notifications a web
 * app raises, instead of letting it show its own (OS/native, out-of-theme) popup.
 * We intercept BOTH notification paths and forward title/body to main, which
 * draws a themed, non-blocking toast above the Pods and lights the taskbar badge:
 *   1. `new Notification(...)` — replaced by an inert stub that also reports
 *      `permission: 'granted'` so apps take this path rather than an in-page modal.
 *   2. `ServiceWorkerRegistration.showNotification(...)` — the path modern Google
 *      apps (Chat, Calendar) and Discord actually use; wrapped to forward and
 *      resolve without showing a native popup.
 * Injected with `executeJavaScript` so it bypasses the page's CSP.
 *
 * Caveat: a notification raised from the service-worker global scope while the
 * page is fully closed (pure Web-Push) is not reachable by this main-world hook.
 * DeskPods keeps a Pod's view alive once opened, so the common case is covered.
 */
const NOTIFICATION_HOOK = `(() => {
  const notify = (title, options) => {
    options = options || {};
    try {
      window.__deskpods && window.__deskpods.notify({
        title: title == null ? '' : String(title),
        body: options.body || '',
        icon: options.icon || ''
      });
    } catch (e) {}
  };

  const N = window.Notification;
  if (N && !N.__deskpods) {
    const noop = function () {};
    function Stub(title, options) {
      options = options || {};
      this.title = title == null ? '' : String(title);
      this.body = options.body || '';
      this.icon = options.icon || '';
      this.tag = options.tag || '';
      this.onclick = null; this.onclose = null; this.onerror = null; this.onshow = null;
      notify(this.title, options);
    }
    Stub.prototype.close = noop;
    Stub.prototype.addEventListener = noop;
    Stub.prototype.removeEventListener = noop;
    Stub.prototype.dispatchEvent = function () { return true; };
    Stub.__deskpods = true;
    Stub.requestPermission = function (cb) {
      if (typeof cb === 'function') cb('granted');
      return Promise.resolve('granted');
    };
    Object.defineProperty(Stub, 'permission', { get: function () { return 'granted'; } });
    Object.defineProperty(Stub, 'maxActions', { get: function () { return 2; } });
    window.Notification = Stub;
  }

  const R = window.ServiceWorkerRegistration;
  if (R && R.prototype && !R.prototype.__deskpods) {
    R.prototype.showNotification = function (title, options) {
      notify(title, options);
      return Promise.resolve();
    };
    R.prototype.__deskpods = true;
  }
})();`

/**
 * Chromium's own zoom ladder. Ctrl+wheel and Ctrl+`+`/`-` walk these steps, so
 * zooming feels exactly like it does in a browser instead of drifting by an
 * arbitrary delta.
 */
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]

/** Index of the ladder step closest to `factor`. */
function nearestZoomStep(factor: number): number {
  let best = 0
  for (let i = 1; i < ZOOM_STEPS.length; i++) {
    if (Math.abs(ZOOM_STEPS[i] - factor) < Math.abs(ZOOM_STEPS[best] - factor)) best = i
  }
  return best
}

/** Metadata a Pod reports about itself once its page loads. */
interface PodMeta {
  title?: string
  favicon?: string
}

/**
 * Owns the WebContentsView for each Pod and keeps only the active one visible.
 * The renderer never touches web content directly; it reports the workspace
 * bounds and asks the manager to activate a Pod.
 *
 * Isolation: each view uses a `persist:<profile>` partition, so cookies,
 * storage, service workers and auth never cross between Pods.
 */
export class PodManager {
  private readonly window: BrowserWindow
  private readonly views = new Map<PodId, WebContentsView>()
  /** Popups a Pod opened with window.open (OAuth and friends), kept so they
   *  never outlive the Pod — nor the app. */
  private readonly popups = new Map<PodId, Set<BrowserWindow>>()
  private readonly podsById = new Map<PodId, Pod>()
  private activeId: PodId | null = null
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 }
  /** When true, the active view is hidden so an HTML overlay (dialog) shows. */
  private overlay = false
  /** Latest in-page search request, so late answers from superseded ones can be
   *  dropped. Request ids are per web contents, hence the Pod they belong to. */
  private findRequest: { podId: PodId | null; id: number } = { podId: null, id: 0 }

  /** Set by the IPC layer to receive title/favicon updates per Pod. */
  onMeta?: (id: PodId, meta: PodMeta) => void
  /** Set by the IPC layer: a Pod's page started/stopped loading. */
  onLoading?: (id: PodId, loading: boolean) => void
  /** Set by the IPC layer: the Pod's web app raised a notification (title/body
   *  captured from the wrapped `window.Notification`). */
  onNotification?: (id: PodId, payload: PodNotifyPayload) => void
  /** Set by the IPC layer: the user zoomed a Pod, so the factor can be saved. */
  onZoom?: (id: PodId, zoom: number) => void
  /** Set by the IPC layer: Ctrl+F was pressed inside a Pod. */
  onFindRequested?: () => void
  /** Set by the IPC layer: match count of the running in-page search. */
  onFindResult?: (id: PodId, result: FindResult) => void
  /** Set by the IPC layer: the Pod's page asked to run a git command. */
  onGitRequest?: (id: PodId, request: GitRequest) => Promise<GitResult>
  /** Set by the IPC layer: the Pod's page asked to run a command line. */
  onExecRequest?: (id: PodId, request: ExecRequest) => Promise<GitResult>
  /** Set by the IPC layer: the Pod's page asked to start, follow or stop a
   *  command that outlives a single answer. */
  onExecStart?: (id: PodId, request: ExecRequest) => Promise<ExecStartResult>
  onExecPoll?: (id: PodId, request: ExecHandleRequest) => Promise<ExecPollResult>
  onExecKill?: (id: PodId, request: ExecHandleRequest) => Promise<ExecKillResult>
  /** Set by the IPC layer: the Pod's page asked to read the granted folder. */
  onListDirRequest?: (id: PodId, request: ListDirRequest) => Promise<ListDirResult>
  onReadFileRequest?: (id: PodId, request: ReadFileRequest) => Promise<ReadFileResult>
  onWriteFileRequest?: (id: PodId, request: WriteFileRequest) => Promise<WriteFileResult>
  /** Set by the IPC layer: the Pod's page wants to drive a background page. */
  onOpenPage?: (id: PodId, url: string, options?: OpenPageOptions) => Promise<OpenPageResult>
  onRunScript?: (id: PodId, handle: string, code: string) => Promise<ScriptResult>
  onClosePage?: (id: PodId, handle: string) => void

  constructor(window: BrowserWindow) {
    this.window = window
  }

  /** Id of the currently active Pod (null if none). */
  get activePodId(): PodId | null {
    return this.activeId
  }

  /** URL currently loaded by a Pod, used to tell the user who is asking for
   *  something. Empty when the Pod has no live view. */
  urlOf(id: PodId): string {
    const wc = this.views.get(id)?.webContents
    return wc && !wc.isDestroyed() ? wc.getURL() : ''
  }

  /** Whether a live view exists for this Pod (i.e. it consumes resources). */
  hasView(id: PodId): boolean {
    return this.views.has(id)
  }

  /** Register the known Pods (metadata only; views are created lazily). */
  setPods(pods: Pod[]): void {
    this.podsById.clear()
    for (const pod of pods) {
      this.podsById.set(pod.id, pod)
    }
  }

  /** Lazily create the WebContentsView for a Pod on first activation. */
  private ensureView(pod: Pod): WebContentsView {
    const existing = this.views.get(pod.id)
    if (existing) return existing

    const view = new WebContentsView({
      webPreferences: {
        partition: `persist:${pod.profile}`,
        preload: join(__dirname, '../preload/pod.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Only the active Pod is visible, so every other one is "backgrounded":
        // Chromium slows its timers and tells the page it is hidden, which is
        // exactly how a chat app decides to go away and drop its connection.
        // Keep Awake opts a Pod out of that, at the window's expense (see
        // setAwake). Off by default: a Pod that nobody watches should cost
        // nothing.
        backgroundThrottling: pod.settings?.awake !== true
      }
    })
    this.window.contentView.addChildView(view)
    view.setVisible(false)

    const wc = view.webContents

    // Grant only the permissions a web app needs to behave like it does in
    // Chromium (see ALLOWED_PERMISSIONS). The handlers are per SESSION, so
    // Pods sharing a partition share them — which is right: they share a login
    // too.
    wc.session.setPermissionRequestHandler((_wc, permission, callback) =>
      callback(ALLOWED_PERMISSIONS.has(permission))
    )
    wc.session.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))

    // Report page title / favicon so the sidebar can auto-fill name and icon.
    wc.on('page-title-updated', (_e, title) => this.onMeta?.(pod.id, { title }))
    wc.on('page-favicon-updated', (_e, favicons) => {
      if (favicons.length > 0) this.onMeta?.(pod.id, { favicon: favicons[0] })
    })

    // Loading indicator for the sidebar.
    wc.on('did-start-loading', () => this.onLoading?.(pod.id, true))
    wc.on('did-stop-loading', () => this.onLoading?.(pod.id, false))

    // Hook the Notification API on every load, and forward each notification
    // (bridged by the Pod preload) as an unread signal for this Pod.
    wc.on('dom-ready', () => {
      wc.executeJavaScript(NOTIFICATION_HOOK).catch(() => {
        // Injection can fail on non-HTML responses; safe to ignore.
      })
    })
    wc.ipc.on(IpcChannels.podNotification, (_e, payload: PodNotifyPayload) =>
      this.onNotification?.(pod.id, payload ?? { title: '' })
    )

    // Git bridge. Registered on THIS Pod's web contents, so a request always
    // carries the Pod it came from and can never be attributed to another.
    wc.ipc.handle(IpcChannels.podGit, (_e, request: GitRequest): Promise<GitResult> => {
      const handler = this.onGitRequest
      if (!handler) {
        return Promise.resolve({
          ok: false,
          code: -1,
          stdout: '',
          stderr: '',
          error: 'Git bridge unavailable.'
        })
      }
      return handler(pod.id, request ?? { args: [] })
    })

    // Command lines, and the folder/file reads that ride with the git grant.
    // Same per-Pod scoping: the request always carries the Pod it came from.
    wc.ipc.handle(IpcChannels.podExec, (_e, request: ExecRequest): Promise<GitResult> => {
      const handler = this.onExecRequest
      if (!handler) {
        return Promise.resolve({
          ok: false,
          code: -1,
          stdout: '',
          stderr: '',
          error: 'Command bridge unavailable.'
        })
      }
      return handler(pod.id, request ?? { command: '' })
    })

    wc.ipc.handle(
      IpcChannels.podExecStart,
      (_e, request: ExecRequest): Promise<ExecStartResult> => {
        const handler = this.onExecStart
        if (!handler) return Promise.resolve({ ok: false, error: 'Command bridge unavailable.' })
        return handler(pod.id, request ?? { command: '' })
      }
    )

    wc.ipc.handle(
      IpcChannels.podExecPoll,
      (_e, request: ExecHandleRequest): Promise<ExecPollResult> => {
        const handler = this.onExecPoll
        if (!handler) {
          return Promise.resolve({
            ok: false,
            running: false,
            stdout: '',
            stderr: '',
            error: 'Command bridge unavailable.'
          })
        }
        return handler(pod.id, request ?? { id: '' })
      }
    )

    wc.ipc.handle(
      IpcChannels.podExecKill,
      (_e, request: ExecHandleRequest): Promise<ExecKillResult> => {
        const handler = this.onExecKill
        if (!handler) return Promise.resolve({ ok: false, error: 'Command bridge unavailable.' })
        return handler(pod.id, request ?? { id: '' })
      }
    )

    wc.ipc.handle(IpcChannels.podListDir, (_e, request: ListDirRequest): Promise<ListDirResult> => {
      const handler = this.onListDirRequest
      if (!handler)
        return Promise.resolve({ ok: false, entries: [], error: 'File bridge unavailable.' })
      return handler(pod.id, request ?? {})
    })

    wc.ipc.handle(
      IpcChannels.podReadFile,
      (_e, request: ReadFileRequest): Promise<ReadFileResult> => {
        const handler = this.onReadFileRequest
        if (!handler) return Promise.resolve({ ok: false, error: 'File bridge unavailable.' })
        return handler(pod.id, request ?? { path: '' })
      }
    )

    wc.ipc.handle(
      IpcChannels.podWriteFile,
      (_e, request: WriteFileRequest): Promise<WriteFileResult> => {
        const handler = this.onWriteFileRequest
        if (!handler) return Promise.resolve({ ok: false, error: 'File bridge unavailable.' })
        return handler(pod.id, request ?? { path: '', content: '' })
      }
    )

    // Background pages: same per-Pod scoping as the git bridge.
    wc.ipc.handle(
      IpcChannels.podOpenPage,
      (_e, payload: { url?: unknown; options?: OpenPageOptions }): Promise<OpenPageResult> => {
        if (!this.onOpenPage || typeof payload?.url !== 'string') {
          return Promise.resolve({ ok: false, error: 'openPage expects a URL string.' })
        }
        return this.onOpenPage(pod.id, payload.url, payload.options)
      }
    )

    wc.ipc.handle(
      IpcChannels.podRunScript,
      (_e, payload: { id?: unknown; code?: unknown }): Promise<ScriptResult> => {
        if (
          !this.onRunScript ||
          typeof payload?.id !== 'string' ||
          typeof payload?.code !== 'string'
        ) {
          return Promise.resolve({ ok: false, error: 'runScript expects a page id and code.' })
        }
        return this.onRunScript(pod.id, payload.id, payload.code)
      }
    )

    wc.ipc.handle(IpcChannels.podClosePage, (_e, payload: { id?: unknown }): void => {
      if (typeof payload?.id === 'string') this.onClosePage?.(pod.id, payload.id)
    })

    // Restore the saved zoom on every load: Chromium resets the factor when the
    // page navigates to another origin (a login redirect, for instance).
    wc.on('did-finish-load', () => {
      const zoom = this.podsById.get(pod.id)?.settings?.zoom
      if (zoom && zoom !== 1) wc.setZoomFactor(zoom)
    })

    // Ctrl+wheel (and pinch): Chromium reports the intent but leaves the zoom
    // to us, which is what lets each Pod keep its own factor.
    wc.on('zoom-changed', (_e, direction) => {
      this.stepZoom(pod.id, direction === 'in' ? 1 : -1)
    })

    // Match counts for the find bar; the highlighting itself is Chromium's.
    wc.on('found-in-page', (_e, result) => {
      // Answers are async: a superseded request can land after a newer one and
      // would report the stale (often zero) count.
      if (this.findRequest.podId === pod.id && result.requestId < this.findRequest.id) return
      this.onFindResult?.(pod.id, {
        matches: result.matches,
        activeMatch: result.activeMatchOrdinal
      })
    })

    // The browser keys a user expects INSIDE a page. They never leave the Pod
    // (except Ctrl+F, which needs the chrome to draw the find bar), so this is
    // page behaviour rather than an app-wide shortcut bus.
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const key = input.key.toLowerCase()
      const ctrl = input.control || input.meta

      // Reload — F5 / Ctrl+R, and their cache-busting variants.
      if ((key === 'f5' && !input.shift) || (ctrl && key === 'r' && !input.shift)) {
        event.preventDefault()
        wc.reload()
        return
      }
      if ((key === 'f5' && input.shift) || (ctrl && key === 'r' && input.shift)) {
        event.preventDefault()
        wc.reloadIgnoringCache()
        return
      }

      // History — Alt+Left / Alt+Right.
      if (input.alt && (key === 'arrowleft' || key === 'arrowright')) {
        event.preventDefault()
        if (key === 'arrowleft') {
          if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
        } else if (wc.navigationHistory.canGoForward()) {
          wc.navigationHistory.goForward()
        }
        return
      }

      if (!ctrl) return

      // Zoom — Ctrl+`+` / Ctrl+`-` / Ctrl+0.
      if (key === '=' || key === '+') {
        event.preventDefault()
        this.stepZoom(pod.id, 1)
      } else if (key === '-' || key === '_') {
        event.preventDefault()
        this.stepZoom(pod.id, -1)
      } else if (key === '0') {
        event.preventDefault()
        this.stepZoom(pod.id, 0)
      } else if (key === 'f') {
        // We intercept before the page sees it, so DeskPods' find bar always
        // wins over a web app's own Ctrl+F.
        event.preventDefault()
        this.onFindRequested?.()
      }
    })

    // Native context menu so users can copy/paste inside web apps.
    wc.on('context-menu', (_e, params) => this.showContextMenu(wc, params))

    // Link clicks / new tabs open in the OS browser; only window.open popups
    // (e.g. OAuth) stay in-app, sharing this Pod's session.
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (disposition === 'new-window') return { action: 'allow' }
      void shell.openExternal(url)
      return { action: 'deny' }
    })

    // A popup is a real BrowserWindow: left untracked, an OAuth window nobody
    // closed would keep the app alive after the main window is gone (a hidden
    // window still counts for `window-all-closed`) and would outlive the Pod
    // that opened it.
    wc.on('did-create-window', (child) => this.trackPopup(pod.id, child))

    void wc.loadURL(pod.url)
    this.views.set(pod.id, view)
    return view
  }

  /**
   * Keep a popup with the Pod that opened it, and answer the bridge inside it.
   *
   * Chromium copies the opener's webPreferences, so the Pod preload is loaded
   * there and `window.__deskpods` exists — but the handlers live on the Pod's
   * OWN web contents, and an invoke nobody handles REJECTS. Every caller in
   * this project is written to read a result, never to catch, so a popup
   * answers with a refusal rather than throwing.
   */
  private trackPopup(podId: PodId, child: BrowserWindow): void {
    const forPod = this.popups.get(podId) ?? new Set<BrowserWindow>()
    forPod.add(child)
    this.popups.set(podId, forPod)
    child.on('closed', () => forPod.delete(child))

    const why = 'The DeskPods bridge belongs to the Pod itself, not to a popup it opened.'
    const wc = child.webContents
    const failed = { ok: false, code: -1, stdout: '', stderr: '', error: why }
    wc.ipc.handle(IpcChannels.podGit, () => Promise.resolve(failed))
    wc.ipc.handle(IpcChannels.podExec, () => Promise.resolve(failed))
    wc.ipc.handle(IpcChannels.podExecStart, () => Promise.resolve({ ok: false, error: why }))
    wc.ipc.handle(IpcChannels.podExecPoll, () =>
      Promise.resolve({ ok: false, running: false, stdout: '', stderr: '', error: why })
    )
    wc.ipc.handle(IpcChannels.podExecKill, () => Promise.resolve({ ok: false, error: why }))
    wc.ipc.handle(IpcChannels.podListDir, () =>
      Promise.resolve({ ok: false, entries: [], error: why })
    )
    wc.ipc.handle(IpcChannels.podReadFile, () => Promise.resolve({ ok: false, error: why }))
    wc.ipc.handle(IpcChannels.podWriteFile, () => Promise.resolve({ ok: false, error: why }))
    wc.ipc.handle(IpcChannels.podOpenPage, () => Promise.resolve({ ok: false, error: why }))
    wc.ipc.handle(IpcChannels.podRunScript, () => Promise.resolve({ ok: false, error: why }))
    wc.ipc.handle(IpcChannels.podClosePage, () => Promise.resolve({ ok: false, error: why }))
  }

  /** Close every popup a Pod opened (it was suspended, deleted, or we quit). */
  private closePopups(podId: PodId): void {
    const forPod = this.popups.get(podId)
    if (!forPod) return
    this.popups.delete(podId)
    for (const child of forPod) {
      if (!child.isDestroyed()) child.destroy()
    }
  }

  /**
   * The Pod's right-click menu. Electron never exposes Chromium's own menu, but
   * Chrome builds its menu from exactly the `params` we get here — so this is
   * the same menu, minus the browser-only entries a Pod has no use for.
   */
  private showContextMenu(wc: Electron.WebContents, params: Electron.ContextMenuParams): void {
    const template: MenuItemConstructorOptions[] = []
    const group = (...items: MenuItemConstructorOptions[]) => {
      if (items.length === 0) return
      if (template.length > 0) template.push({ type: 'separator' })
      template.push(...items)
    }

    // Spelling suggestions come first, as they do in Chrome.
    if (params.misspelledWord) {
      group(
        ...(params.dictionarySuggestions.length > 0
          ? params.dictionarySuggestions.slice(0, 5).map<MenuItemConstructorOptions>((word) => ({
              label: word,
              click: () => wc.replaceMisspelling(word)
            }))
          : [{ label: 'No spelling suggestions', enabled: false }])
      )
    }

    if (params.isEditable || params.selectionText) {
      const editing: MenuItemConstructorOptions[] = []
      if (params.isEditable) {
        editing.push(
          { role: 'undo', enabled: params.editFlags.canUndo },
          { role: 'redo', enabled: params.editFlags.canRedo },
          { type: 'separator' }
        )
      }
      editing.push(
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll' }
      )
      group(...editing)
    }

    if (params.selectionText.trim()) {
      const selection = params.selectionText.trim()
      const shown = selection.length > 40 ? `${selection.slice(0, 40)}…` : selection
      group({
        label: `Search the web for "${shown}"`,
        click: () => {
          void shell.openExternal(
            `https://www.google.com/search?q=${encodeURIComponent(selection)}`
          )
        }
      })
    }

    // Note for later: a copy made here lands in the Windows clipboard history
    // (Win+V). Excluding it needs the `ExcludeClipboardContentFromMonitorProcessing`
    // / `CanIncludeInClipboardHistory` formats written ATOMICALLY with the text,
    // which Electron 33's clipboard API cannot do (writeBuffer replaces the
    // content). And it would only ever cover the copies DeskPods makes itself —
    // a Ctrl+C inside a page is Chromium's own write, out of reach from here.
    if (params.linkURL) {
      group(
        { label: 'Open Link in Browser', click: () => void shell.openExternal(params.linkURL) },
        { label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) }
      )
    }

    if (params.mediaType === 'image' && params.srcURL) {
      group(
        { label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) },
        { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) },
        // Electron's default download handler opens a Save dialog for this.
        { label: 'Save Image As…', click: () => wc.downloadURL(params.srcURL) },
        { label: 'Open Image in Browser', click: () => void shell.openExternal(params.srcURL) }
      )
    }

    // Navigation always sits at the bottom, so its position never moves.
    group(
      {
        label: 'Back',
        enabled: wc.navigationHistory.canGoBack(),
        click: () => wc.navigationHistory.goBack()
      },
      {
        label: 'Forward',
        enabled: wc.navigationHistory.canGoForward(),
        click: () => wc.navigationHistory.goForward()
      },
      { label: 'Reload', click: () => wc.reload() }
    )

    Menu.buildFromTemplate(template).popup()
  }

  /** Move a Pod one notch along the zoom ladder (`direction` 0 resets to 100%)
   *  and report the new factor so it can be persisted. */
  private stepZoom(id: PodId, direction: 1 | 0 | -1): void {
    const wc = this.views.get(id)?.webContents
    if (!wc || wc.isDestroyed()) return

    let factor = 1
    if (direction !== 0) {
      const index = nearestZoomStep(wc.getZoomFactor()) + direction
      factor = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, index))]
    }
    if (factor === wc.getZoomFactor()) return

    wc.setZoomFactor(factor)
    this.onZoom?.(id, factor)
  }

  /**
   * Run Chromium's in-page search on the active Pod.
   *
   * `findNext` is handed straight to Chromium's `new_session` flag WITHOUT being
   * inverted, so passing it as `false` — the value Electron documents as "first
   * request" — actually means "carry on the previous session" and the call
   * silently does nothing with the new text. A fresh search must omit the key
   * altogether; only stepping between matches sets it.
   */
  find(text: string, options?: FindOptions): void {
    const podId = this.activeId
    const wc = podId ? this.views.get(podId)?.webContents : undefined
    if (!podId || !wc || wc.isDestroyed()) return
    if (!text) {
      this.stopFind()
      return
    }

    const findOptions: Electron.FindInPageOptions = { forward: options?.forward ?? true }
    if (options?.findNext) findOptions.findNext = true
    if (options?.matchCase) findOptions.matchCase = true

    if (this.findRequest.podId !== podId) this.findRequest = { podId, id: 0 }
    this.findRequest.id = wc.findInPage(text, findOptions)
  }

  /** Drop the search highlighting on the active Pod. */
  stopFind(): void {
    const wc = this.activeId ? this.views.get(this.activeId)?.webContents : undefined
    this.findRequest = { podId: null, id: 0 }
    if (wc && !wc.isDestroyed()) wc.stopFindInPage('clearSelection')
  }

  /** Back to 100%. No-op when the Pod has no live view; the persisted factor is
   *  cleared by the IPC layer either way. */
  resetZoom(id: PodId): void {
    this.stepZoom(id, 0)
  }

  /** History navigation for the mouse's back/forward buttons. */
  navigate(direction: 'back' | 'forward'): void {
    const wc = this.activeId ? this.views.get(this.activeId)?.webContents : undefined
    if (!wc || wc.isDestroyed()) return
    const history = wc.navigationHistory
    if (direction === 'back') {
      if (history.canGoBack()) history.goBack()
    } else if (history.canGoForward()) {
      history.goForward()
    }
  }

  activate(id: PodId): void {
    const pod = this.podsById.get(id)
    if (!pod) return

    if (this.activeId && this.activeId !== id) {
      this.views.get(this.activeId)?.setVisible(false)
    }

    const view = this.ensureView(pod)
    view.setBounds(this.bounds)
    this.activeId = id
    this.syncActiveVisibility()
  }

  /** The active view should render only when it's actually on screen: not
   *  covered by an HTML overlay (dialog) and with a real workspace region
   *  (zero bounds = nothing to paint into). Hiding it lets Chromium throttle
   *  the page instead of painting into a 0×0 target at full speed. */
  private syncActiveVisibility(): void {
    if (!this.activeId) return
    const visible = !this.overlay && this.bounds.width > 0 && this.bounds.height > 0
    this.views.get(this.activeId)?.setVisible(visible)
  }

  /** Called whenever the renderer's workspace region moves or resizes. */
  updateBounds(bounds: Rect): void {
    this.bounds = bounds
    if (this.activeId) {
      this.views.get(this.activeId)?.setBounds(bounds)
      this.syncActiveVisibility()
    }
  }

  /** Reload a Pod's view at a new URL (after the user edits it). No-op if the
   *  view has not been created yet — it will load the new URL on first open. */
  loadUrl(id: PodId, url: string): void {
    const view = this.views.get(id)
    if (view && !view.webContents.isDestroyed()) void view.webContents.loadURL(url)
  }

  /** Hide/show the active Pod view so an HTML overlay can appear above it. */
  setOverlay(active: boolean): void {
    this.overlay = active
    this.syncActiveVisibility()
  }

  /**
   * Load a Pod without showing it (Keep Awake). Its view is created exactly as
   * a click would create it — invisible until `activate` — so the app inside is
   * connected, and can raise notifications, before it has ever been opened.
   * No-op once the view exists.
   */
  wake(id: PodId): void {
    const pod = this.podsById.get(id)
    if (!pod) return
    const view = this.ensureView(pod)
    // Lay it out at the workspace size even though it stays invisible: a page
    // given a 0×0 viewport can decide it has nothing to render, and a chat app
    // that renders nothing is halfway to being asleep again.
    if (this.activeId !== id) view.setBounds(this.bounds)
  }

  /**
   * Turn Keep Awake on or off on a Pod that is already live, so the answer
   * takes effect without reloading the page.
   *
   * Caveat worth knowing: since Electron 28, a single WebContents with
   * throttling disabled stops frame throttling for the WHOLE window, other Pods
   * included. One awake Pod therefore costs the window, not just itself.
   */
  setAwake(id: PodId, awake: boolean): void {
    const wc = this.views.get(id)?.webContents
    if (wc && !wc.isDestroyed()) wc.setBackgroundThrottling(!awake)
  }

  /** Free the renderer/GPU cost of a Pod while keeping its session on disk. */
  suspend(id: PodId): void {
    this.closePopups(id)
    const view = this.views.get(id)
    if (!view) return
    this.views.delete(id)
    if (this.activeId === id) this.activeId = null

    // On app quit the window and its webContents may already be torn down,
    // so every access is guarded to avoid "Object has been destroyed".
    if (!this.window.isDestroyed()) {
      try {
        this.window.contentView.removeChildView(view)
      } catch {
        // View already detached; nothing to do.
      }
    }
    try {
      if (!view.webContents.isDestroyed()) {
        view.webContents.close()
      }
    } catch {
      // WebContents already destroyed during teardown.
    }
  }

  destroy(id: PodId): void {
    this.suspend(id)
    this.podsById.delete(id)
  }

  disposeAll(): void {
    for (const id of [...this.views.keys()]) {
      this.suspend(id)
    }
    // A Pod with no live view may still have left a popup behind.
    for (const id of [...this.popups.keys()]) {
      this.closePopups(id)
    }
  }
}
