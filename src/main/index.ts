import { dirname, join } from 'node:path'
import { registerIpc } from '@main/ipc'
import { flushState, loadState } from '@main/persistence/store'
import { PodManager } from '@main/pods/PodManager'
import { createMainWindow } from '@main/windows/mainWindow'
import { createOverlayWindow } from '@main/windows/overlayWindow'
import { BrowserWindow, Menu, app } from 'electron'

// Portable mode: keep ALL app data — the state file AND each Pod's Chromium profile
// (cookies, cache, storage) — in a `data/` folder next to the executable, so
// moving the app (e.g. to the M:\ drive) moves everything with it. Must run
// before any path is read; the persistence store reads its path lazily.
if (app.isPackaged) {
  const base = process.env.PORTABLE_EXECUTABLE_DIR ?? dirname(app.getPath('exe'))
  app.setPath('userData', join(base, 'data'))
}

let podManager: PodManager | null = null

function bootstrap(): void {
  const state = loadState()
  const window = createMainWindow()
  const overlay = createOverlayWindow(window)
  podManager = new PodManager(window)
  registerIpc(podManager, window, overlay, state)

  // Activate the last active Pod once the chrome is ready.
  window.webContents.once('did-finish-load', () => {
    if (state.activePodId) podManager?.activate(state.activePodId)
  })
}

app.whenReady().then(() => {
  // No application menu: DeskPods has no browser chrome, and the default menu's
  // accelerators (Ctrl+R, Ctrl+±, F12…) would act on the React chrome instead of
  // the Pod you are looking at. The Pods get the browser keys they need from
  // PodManager, aimed at the right web contents.
  Menu.setApplicationMenu(null)

  // Windows attributes the taskbar button — and thus the unread overlay icon
  // (setOverlayIcon) and OS notifications — to this AppUserModelID. Must match
  // the electron-builder appId so it's stable across launches.
  if (process.platform === 'win32') app.setAppUserModelId('com.deskpods.app')
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
  if (process.platform !== 'darwin') app.quit()
})
