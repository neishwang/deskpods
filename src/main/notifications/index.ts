/**
 * Notification surfacing for the OS taskbar/dock.
 *
 * What we add here is a single aggregate unread indicator on the app's taskbar
 * icon - the only unread affordance DeskPods draws itself (the sidebar shows no
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
//
// Windows gives a taskbar button exactly ONE overlay slot, so the unread badge
// and the "this app is playing" speaker cannot both be shown: unread wins, and
// the speaker fills the slot only when there is nothing unread to report.

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
// #f59e0b (amber-500). Complementary to blue on purpose: the DeskPods icon is
// itself blue, so an accent-blue overlay disappeared into it. Not red either -
// playing music is a state, not an alert.
const PLAYING = { r: 245, g: 158, b: 11 }

/** Silenced. #f87171, matching `#media-drawer button.on` and the mini player's
 *  VolumeIcon: one state, one colour, wherever it is shown. */
const MUTED = { r: 248, g: 113, b: 113 }

/** Smaller than the numbered badge - see newDiscBuffer. */
const PLAYING_RADIUS = 12.5

/** A speaker, as a 7×7 bitmap; scaled up and centred like the digits above.
 *  Kept smaller than the disc on purpose - a glyph pressed against the edge
 *  reads as a smudge once Windows has shrunk this onto the taskbar button. */
const SPEAKER = ['...1...', '..11...', '1111.1.', '1111.1.', '1111.1.', '..11...', '...1...']

/**
 * The same cone with its sound waves taken away.
 *
 * No cross, which is the usual way to draw this: the glyph is 7x7 and Windows
 * draws the overlay at about 14px, where an X beside the cone is a smudge. What
 * does read at that size is the colour and the missing waves, so those carry it
 * - and the colour is the red the mini player and the drawer already use for
 * silenced, which is the point of showing it here at all.
 */
const SPEAKER_MUTED = ['...1...', '..11...', '1111...', '1111...', '1111...', '..11...', '...1...']

const iconCache = new Map<string, NativeImage>()

/**
 * A 32×32 BGRA buffer with a filled disc, plus a pixel setter for glyphs.
 *
 * `radius` defaults to filling the bitmap. The speaker asks for a smaller one:
 * a glyph needs less room than two digits do, and at the size Windows actually
 * draws this, a full-bleed disc reads as a blob stuck to the icon. The digits
 * keep the whole 32px - "9+" already spans 21 of them.
 */
function newDiscBuffer(
  colour: { r: number; g: number; b: number } = BADGE,
  radius: number = SIZE / 2
): {
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
  const r2 = radius ** 2
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - c
      const dy = y - c
      if (dx * dx + dy * dy <= r2) set(x, y, colour.r, colour.g, colour.b)
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

/**
 * A speaker on a disc: this app is the one making the sound, or would be if it
 * were not silenced. Both states are drawn the same way and differ only in the
 * glyph and the colour of the disc.
 */
function makeSpeakerIcon(muted: boolean): NativeImage {
  const key = muted ? 'audio-muted' : 'audio'
  const cached = iconCache.get(key)
  if (cached) return cached

  const glyph = muted ? SPEAKER_MUTED : SPEAKER
  const { buf, set } = newDiscBuffer(muted ? MUTED : PLAYING, PLAYING_RADIUS)
  const scale = 2
  const offset = Math.round((SIZE - glyph.length * scale) / 2)
  for (let gy = 0; gy < glyph.length; gy++) {
    for (let gx = 0; gx < glyph[gy].length; gx++) {
      if (glyph[gy][gx] !== '1') continue
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          set(offset + gx * scale + sx, offset + gy * scale + sy, 255, 255, 255)
        }
      }
    }
  }

  const image = nativeImage.createFromBitmap(buf, { width: SIZE, height: SIZE })
  iconCache.set(key, image)
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
 * Reflect unread state - and, failing that, audio - on the OS taskbar icon. A
 * positive `count` draws the number; otherwise `dot` draws a plain red dot
 * (unread from a caught notification with no title count); otherwise `playing`
 * draws a speaker.
 *
 * That ordering is forced: Windows gives a taskbar button ONE overlay slot, so
 * the two indicators cannot coexist, and an unread message is the one you would
 * regret missing. Music you can hear.
 *
 * Windows draws an overlay on the taskbar button; macOS/Linux use the native
 * dock/launcher badge count, which carries no glyph, so audio is not shown
 * there at all rather than being faked as an unread item.
 */
/**
 * `muted` is only meaningful together with `playing`: it says the music Pod
 * WOULD be sounding and has been silenced, which is the thing worth knowing
 * from the taskbar. A Pod muted while nothing plays is not news, and showing it
 * would leave a badge sitting there for a setting rather than a state.
 */
export function setTaskbarBadge(
  window: BrowserWindow,
  count: number,
  dot: boolean,
  playing = false,
  muted = false
): void {
  if (window.isDestroyed()) return
  if (process.platform === 'win32') {
    const overlay =
      count > 0
        ? makeBadgeIcon(count)
        : dot
          ? makeDotIcon()
          : playing
            ? makeSpeakerIcon(muted)
            : null
    const description =
      count > 0
        ? `${count} unread notifications`
        : dot
          ? 'New notifications'
          : playing
            ? muted
              ? 'Audio muted'
              : 'Playing audio'
            : ''
    window.setOverlayIcon(overlay, description)
  } else {
    app.setBadgeCount(count > 0 ? count : dot ? 1 : 0)
  }
}
