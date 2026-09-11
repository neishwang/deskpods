/**
 * Notification surfacing for the OS taskbar/dock.
 *
 * What we add here is a single aggregate unread indicator on the app's taskbar
 * icon — the only unread affordance DeskPods draws itself (the sidebar shows no
 * per-Pod dot). It has two forms:
 *   - a NUMBER, the total unread count derived from the Pods' page titles (e.g.
 *     "(3) Discord"), which persists while a Pod is active and clears only once
 *     the web app itself drops the count (i.e. once you've actually read it);
 *   - a plain red DOT when unread comes from a caught notification (Google Chat,
 *     Calendar, …) that carries no count in its title.
 */
import { app, type BrowserWindow, type NativeImage, nativeImage } from 'electron'

/**
 * Heuristic unread detection from a page title. Most web apps prefix the tab
 * title with a count (e.g. "(3) Discord", "[2] Slack") or a bullet ("• …") when
 * there are unread items. Anchored to the start to limit false positives; the
 * first capture group is the number when present.
 */
const UNREAD_PREFIX = /^\s*(?:[([{]\s*(\d+)\s*[)\]}]|([•●◉]))\s*/

/** Unread count parsed from a title: the number in "(3) …", 1 for a bullet
 *  marker, or 0 when no unread marker is present. */
export function titleUnreadCount(title: string): number {
  const m = UNREAD_PREFIX.exec(title)
  if (!m) return 0
  return m[1] ? Number(m[1]) : 1
}

/** Strip a leading unread marker so it never leaks into the auto-derived Pod
 *  name (e.g. "(3) Discord" → "Discord"). */
export function cleanTitle(title: string): string {
  return title.replace(UNREAD_PREFIX, '').trim() || title.trim()
}

// --- Windows numbered overlay icon ---------------------------------------
// setOverlayIcon takes a bitmap; Windows has no built-in numeric badge, so we
// draw one. A 3×5 pixel font keeps this dependency-free and crisp when Windows
// downscales the 32×32 icon onto the taskbar button.

const GLYPHS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000']
}

const SIZE = 32
const SCALE = 3
const GLYPH_W = 3 * SCALE
const GLYPH_H = 5 * SCALE
const GAP = SCALE
// #ef4444 (red-500). Only fully opaque or fully transparent pixels are used, so
// premultiplied BGRA needs no blending.
const BADGE = { r: 239, g: 68, b: 68 }

const iconCache = new Map<string, NativeImage>()

/** A 32×32 BGRA buffer with a filled red disc, plus a pixel setter for glyphs. */
function newDiscBuffer(): {
  buf: Buffer
  set: (x: number, y: number, r: number, g: number, b: number) => void
} {
  const buf = Buffer.alloc(SIZE * SIZE * 4) // BGRA
  const set = (x: number, y: number, r: number, g: number, b: number) => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
    const p = (y * SIZE + x) * 4
    buf[p] = b
    buf[p + 1] = g
    buf[p + 2] = r
    buf[p + 3] = 255
  }

  const c = (SIZE - 1) / 2
  const r2 = (SIZE / 2) ** 2
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - c
      const dy = y - c
      if (dx * dx + dy * dy <= r2) set(x, y, BADGE.r, BADGE.g, BADGE.b)
    }
  }

  return { buf, set }
}

/** A plain red dot (no glyph): the badge for a notification with no title count. */
function makeDotIcon(): NativeImage {
  const cached = iconCache.get('•')
  if (cached) return cached
  const { buf } = newDiscBuffer()
  const image = nativeImage.createFromBitmap(buf, { width: SIZE, height: SIZE })
  iconCache.set('•', image)
  return image
}

function makeBadgeIcon(count: number): NativeImage {
  const text = count > 9 ? '9+' : String(count)
  const cached = iconCache.get(text)
  if (cached) return cached

  const { buf, set } = newDiscBuffer()

  // White text, centred.
  const textW = text.length * GLYPH_W + (text.length - 1) * GAP
  let ox = Math.round((SIZE - textW) / 2)
  const oy = Math.round((SIZE - GLYPH_H) / 2)
  for (const ch of text) {
    const rows = GLYPHS[ch]
    if (rows) {
      for (let gy = 0; gy < 5; gy++) {
        for (let gx = 0; gx < 3; gx++) {
          if (rows[gy][gx] !== '1') continue
          for (let sy = 0; sy < SCALE; sy++) {
            for (let sx = 0; sx < SCALE; sx++) {
              set(ox + gx * SCALE + sx, oy + gy * SCALE + sy, 255, 255, 255)
            }
          }
        }
      }
    }
    ox += GLYPH_W + GAP
  }

  const image = nativeImage.createFromBitmap(buf, { width: SIZE, height: SIZE })
  iconCache.set(text, image)
  return image
}

/**
 * Reflect unread state across all Pods on the OS taskbar icon. A positive
 * `count` draws the number; otherwise `dot` draws a plain red dot (unread from a
 * caught notification with no title count); neither clears the indicator.
 * Windows draws an overlay on the taskbar button; macOS/Linux use the native
 * dock/launcher badge count.
 */
export function setTaskbarBadge(window: BrowserWindow, count: number, dot: boolean): void {
  if (window.isDestroyed()) return
  if (process.platform === 'win32') {
    const overlay = count > 0 ? makeBadgeIcon(count) : dot ? makeDotIcon() : null
    const description = count > 0 ? `${count} unread notifications` : dot ? 'New notifications' : ''
    window.setOverlayIcon(overlay, description)
  } else {
    app.setBadgeCount(count > 0 ? count : dot ? 1 : 0)
  }
}
