import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
/**
 * Generates the DeskPods app icon (build/icon.png @1024 + build/icon.ico).
 * Pure Node (no native deps): a rounded-square dark gradient with the brand's
 * stacked-"pods" motif in accent blue. Re-run with `bun run icon`.
 */
import zlib from 'node:zlib'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')

// --- colour helpers ---
const hex = (h) => [
  Number.parseInt(h.slice(1, 3), 16),
  Number.parseInt(h.slice(3, 5), 16),
  Number.parseInt(h.slice(5, 7), 16)
]
const lerp = (a, b, t) => a + (b - a) * t
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]

const BG_TOP = hex('#1E293B')
const BG_BOTTOM = hex('#0F172A')
const POD_LIGHT = hex('#60A5FA')
const POD_ACCENT = hex('#2563EB')
const POD_DARK = hex('#1D4ED8')

// Signed distance to a rounded rectangle centred at (cx,cy), half-size hw/hh.
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r)
  const qy = Math.abs(py - cy) - (hh - r)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r
  const inside = Math.min(Math.max(qx, qy), 0)
  return outside + inside
}

/** Composite `src` (rgb + coverage alpha 0..1) over `dst` rgba in-place. */
function over(buf, i, rgb, a) {
  if (a <= 0) return
  const ia = 1 - a
  buf[i] = rgb[0] * a + buf[i] * ia
  buf[i + 1] = rgb[1] * a + buf[i + 1] * ia
  buf[i + 2] = rgb[2] * a + buf[i + 2] * ia
  buf[i + 3] = Math.max(buf[i + 3], a * 255)
}

function render(S) {
  const buf = new Float64Array(S * S * 4)
  const u = S / 1024 // scale factor from the 1024 reference design
  const R = 224 * u // background corner radius
  const pods = [
    { cx: 512 - 46 * u, cy: 512 - 190 * u, col: POD_LIGHT },
    { cx: 512 + 8 * u, cy: 512, col: POD_ACCENT },
    { cx: 512 + 54 * u, cy: 512 + 190 * u, col: POD_DARK }
  ].map((p) => ({ ...p, cx: p.cx * u, cy: p.cy * u }))
  const podHW = 235 * u
  const podHH = 74 * u
  const podR = podHH

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4
      const px = x + 0.5
      const py = y + 0.5

      // Rounded-square background with a top→bottom gradient.
      const dBg = sdRoundRect(px, py, S / 2, S / 2, S / 2, S / 2, R)
      const bgA = Math.min(Math.max(0.5 - dBg, 0), 1)
      if (bgA <= 0) continue
      const bg = mix(BG_TOP, BG_BOTTOM, y / S)
      buf[i] = bg[0]
      buf[i + 1] = bg[1]
      buf[i + 2] = bg[2]
      buf[i + 3] = bgA * 255

      // Soft drop shadow beneath each pod, then the pod itself + top gloss.
      for (const p of pods) {
        const ds = sdRoundRect(px, py, p.cx, p.cy + 14 * u, podHW, podHH, podR)
        over(buf, i, BG_BOTTOM, Math.min(Math.max(0.5 - ds, 0), 1) * 0.35)
      }
      for (const p of pods) {
        const d = sdRoundRect(px, py, p.cx, p.cy, podHW, podHH, podR)
        const a = Math.min(Math.max(0.5 - d, 0), 1)
        over(buf, i, p.col, a)
        // Subtle gloss on the upper third of the pod.
        const gloss = a > 0 && py < p.cy - podHH * 0.15 ? a * 0.18 : 0
        over(buf, i, [255, 255, 255], gloss)
      }
    }
  }

  // Clamp/round to 8-bit RGBA raw with per-row PNG filter byte.
  const raw = Buffer.alloc(S * (S * 4 + 1))
  let o = 0
  for (let y = 0; y < S; y++) {
    raw[o++] = 0
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4
      for (let k = 0; k < 4; k++) raw[o++] = Math.round(Math.min(255, Math.max(0, buf[i + k])))
    }
  }
  return encodePng(S, raw)
}

// --- minimal PNG encoder ---
const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}
function encodePng(S, raw) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(S, 0)
  ihdr.writeUInt32BE(S, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type RGBA
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// --- ICO wrapping a 256×256 PNG (Windows Vista+ supports PNG-in-ICO) ---
function encodeIco(png256) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(1, 4) // count
  const entry = Buffer.alloc(16)
  entry[0] = 0 // width 256 (0 means 256)
  entry[1] = 0 // height 256
  entry.writeUInt16LE(1, 4) // planes
  entry.writeUInt16LE(32, 6) // bpp
  entry.writeUInt32LE(png256.length, 8)
  entry.writeUInt32LE(6 + 16, 12) // offset
  return Buffer.concat([header, entry, png256])
}

mkdirSync(OUT, { recursive: true })
const png1024 = render(1024)
const png256 = render(256)
writeFileSync(join(OUT, 'icon.png'), png1024)
writeFileSync(join(OUT, 'icon.ico'), encodeIco(png256))
console.log(
  `Wrote build/icon.png (${png1024.length} B) and build/icon.ico (${png256.length + 22} B)`
)
