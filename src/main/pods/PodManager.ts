import { join } from 'node:path'
import { IpcChannels, type Pod, type PodId, type PodNotifyPayload, type Rect } from '@types'
import {
  type BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  WebContentsView,
  clipboard,
  shell
} from 'electron'

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

/** Metadata a Pod reports about itself once its page loads. */
export interface PodMeta {
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
  private readonly podsById = new Map<PodId, Pod>()
  private activeId: PodId | null = null
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 }
  /** When true, the active view is hidden so an HTML overlay (dialog) shows. */
  private overlay = false

  /** Set by the IPC layer to receive title/favicon updates per Pod. */
  onMeta?: (id: PodId, meta: PodMeta) => void
  /** Set by the IPC layer: a Pod's page started/stopped loading. */
  onLoading?: (id: PodId, loading: boolean) => void
  /** Set by the IPC layer: the Pod's web app raised a notification (title/body
   *  captured from the wrapped `window.Notification`). */
  onNotification?: (id: PodId, payload: PodNotifyPayload) => void

  constructor(window: BrowserWindow) {
    this.window = window
  }

  /** Id of the currently active Pod (null if none). */
  get activePodId(): PodId | null {
    return this.activeId
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
        sandbox: true
      }
    })
    this.window.contentView.addChildView(view)
    view.setVisible(false)

    const wc = view.webContents

    // Grant the permissions a web app needs to behave like it does in Chromium
    // (notably notifications, so we can surface unread badges).
    wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(true))
    wc.session.setPermissionCheckHandler(() => true)

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

    // Native context menu so users can copy/paste inside web apps.
    wc.on('context-menu', (_e, params) => this.showContextMenu(wc, params))

    // Link clicks / new tabs open in the OS browser; only window.open popups
    // (e.g. OAuth) stay in-app, sharing this Pod's session.
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (disposition === 'new-window') return { action: 'allow' }
      void shell.openExternal(url)
      return { action: 'deny' }
    })

    void wc.loadURL(pod.url)
    this.views.set(pod.id, view)
    return view
  }

  private showContextMenu(wc: Electron.WebContents, params: Electron.ContextMenuParams): void {
    const template: MenuItemConstructorOptions[] = []

    if (params.isEditable || params.selectionText) {
      template.push(
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll' }
      )
    }

    if (params.linkURL) {
      if (template.length > 0) template.push({ type: 'separator' })
      template.push({ label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) })
    }

    if (template.length > 0) template.push({ type: 'separator' })
    template.push(
      {
        label: 'Back',
        enabled: wc.navigationHistory.canGoBack(),
        click: () => wc.navigationHistory.goBack()
      },
      { label: 'Reload', click: () => wc.reload() }
    )

    Menu.buildFromTemplate(template).popup()
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

  /** Free the renderer/GPU cost of a Pod while keeping its session on disk. */
  suspend(id: PodId): void {
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
  }
}
