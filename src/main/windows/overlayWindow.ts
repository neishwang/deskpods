import { join } from 'node:path'
import { isInsideAreas } from '@main/windows/hitTest'
import type { Rect } from '@types'
import { BrowserWindow, screen } from 'electron'

/**
 * A transparent, click-through child window layered exactly over the main
 * window's content area. It hosts UI that must paint ABOVE the Pods' native
 * WebContentsViews (which always cover the renderer chrome) - currently
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
        // Its own narrow bridge: the overlay draws what main pushes and says
        // when it is idle. It has no business creating Pods or answering
        // permission prompts, and its content comes from web apps' titles.
        preload: join(__dirname, '../preload/overlay.js'),
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
    // (and hides it again once the overlay reports idle) - a visible
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

/**
 * Makes parts of the click-through overlay clickable - today the toasts, which
 * are dismissed by clicking them.
 *
 * The overlay reports the regions that must receive clicks, and the cursor is
 * sampled while any exists: mouse events are handed to the window only while
 * the pointer sits inside one, so everything else still passes straight to the
 * Pod underneath. Sampling rather than `setIgnoreMouseEvents(true, { forward:
 * true })` on purpose - forwarding move events is what made the cursor flicker
 * on Windows. The timer only runs while a region is reported, and never while
 * idle - but "a few seconds per notification" no longer describes all of it:
 * the music Pod's history square is reported for as long as that Pod is the one
 * on screen, so browsing a music service samples the cursor for as long as you
 * are looking at it. Withdrawn the moment another Pod is shown.
 *
 * Returns the setter to call with the reported regions.
 */
export function createHitAreaTracker(overlay: BrowserWindow): (areas: Rect[]) => void {
  const SAMPLE_MS = 50
  let timer: NodeJS.Timeout | null = null
  let areas: Rect[] = []
  let clickable = false

  const setClickable = (next: boolean) => {
    if (next === clickable || overlay.isDestroyed()) return
    clickable = next
    overlay.setIgnoreMouseEvents(!next)
  }

  const stop = () => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    setClickable(false)
  }

  const sample = () => {
    if (overlay.isDestroyed()) {
      stop()
      return
    }
    const cursor = screen.getCursorScreenPoint()
    const bounds = overlay.getContentBounds()
    const x = cursor.x - bounds.x
    const y = cursor.y - bounds.y
    setClickable(isInsideAreas(areas, x, y))
  }

  return (next: Rect[]) => {
    areas = Array.isArray(next) ? next : []
    if (areas.length === 0) {
      stop()
      return
    }
    if (!timer) timer = setInterval(sample, SAMPLE_MS)
    sample()
  }
}
