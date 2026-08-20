import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

export function loadState(): AppState {
  try {
    const file = stateFile()
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, 'utf-8')) as AppState
    }
  } catch {
    // Corrupted or unreadable state falls back to defaults.
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
    writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8')
  } catch (err) {
    // A failed write must never crash main; state stays in memory and the next
    // mutation will retry.
    console.error('[deskpods] Failed to persist state:', err)
  }
}
