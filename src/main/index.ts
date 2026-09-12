import { dirname, join } from 'node:path'
import { registerIpc } from '@main/ipc'
import { flushState, loadState } from '@main/persistence/store'
import { browserUserAgent, PodManager } from '@main/pods/PodManager'
import { createMainWindow } from '@main/windows/mainWindow'
import { createOverlayWindow } from '@main/windows/overlayWindow'
import { app, BrowserWindow, Menu } from 'electron'

// Portable mode: keep ALL app data - the state file AND each Pod's Chromium profile
// (cookies, cache, storage) - in a `data/` folder next to the executable, so
// moving the app (e.g. to the M:\ drive) moves everything with it. Must run
// before any path is read; the persistence store reads its path lazily.
if (app.isPackaged) {
  const base = process.env.PORTABLE_EXECUTABLE_DIR ?? dirname(app.getPath('exe'))
  app.setPath('userData', join(base, 'data'))
}

/**
 * Listener-leak warnings, with the stack that caused them, in development only.
 *
 * Node prints the message but not where it came from, and the message alone
 * sent this in the wrong direction for a while: "11 did-stop-loading
 * listeners" named an event this app registers exactly once. The stack showed
 * the listeners were Electron's own, parked by `executeJavaScript` on a page
 * that had not finished loading - and the caller was the ad blocker injecting
 * cosmetic filters, not this app at all (see PodManager's setMaxListeners).
 *
 * Kept because that took a stack to establish and the message alone will
 * mislead the same way next time.
 */
if (!app.isPackaged) {
  process.on('warning', (warning) => {
    if (warning.name !== 'MaxListenersExceededWarning') return
    console.log('[warn]', warning.message)
    console.log(warning.stack)
  })
}

let podManager: PodManager | null = null
/** The one window, kept so a second launch can raise it instead of opening
 *  another of everything. */
let mainWindow: BrowserWindow | null = null

/**
 * ONE DeskPods at a time.
 *
 * Not a nicety: every Pod's Chromium profile is a directory on disk, and two
 * instances pointed at the same one fight over it. The symptoms are exactly
 * what a second launch produced here - "Unable to move the cache: Access
 * denied", a quota database reset - and the loser silently runs with a broken
 * cache. Portable mode makes it worse, since `data/` next to the exe is shared
 * by definition.
 *
 * Requested AFTER the userData redirection above, because the lock lives in
 * userData: asked before it, a portable copy and an installed one would share
 * one lock and refuse to run side by side.
 *
 * The second launch quits immediately, and the first one raises its window,
 * which is what someone double-clicking the icon again is asking for.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const window = mainWindow
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
}

function bootstrap(): void {
  const state = loadState()
  const window = createMainWindow()
  mainWindow = window

  const overlay = createOverlayWindow(window)
  podManager = new PodManager(window)
  registerIpc(podManager, window, overlay, state)

  // Activate the last active Pod once the chrome is ready.
  window.webContents.once('did-finish-load', () => {
    if (state.activePodId) podManager?.activate(state.activePodId)
  })
}

// Guarded: `app.quit()` for a second instance is not immediate, and whenReady
// can still fire before the process goes away.
app.whenReady().then(() => {
  if (!app.hasSingleInstanceLock()) return

  // No application menu: DeskPods has no browser chrome, and the default menu's
  // accelerators (Ctrl+R, Ctrl+±, F12…) would act on the React chrome instead of
  // the Pod you are looking at. The Pods get the browser keys they need from
  // PodManager, aimed at the right web contents.
  Menu.setApplicationMenu(null)

  // Windows attributes the taskbar button - and thus the unread overlay icon
  // (setOverlayIcon) and OS notifications - to this AppUserModelID. Must match
  // the electron-builder appId so it's stable across launches.
  if (process.platform === 'win32') app.setAppUserModelId('com.deskpods.app')

  // Every web contents is born with this string, so setting it here - before
  // any of them exist - is what makes Pods, their OAuth popups and their
  // background pages all present as plain Chromium. Left as Electron's default,
  // requests announce `DeskPods/… Electron/…`, which web apps that sniff the
  // user agent do not recognise: Spotify answers with its "unsupported browser"
  // page, and Google refuses sign-in from what it reads as an embedded browser.
  app.userAgentFallback = browserUserAgent()
  bootstrap()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) bootstrap()
  })
})

// Persistence is debounced; make sure the trailing write lands before exit.
app.on('before-quit', flushState)

app.on('window-all-closed', () => {
  podManager?.disposeAll()
  podManager = null
  mainWindow = null
  if (process.platform !== 'darwin') app.quit()
})
