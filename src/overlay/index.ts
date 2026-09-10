/**
 * Overlay renderer: a tiny, dependency-free layer that draws tooltips, the zoom
 * indicator and themed notification toasts above the Pods' native web views. It
 * only listens for payloads pushed by main.
 *
 * Main shows the overlay window when it sends content; this side reports back
 * (overlayIdle) once nothing is visible any more, so main can hide the window
 * and the compositor stops blending a transparent full-size surface.
 */
import type { OverlayApi } from '@types'

/** What the overlay's preload actually exposes. Going through this handle means
 *  reaching for anything else fails to compile rather than at runtime. */
const bridge: OverlayApi = window.deskpods

let tooltipVisible = false
let zoomVisible = false
let toastCount = 0
let idleTimer: number | undefined

/** Report idle shortly after the last content goes away. The delay absorbs the
 *  hover flicker of moving between sidebar icons (hide → show within ms). */
function scheduleIdleCheck(): void {
  clearTimeout(idleTimer)
  idleTimer = window.setTimeout(() => {
    if (!tooltipVisible && !zoomVisible && toastCount === 0) bridge.overlayIdle()
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

  /** Tell main which rectangles must receive clicks. Everything else in the
   *  overlay stays click-through, so the Pod underneath keeps the mouse. */
  const reportToastAreas = () => {
    const areas = [...toasts.querySelectorAll('.toast:not(.leaving)')].map((el) => {
      const r = el.getBoundingClientRect()
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height)
      }
    })
    bridge.reportHitAreas(areas)
  }

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
      reportToastAreas()
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
      reportToastAreas()
    })

    const dismiss = () => {
      // `leaving` drops it from the clickable regions straight away: it is
      // still on screen for the fade, but must not eat clicks any more.
      el.classList.add('leaving')
      el.classList.remove('visible')
      reportToastAreas()
      el.addEventListener('transitionend', remove, { once: true })
      setTimeout(remove, 400) // fallback if no transitionend fires
    }

    // Clicking a notification dismisses it.
    el.addEventListener('click', dismiss)

    setTimeout(dismiss, TOAST_MS)
  })
}
