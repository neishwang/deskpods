import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppState } from '@types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** A userData folder per run; the store resolves its path lazily through this. */
let userData = ''
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

const { flushState, loadState, saveState } = await import('./store')

const stateFile = () => join(userData, 'deskpods', 'state.json')

function write(content: string): void {
  mkdirSync(join(userData, 'deskpods'), { recursive: true })
  writeFileSync(stateFile(), content, 'utf8')
}

const sample: AppState = {
  activePodId: 'a',
  folders: [],
  pods: [{ id: 'a', name: 'A', url: 'https://a.example', profile: 'a', folderId: null, order: 0 }]
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'deskpods-store-'))
})

describe('loadState', () => {
  it('falls back to the demo Pods when there is no file yet', () => {
    expect(loadState().pods.length).toBeGreaterThan(0)
  })

  it('reads back what was saved', () => {
    saveState(sample)
    flushState()
    expect(loadState()).toEqual(sample)
  })

  it('keeps a copy of an unusable file instead of quietly starting over', () => {
    // A write cut short by a crash: valid text, useless content.
    write('{"pods":[{"id":"a","url":"https://a.exa')
    const state = loadState()

    expect(state.pods.some((p) => p.id === 'a')).toBe(false) // demo Pods
    const kept = readdirSync(join(userData, 'deskpods')).filter((f) => f.includes('.corrupt-'))
    expect(kept).toHaveLength(1)
  })

  it('refuses valid JSON that is not a state', () => {
    // This is the one that used to crash main later, on `state.pods.map`.
    write('{"hello":"world"}')
    expect(Array.isArray(loadState().pods)).toBe(true)

    write('{"pods":[{"id":42}],"folders":[]}')
    expect(loadState().pods.every((p) => typeof p.id === 'string')).toBe(true)
  })
})

describe('flushState', () => {
  it('leaves no temporary file behind', () => {
    saveState(sample)
    flushState()
    expect(readdirSync(join(userData, 'deskpods'))).toEqual(['state.json'])
  })

  it('writes valid JSON', () => {
    saveState(sample)
    flushState()
    expect(JSON.parse(readFileSync(stateFile(), 'utf8'))).toEqual(sample)
  })
})
