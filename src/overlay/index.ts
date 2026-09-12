/**
 * Overlay renderer: a tiny, dependency-free layer that draws tooltips, the zoom
 * indicator and themed notification toasts above the Pods' native web views. It
 * only listens for payloads pushed by main.
 *
 * Main shows the overlay window when it sends content; this side reports back
 * (overlayIdle) once nothing is visible any more, so main can hide the window
 * and the compositor stops blending a transparent full-size surface.
 */

import type { MediaCommand, OverlayApi } from '@types'
import { ICONS, lucide } from './icons'

/** What the overlay's preload actually exposes. Going through this handle means
 *  reaching for anything else fails to compile rather than at runtime. */
const bridge: OverlayApi = window.deskpods

let tooltipVisible = false
let zoomVisible = false
let toastCount = 0
let panelVisible = false
let navVisible = false
/** Set once the drawer is built; returns its rectangle, or null when closed. */
let drawerRect: () => { x: number; y: number; width: number; height: number } | null = () => null
let idleTimer: number | undefined

const rectOf = (el: Element) => {
  const r = el.getBoundingClientRect()
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height)
  }
}

/**
 * Tell main which rectangles must receive clicks. Everything else in the
 * overlay stays click-through, so the Pod underneath keeps the mouse.
 *
 * Collected in ONE place on purpose: main is handed the whole list each time,
 * so a toast reporting its own rectangle would otherwise erase the panel's.
 */
function reportAreas(): void {
  const areas: ReturnType<typeof rectOf>[] = []

  // The drawer reports its INTENDED rectangle rather than its measured one:
  // while it is opening the element is only a few pixels wide, and a hit area
  // that narrow means the pointer is never seen to be over it - which is why
  // the drawer used to vanish the moment you reached for it.
  const drawer = drawerRect()
  if (drawer) areas.push(drawer)
  const nav = document.getElementById('music-nav')
  if (nav && navVisible) areas.push(rectOf(nav))
  const list = document.getElementById('toasts')
  if (list) {
    for (const el of list.querySelectorAll('.toast:not(.leaving)')) areas.push(rectOf(el))
  }
  bridge.reportHitAreas(areas)
}

/** Report idle shortly after the last content goes away. The delay absorbs the
 *  hover flicker of moving between sidebar icons (hide → show within ms). */
function scheduleIdleCheck(): void {
  clearTimeout(idleTimer)
  idleTimer = window.setTimeout(() => {
    if (!tooltipVisible && !zoomVisible && !panelVisible && !navVisible && toastCount === 0) {
      bridge.overlayIdle()
    }
  }, 250)
}

const tooltip = document.getElementById('tooltip')

if (tooltip) {
  bridge.onTooltip((payload) => {
    if (!payload) {
      tooltip.classList.remove('visible')
      tooltipVisible = false
      scheduleIdleCheck()
      return
    }
    tooltip.textContent = payload.text
    tooltip.style.left = `${payload.x + 10}px`
    tooltip.style.top = `${payload.y}px`
    tooltip.classList.add('visible')
    tooltipVisible = true
  })
}

const zoom = document.getElementById('zoom')

if (zoom) {
  // Long enough to read while stepping through zoom levels, short enough not to
  // sit on the page: each new step restarts the countdown.
  const ZOOM_MS = 1400
  let hideTimer: number | undefined

  bridge.onZoomIndicator((percent) => {
    zoom.textContent = `${percent}%`
    zoom.classList.add('visible')
    zoomVisible = true

    clearTimeout(hideTimer)
    hideTimer = window.setTimeout(() => {
      zoom.classList.remove('visible')
      zoomVisible = false
      scheduleIdleCheck()
    }, ZOOM_MS)
  })
}

const toasts = document.getElementById('toasts')

if (toasts) {
  const TOAST_MS = 6000
  const MAX_TOASTS = 4

  bridge.onToast((toast) => {
    const el = document.createElement('div')
    el.className = 'toast'
    el.title = 'Click to dismiss'

    const pod = document.createElement('div')
    pod.className = 'pod'
    pod.textContent = toast.podName
    el.appendChild(pod)

    const title = document.createElement('div')
    title.className = 'title'
    title.textContent = toast.title || toast.podName
    el.appendChild(title)

    if (toast.body) {
      const body = document.createElement('div')
      body.className = 'body'
      body.textContent = toast.body
      el.appendChild(body)
    }

    toastCount++
    // `remove` may be reached twice (transitionend + fallback) and also by the
    // overflow eviction below; count each toast down exactly once.
    let removed = false
    const remove = () => {
      if (removed) return
      removed = true
      el.remove()
      toastCount--
      reportAreas()
      scheduleIdleCheck()
    }
    ;(el as HTMLElement & { __remove?: () => void }).__remove = remove

    toasts.appendChild(el)
    // Drop the oldest if we're stacking too many.
    while (toasts.childElementCount > MAX_TOASTS) {
      const oldest = toasts.firstElementChild as (Element & { __remove?: () => void }) | null
      if (!oldest) break
      if (oldest.__remove) oldest.__remove()
      else oldest.remove()
    }

    // Next frame so the enter transition runs, and so the rectangle reported to
    // main is the laid-out one.
    requestAnimationFrame(() => {
      el.classList.add('visible')
      reportAreas()
    })

    const dismiss = () => {
      // `leaving` drops it from the clickable regions straight away: it is
      // still on screen for the fade, but must not eat clicks any more.
      el.classList.add('leaving')
      el.classList.remove('visible')
      reportAreas()
      el.addEventListener('transitionend', remove, { once: true })
      setTimeout(remove, 400) // fallback if no transitionend fires
    }

    // Clicking a notification dismisses it.
    el.addEventListener('click', dismiss)

    setTimeout(dismiss, TOAST_MS)
  })
}

// --- media drawer ---------------------------------------------------------
// The fuller transport for the music Pod: a fixed strip on the bottom edge,
// beside the rail. The rail keeps the cover, play/pause and mute; the track,
// the transport, the seek bar and the volume live here, where there is width.

/**
 * The strip's width, in CSS pixels - which is already a constant PHYSICAL size:
 * this is the same width on a 100% display and a 150% one.
 *
 * Worth stating, because measuring it says otherwise. A screenshot records
 * device pixels, so this element measures 631 on a 150% display and 420 on a
 * 100% one. Both are correct, and "correcting" the difference by dividing by
 * devicePixelRatio makes the drawer two thirds of its proper size on the scaled
 * screen while leaving the unscaled one untouched - which is exactly how it
 * came to work on one display and not the other.
 *
 * Its height is not a number at all: the drawer runs from the rule above the
 * music Pod's slot to the bottom of the window, so it IS the slot's height, at
 * any scale, with nothing to keep in step.
 */
const DRAWER_WIDTH = 320

/** Widen, then fade the contents in; on the way out, fade, then collapse. Both
 *  beats are pushed into the stylesheet below, so the transitions and the
 *  timers that sequence them are the same numbers. */
const SLIDE_MS = 75
const FADE_MS = 75

const icon = (name: string, size = 14) => lucide(ICONS[name], size)

/** m:ss, or h:mm:ss for the occasional long mix. */
function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const total = Math.floor(seconds)
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/** Paint the played portion of a range input. A range has no "filled" side of
 *  its own, so the track is a gradient whose stop sits at the current value. */
function paintRange(input: HTMLInputElement, accent = '#2563eb'): void {
  const min = Number(input.min || 0)
  const max = Number(input.max || 100)
  const span = max - min
  const pct = span > 0 ? ((Number(input.value) - min) / span) * 100 : 0
  const filled = input.disabled ? '#475569' : accent
  input.style.background = `linear-gradient(to right, ${filled} ${pct}%, #334155 ${pct}%)`
}

/**
 * A line that scrolls itself, but only when it genuinely does not fit.
 *
 * `measure()` is deliberately separate from `set()`: the text is known long
 * before the strip has a width to overflow, and measuring against a collapsed
 * box declares every line too long. The drawer calls it once the widening is
 * over, which is the first moment the answer can be right.
 */
function makeScroller(className: string): {
  el: HTMLElement
  set: (text: string) => void
  measure: () => void
} {
  const el = document.createElement('div')
  el.className = `${className} scroller`
  const span = document.createElement('span')
  el.appendChild(span)

  const measure = () => {
    const overflow = Math.round(span.scrollWidth - el.clientWidth)
    // A box with no width yet cannot tell us anything.
    if (el.clientWidth === 0) return
    if (overflow > 1) {
      el.style.setProperty('--marquee-shift', `${-overflow}px`)
      // Paced by distance, so a slightly long title does not crawl and a very
      // long one does not race.
      el.style.setProperty('--marquee-duration', `${Math.round(overflow / 18) + 5}s`)
      el.classList.add('overflowing')
    } else {
      el.classList.remove('overflowing')
    }
  }

  let shown: string | null = null
  return {
    el,
    measure,
    set: (text: string) => {
      if (text === shown) return
      shown = text
      span.textContent = text
      // Start the new line from the beginning rather than mid-scroll.
      el.classList.remove('overflowing')
      measure()
    }
  }
}

const drawerEl = document.getElementById('media-drawer')

if (drawerEl) {
  drawerEl.style.setProperty('--slide', `${SLIDE_MS}ms`)
  drawerEl.style.setProperty('--fade', `${FADE_MS}ms`)

  const inner = document.createElement('div')
  inner.className = 'inner'
  drawerEl.appendChild(inner)

  const top = document.createElement('div')
  top.className = 'top'
  const bottom = document.createElement('div')
  bottom.className = 'bottom'
  inner.append(top, bottom)

  const transport = document.createElement('div')
  transport.className = 'transport'

  const button = (label: string, command: MediaCommand, primary = false) => {
    const el = document.createElement('button')
    el.type = 'button'
    el.title = label
    el.setAttribute('aria-label', label)
    if (primary) el.className = 'primary'
    el.addEventListener('click', () => bridge.sendOverlayMediaCommand(command))
    return el
  }

  const previous = button('Previous track', 'previous')
  const playPause = button('Play / Pause', 'playpause', true)
  const next = button('Next track', 'next')
  const mute = button('Mute', 'togglemute')
  previous.replaceChildren(icon('skip-back'))
  next.replaceChildren(icon('skip-forward'))
  transport.append(previous, playPause, next)

  const track = document.createElement('div')
  track.className = 'track'
  const title = makeScroller('title')
  const artist = makeScroller('artist')
  track.append(title.el, artist.el)

  const volumeBox = document.createElement('div')
  volumeBox.className = 'volume'
  const volume = document.createElement('input')
  volume.type = 'range'
  volume.min = '0'
  volume.max = '1'
  volume.step = '0.01'
  volume.value = '1'
  volume.setAttribute('aria-label', 'Volume')
  volumeBox.append(mute, volume)

  top.append(transport, track, volumeBox)

  const elapsed = document.createElement('span')
  const duration = document.createElement('span')
  const seek = document.createElement('input')
  seek.type = 'range'
  seek.className = 'seek'
  seek.min = '0'
  seek.step = '1'
  seek.value = '0'
  seek.setAttribute('aria-label', 'Seek')
  bottom.append(elapsed, seek, duration)

  /**
   * A seek is not instant: the page keeps reporting the OLD position for a
   * moment after being asked to jump. Writing those reports into the slider is
   * what made the thumb snap back before landing. Until the page reports a
   * position near the one asked for - or this runs out - the slider holds the
   * requested value.
   */
  let pendingSeek: { value: number; until: number } | null = null
  let scrubbing = false

  const settled = (position: number): boolean => {
    if (!pendingSeek) return true
    if (Date.now() > pendingSeek.until) return true
    return Math.abs(position - pendingSeek.value) < 2
  }

  const requestSeek = () => {
    const value = Number(seek.value)
    pendingSeek = { value, until: Date.now() + 2500 }
    bridge.sendOverlayMediaCommand('seek', value)
  }

  seek.addEventListener('pointerdown', () => {
    scrubbing = true
  })
  const commitSeek = () => {
    if (!scrubbing) return
    scrubbing = false
    requestSeek()
  }
  seek.addEventListener('pointerup', commitSeek)
  seek.addEventListener('pointercancel', commitSeek)
  seek.addEventListener('keyup', requestSeek)
  seek.addEventListener('input', () => {
    elapsed.textContent = clock(Number(seek.value))
    paintRange(seek)
  })

  let adjustingVolume = false
  volume.addEventListener('pointerdown', () => {
    adjustingVolume = true
  })
  const endVolume = () => {
    adjustingVolume = false
  }
  volume.addEventListener('pointerup', endVolume)
  volume.addEventListener('pointercancel', endVolume)
  volume.addEventListener('input', () => {
    paintRange(volume, '#94a3b8')
    bridge.sendOverlayMediaCommand('volume', Number(volume.value))
  })

  // --- the two-beat open and close ---------------------------------------
  // One timer, always cancelled before the next beat is scheduled: hovering in
  // and out faster than the animation is the normal case, not the edge one.
  let beat: number | undefined
  /**
   * Two different questions, and they stop being the same the moment the strip
   * animates: `panelVisible` is "something of it is still on screen", which is
   * what decides whether the overlay window may be hidden; `clickable` is "it
   * is open and meant to take clicks", which is what decides hit testing. On
   * the way out, clicks must stop at once while the pixels linger.
   */
  let clickable = false

  const open = () => {
    // Guard BEFORE touching the timer. Main re-sends the drawer on every report
    // from the page, so `open` is called again while it is still widening - and
    // clearing the beat first killed the very timer that was about to fade the
    // contents in, then returned. That is the "hover a few times and the
    // controls never appear" bug: the drawer was open and permanently blank.
    if (clickable) return
    clearTimeout(beat)
    panelVisible = true
    clickable = true
    drawerEl.classList.add('open')
    drawerEl.style.width = `${DRAWER_WIDTH}px`
    beat = window.setTimeout(() => {
      drawerEl.classList.add('shown')
      // The first moment the strip has its real width, so the first moment the
      // marquee can tell whether a line actually overflows.
      title.measure()
      artist.measure()
    }, SLIDE_MS)
  }

  const close = () => {
    // Same order, same reason: a second close while one is already running must
    // not cancel the beat that finishes it, or the strip stays half shut.
    if (!clickable) return
    clearTimeout(beat)
    clickable = false
    reportAreas()
    drawerEl.classList.remove('shown')
    beat = window.setTimeout(() => {
      drawerEl.classList.remove('open')
      drawerEl.style.width = '0px'
      beat = window.setTimeout(() => {
        panelVisible = false
        scheduleIdleCheck()
      }, SLIDE_MS)
    }, FADE_MS)
  }

  bridge.onMediaPanel((payload) => {
    if (!payload) {
      close()
      return
    }
    const { info } = payload

    // Not merely "the page reported something": the hook reports as soon as the
    // page loads, with nothing playing. Until a track has actually been put on
    // there is no media session to command, and a lit-up Play button would be
    // a lie.
    const hasTrack = info.title !== '' || info.duration > 0

    title.set(info.title || 'Nothing playing')
    artist.set(info.artist || info.album || '')
    // Already open: the width is settled, so a new track can be measured now.
    if (drawerEl.classList.contains('shown')) {
      title.measure()
      artist.measure()
    }

    playPause.replaceChildren(icon(info.playing ? 'pause' : 'play', 15))
    playPause.title = info.playing ? 'Pause' : 'Play'
    playPause.disabled = !hasTrack

    // The LEVEL is the page's to offer; MUTING is not, and the two are disabled
    // separately for that reason. Mute acts on the Pod's web contents, so it
    // silences whatever the Pod is playing even when no element can be found -
    // which is exactly the case where the slider can do nothing.
    volume.disabled = !info.canVolume

    // Three states, not two: silenced (muted, or the page's own level at zero),
    // quiet, and loud - so the icon is never at odds with the slider beside it.
    const silent = info.muted || info.volume <= 0
    mute.replaceChildren(icon(silent ? 'volume-x' : info.volume > 0.5 ? 'volume-2' : 'volume-1'))
    mute.title = info.muted ? 'Unmute' : 'Mute'
    mute.classList.toggle('on', silent)

    // Scrubbing needs BOTH a length to scrub within and something that can
    // act on it (see MediaReport.canSeek): a bar that moves while the sound
    // does not is worse than one that plainly cannot be moved.
    const hasTime = info.duration > 0 && info.canSeek
    seek.disabled = !hasTime
    seek.max = String(hasTime ? info.duration : 0)
    if (settled(info.position)) pendingSeek = null
    if (!scrubbing && !pendingSeek) {
      seek.value = String(hasTime ? Math.min(info.position, info.duration) : 0)
      elapsed.textContent = clock(info.position)
    }
    duration.textContent = hasTime ? clock(info.duration) : '--:--'
    paintRange(seek)
    if (!adjustingVolume) {
      // A page with no level to report is drawn at full rather than at zero:
      // zero would read as "silenced", which is a claim about the sound.
      volume.value = String(info.canVolume ? info.volume : 1)
      paintRange(volume, '#94a3b8')
    }

    // Disabled rather than hidden: buttons that come and go under the cursor
    // are worse than buttons that plainly cannot be used.
    previous.disabled = !info.canPrevious
    next.disabled = !info.canNext

    // Straight from the chrome's viewport into this one: the overlay covers
    // exactly that content area (see MediaPanelPayload). All three values come
    // from the chrome, so nothing here depends on this window's own edges.
    drawerEl.style.left = `${payload.x}px`
    drawerEl.style.top = `${payload.top}px`
    drawerEl.style.height = `${payload.height}px`
    open()
    // Reported from the intended geometry, not measured: mid-animation the
    // element is a few pixels wide, and a hit area that narrow is why the
    // pointer was never seen to be over the drawer.
    reportAreas()
  })

  /** The drawer's clickable rectangle, or null while it is closed or closing. */
  drawerRect = () => {
    if (!clickable) return null
    return {
      // The same viewport coordinates the element is drawn at - which is the
      // space main hit-tests the cursor in.
      x: Math.round(Number.parseFloat(drawerEl.style.left || '0')),
      y: Math.round(Number.parseFloat(drawerEl.style.top || '0')),
      width: DRAWER_WIDTH,
      height: Math.round(Number.parseFloat(drawerEl.style.height || '0'))
    }
  }

  // The pointer has to leave the sidebar to reach the drawer; main holds it up
  // for a moment, and these say whether it has arrived.
  drawerEl.addEventListener('mouseenter', () => bridge.reportMediaPanelHover(true))
  drawerEl.addEventListener('mouseleave', () => bridge.reportMediaPanelHover(false))
}

// --- the music Pod's history square ---------------------------------------
// Drawn INSIDE that Pod's content area, top-left. Only that Pod gets it: a
// music service walks you off the player with every link it opens, and there is
// no browser chrome here to come back with.

const navEl = document.getElementById('music-nav')

if (navEl) {
  const navButton = (label: string, command: MediaCommand, iconName: string) => {
    const el = document.createElement('button')
    el.type = 'button'
    el.title = label
    el.setAttribute('aria-label', label)
    el.replaceChildren(icon(iconName, 15))
    el.addEventListener('click', () => bridge.sendOverlayMediaCommand(command))
    return el
  }

  const back = navButton('Back', 'back', 'chevron-left')
  const forward = navButton('Forward', 'forward', 'chevron-right')
  navEl.append(back, forward)

  bridge.onMusicNav((payload) => {
    if (!payload) {
      if (!navVisible) return
      navEl.classList.remove('visible')
      navVisible = false
      reportAreas()
      scheduleIdleCheck()
      return
    }
    back.disabled = !payload.canGoBack
    forward.disabled = !payload.canGoForward
    // Inset from the corner of the Pod's area rather than flush against it, so
    // it reads as sitting ON the page instead of being part of the frame.
    navEl.style.left = `${payload.x + 10}px`
    navEl.style.top = `${payload.y + 10}px`
    navEl.classList.add('visible')
    navVisible = true
    requestAnimationFrame(reportAreas)
  })
}
