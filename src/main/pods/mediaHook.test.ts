import { describe, expect, it, vi } from 'vitest'
import { MEDIA_HOOK } from './mediaHook'

/**
 * The media hook is a STRING, injected into a Pod's page with
 * `executeJavaScript`. Nothing typechecks it and nothing in the app reports
 * when it fails: `report()` runs inside a poller, so a throw there just means
 * no state is ever sent and the player sits empty, looking like a missing
 * feature rather than an error.
 *
 * Both mistakes made while writing it were exactly that shape:
 *
 *   - a backtick inside a comment, which closed the template literal early and
 *     at least broke the build;
 *   - a reference to a variable that had been deleted, which did NOT break the
 *     build and silently killed every report for as long as it was there.
 *
 * So these tests RUN it. The stubs are the smallest thing that looks like a
 * page, passed as parameters so they shadow the real globals.
 */

interface Harness {
  /** Every report the hook pushed, in order. */
  reports: Array<Record<string, unknown>>
  /** The command callback the hook registered, if it did. */
  command: ((action: { command: string; value?: number }) => void) | null
  /** Fire the hook's poller once. */
  tick: () => void
  handlers: Record<string, () => void>
  timers?: Array<() => void>
  /** Run the hook a second time on the same page, as both injection paths do. */
  rerun?: () => void
  /** Only set with `bridgeLate`: makes the bridge appear, as the preload does. */
  attachBridge?: () => void
}

/** Run the hook against a fake page. `elements` are what querySelectorAll
 *  returns for 'video, audio'; `metadata` is the media session's. */
function run(options: {
  elements?: Array<{ paused: boolean; duration?: number; currentTime?: number; volume?: number }>
  metadata?: { title?: string; artist?: string; album?: string; artwork?: unknown[] } | null
  playbackState?: string
  registerHandlers?: boolean
  /** Run the hook before window.__deskpods exists, as document-start does. */
  bridgeLate?: boolean
}): Harness {
  const elements = options.elements ?? []
  const harness: Harness = { reports: [], command: null, tick: () => {}, handlers: {} }

  const mediaSession: Record<string, unknown> = {
    metadata: options.metadata ?? null,
    playbackState: options.playbackState ?? 'none',
    setActionHandler(action: string, handler: (() => void) | null) {
      if (handler) harness.handlers[action] = handler
      else delete harness.handlers[action]
    },
    setPositionState() {}
  }

  const win: Record<string, unknown> = {
    __deskpods: {
      media: (info: Record<string, unknown>) => harness.reports.push(info),
      onMediaCommand: (cb: (action: { command: string; value?: number }) => void) => {
        harness.command = cb
      }
    }
  }

  const doc = {
    querySelectorAll: (selector: string) => (selector === 'video, audio' ? elements : []),
    querySelector: () => null
  }

  // Every interval the hook arms, in order: the poller, and the wait for the
  // bridge when it is not there yet.
  const timers: Array<() => void> = []
  const setInterval = (fn: () => void) => {
    timers.push(fn)
    harness.tick = fn
    return timers.length
  }
  const clearInterval = () => {}
  const setTimeout = () => 0
  harness.timers = timers

  // Parameters shadow the globals the hook reaches for, so it runs against the
  // stubs without a DOM implementation.
  const fn = new Function(
    'window',
    'document',
    'navigator',
    'setInterval',
    'setTimeout',
    'clearInterval',
    MEDIA_HOOK
  )
  const invoke = () => fn(win, doc, { mediaSession }, setInterval, setTimeout, clearInterval)

  if (options.bridgeLate) {
    // The bridge is what the Pod preload exposes. Injected at document start,
    // the hook can run before it exists.
    const bridge = win.__deskpods
    delete win.__deskpods
    invoke()
    harness.attachBridge = () => {
      win.__deskpods = bridge
      // Firing the wait the hook armed is what the bridge appearing looks like.
      for (const timer of [...timers]) timer()
    }
  } else {
    invoke()
  }
  harness.rerun = invoke

  // The page registers its handlers after the hook wrapped setActionHandler,
  // which is the order that lets them be captured at all.
  if (options.registerHandlers) {
    const set = mediaSession.setActionHandler as (a: string, h: () => void) => void
    for (const action of ['play', 'pause', 'nexttrack', 'previoustrack']) {
      set(action, vi.fn())
    }
  }
  return harness
}

describe('MEDIA_HOOK', () => {
  it('runs and reports without throwing', () => {
    // The regression test for the deleted-variable bug: any ReferenceError in
    // report() lands here, where nothing in the app would have surfaced it.
    const h = run({})
    expect(h.reports.length).toBeGreaterThan(0)
  })

  it('registers a command callback', () => {
    expect(run({}).command).not.toBeNull()
  })

  it('reads a locally playing element', () => {
    const h = run({
      elements: [{ paused: false, duration: 200, currentTime: 30, volume: 0.5 }],
      playbackState: 'playing'
    })
    const last = h.reports[h.reports.length - 1]
    expect(last.playing).toBe(true)
    expect(last.position).toBe(30)
    expect(last.duration).toBe(200)
  })

  it('trusts a page that reports its own paused state', () => {
    const h = run({
      elements: [{ paused: true, duration: 200, currentTime: 10 }],
      metadata: { title: 'x' },
      playbackState: 'paused'
    })
    expect(h.reports[h.reports.length - 1].playing).toBe(false)
  })

  it('trusts playbackState over a missing element', () => {
    // SoundCloud drives audio with no element this side can see. Saying it is
    // playing is what its own playbackState is for, and an earlier version
    // instead called that situation a remote and hid its volume control.
    const h = run({ metadata: { title: 'x' }, playbackState: 'playing' })
    expect(h.reports[h.reports.length - 1].playing).toBe(true)
  })

  it('alternates play and pause when the page reports nothing', () => {
    // THE regression. With no element and playbackState at 'none', deriving
    // "paused" from that state made it permanently true, so every press fired
    // 'play' and Pause could never be sent at all.
    const h = run({ metadata: { title: 'Far away' }, registerHandlers: true })
    h.tick()
    h.command?.({ command: 'playpause' })
    h.command?.({ command: 'playpause' })
    // One each, in whichever order the assumed state started from: what must
    // never happen again is the same one twice.
    expect(h.handlers.play).toHaveBeenCalledTimes(1)
    expect(h.handlers.pause).toHaveBeenCalledTimes(1)
  })

  it('starts from paused when the page offered no metadata yet', () => {
    // Nothing has announced a track, so the first press has to be 'play'.
    const h = run({ metadata: null, registerHandlers: true })
    h.tick()
    h.command?.({ command: 'playpause' })
    expect(h.handlers.play).toHaveBeenCalledTimes(1)
    expect(h.handlers.pause).toHaveBeenCalledTimes(0)
  })

  it('reports what the page can actually be asked to do', () => {
    const withHandlers = run({ metadata: { title: 'x' }, registerHandlers: true })
    withHandlers.tick()
    expect(withHandlers.reports[withHandlers.reports.length - 1].canNext).toBe(true)

    const without = run({ metadata: { title: 'x' } })
    expect(without.reports[without.reports.length - 1].canNext).toBe(false)
  })

  it('captures handlers even when the bridge is not there yet', () => {
    // The point of injecting at document start: handlers registered by the page
    // before the wrapper is in place cannot be read back, which is why Apple
    // Music's next/previous were dead. But at document start the preload may
    // not have exposed __deskpods, and an earlier version of the hook simply
    // returned in that case - trading one missing feature for all of them.
    const h = run({ metadata: { title: 'x' }, registerHandlers: true, bridgeLate: true })
    expect(h.reports).toHaveLength(0)

    h.attachBridge?.()
    expect(h.reports.length).toBeGreaterThan(0)
    expect(h.reports[h.reports.length - 1].canNext).toBe(true)
    expect(h.reports[h.reports.length - 1].canPrevious).toBe(true)
  })

  it('does not wrap or poll twice when injected again', () => {
    // Both paths run on the music Pod: the document-start script and the
    // dom-ready fallback.
    const h = run({ metadata: { title: 'x' }, registerHandlers: true })
    const before = h.reports.length
    h.rerun?.()
    // A second run reports once (it calls the existing reporter) but must not
    // arm another poller.
    expect(h.timers?.length).toBe(1)
    expect(h.reports.length).toBeGreaterThanOrEqual(before)
  })

  it('says when seeking and volume can do nothing', () => {
    // SoundCloud's shape: a media session and a title, but no element this side
    // can see, so there is no level to set and nothing to scrub. The controls
    // are greyed from these rather than drawn as usable and ignored.
    const blind = run({ metadata: { title: 'x' }, registerHandlers: true })
    blind.tick()
    const last = blind.reports[blind.reports.length - 1]
    expect(last.canVolume).toBe(false)
    expect(last.canSeek).toBe(false)

    const local = run({
      elements: [{ paused: false, duration: 200, currentTime: 5, volume: 0.4 }],
      playbackState: 'playing'
    })
    const report = local.reports[local.reports.length - 1]
    expect(report.canVolume).toBe(true)
    expect(report.canSeek).toBe(true)
  })

  it('picks the largest artwork offered', () => {
    const h = run({
      metadata: {
        title: 'x',
        artwork: [
          { src: 'small.png', sizes: '64x64' },
          { src: 'big.png', sizes: '640x640' }
        ]
      }
    })
    expect(h.reports[h.reports.length - 1].artwork).toBe('big.png')
  })
})
