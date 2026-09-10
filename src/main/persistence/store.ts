import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppState } from '@types'
import { app } from 'electron'

/**
 * Minimal JSON-file persistence for the app state.
 * Kept deliberately simple for the shell; can be swapped later without
 * touching the domain logic.
 */

// Resolved lazily (not at import time) so a portable `userData` override applied
// in main/index.ts before the first read takes effect.
const stateFile = (): string => join(app.getPath('userData'), 'deskpods', 'state.json')

/** Two demo Pods on distinct partitions to prove session isolation. */
function defaultState(): AppState {
  return {
    folders: [],
    activePodId: 'demo-example',
    pods: [
      {
        id: 'demo-example',
        name: 'Example',
        url: 'https://example.com',
        profile: 'demo-example',
        folderId: null,
        order: 0
      },
      {
        id: 'demo-wikipedia',
        name: 'Wikipedia',
        url: 'https://wikipedia.org',
        profile: 'demo-wikipedia',
        folderId: null,
        order: 1
      }
    ]
  }
}

/**
 * A parsed file is not yet a state: a truncated write can leave valid JSON with
 * half the shape, and handing that to main crashes it on the first `.map`.
 * Anything that is not recognisable is refused as a whole rather than patched
 * into something half-true.
 */
function isAppState(value: unknown): value is AppState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Partial<AppState>
  if (!Array.isArray(state.pods) || !Array.isArray(state.folders)) return false
  return state.pods.every(
    (pod) =>
      typeof pod?.id === 'string' && typeof pod.url === 'string' && typeof pod.profile === 'string'
  )
}

export function loadState(): AppState {
  const file = stateFile()
  let raw: string
  try {
    if (!existsSync(file)) return defaultState()
    raw = readFileSync(file, 'utf-8')
  } catch {
    // Unreadable (locked, permissions): start on the defaults, but do NOT touch
    // the file — the next launch may well read it fine.
    return defaultState()
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (isAppState(parsed)) return parsed
  } catch {
    // Falls through to the rescue below.
  }

  // Unusable content. Falling back to the demo Pods silently would look exactly
  // like "DeskPods lost everything", so keep the file: whatever is in it may
  // still be recoverable by hand, and its presence explains the empty start.
  try {
    renameSync(file, `${file}.corrupt-${Date.now()}`)
    console.error(`[deskpods] Unusable state file; kept a copy next to ${file}`)
  } catch (err) {
    console.error('[deskpods] Unusable state file, and it could not be kept:', err)
  }
  return defaultState()
}

// Saves are debounced: interactions come in bursts (switching Pods, dragging a
// whole reorder, renaming) and each one used to hit the disk synchronously.
// One trailing write per burst is enough; `flushState()` (wired to
// `before-quit`) guarantees nothing is lost on exit. Callers keep mutating the
// same state object, so the pending reference always serializes fresh data.
const SAVE_DELAY_MS = 400
let pending: AppState | null = null
let saveTimer: NodeJS.Timeout | null = null

export function saveState(state: AppState): void {
  pending = state
  if (saveTimer) return
  saveTimer = setTimeout(flushState, SAVE_DELAY_MS)
}

/** Write any pending state immediately. Safe to call at any time. */
export function flushState(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (!pending) return
  const state = pending
  pending = null
  try {
    const file = stateFile()
    mkdirSync(dirname(file), { recursive: true })
    // Write beside the real file and rename over it: a crash or a power cut
    // mid-write would otherwise leave a truncated state.json, and the next
    // launch would find no Pods at all. A rename is atomic; a write is not.
    const temporary = `${file}.tmp`
    writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf-8')
    renameSync(temporary, file)
  } catch (err) {
    // A failed write must never crash main; state stays in memory and the next
    // mutation will retry.
    console.error('[deskpods] Failed to persist state:', err)
  }
}
