import { join } from 'node:path'
import { BrowserWindow } from 'electron'

/**
 * A transparent, click-through child window layered exactly over the main
 * window's content area. It hosts UI that must paint ABOVE the Pods' native
 * WebContentsViews (which always cover the renderer chrome) — currently
 * tooltips, later the command palette. Returns null if creation fails so the
 * app keeps working without it.
 */
export function createOverlayWindow(parent: BrowserWindow): BrowserWindow | null {
  try {
    const overlay = new BrowserWindow({
      parent,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    // Fully click-through. We deliberately omit `{ forward: true }`: the overlay
    // never needs to know the cursor position (tooltips are driven by the main
    // renderer's hover), and forwarding move events causes cursor flicker on
    // Windows. Without it, all mouse input passes straight through to the Pods.
    overlay.setIgnoreMouseEvents(true)

    const sync = () => {
      if (!parent.isDestroyed() && !overlay.isDestroyed()) {
        overlay.setBounds(parent.getContentBounds())
      }
    }
    sync()

    // The overlay stays HIDDEN until main shows it to draw a tooltip/toast
    // (and hides it again once the overlay reports idle) — a visible
    // transparent window is blended by the compositor every frame for nothing.
    parent.on('move', sync)
    parent.on('resize', sync)
    parent.on('resized', sync)
    parent.on('minimize', () => overlay.hide())
    parent.on('hide', () => overlay.hide())
    parent.on('restore', sync)
    parent.on('closed', () => {
      if (!overlay.isDestroyed()) overlay.destroy()
    })

    if (process.env.ELECTRON_RENDERER_URL) {
      void overlay.loadURL(`${process.env.ELECTRON_RENDERER_URL}/overlay.html`)
    } else {
      void overlay.loadFile(join(__dirname, '../renderer/overlay.html'))
    }

    return overlay
  } catch {
    return null
  }
}
