import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'

/**
 * Creates the single application window that hosts the React chrome.
 * Pod web content is layered on top by the PodManager as WebContentsViews.
 * The background colour matches the chrome palette so there is no flash of the
 * wrong shade before the renderer paints.
 */
export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f172a',
    // In packaged builds the icon is embedded in the executable; in dev, point
    // the window at the generated PNG (out/main -> ../../build/icon.png).
    ...(app.isPackaged ? {} : { icon: join(__dirname, '../../build/icon.png') }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.once('ready-to-show', () => window.show())

  // Open external links in the OS browser, never in the app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}
