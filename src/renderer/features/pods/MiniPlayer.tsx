import { ipc } from '@renderer/lib/ipc'
import { cn } from '@renderer/lib/utils'
import type { Pod } from '@types'
import { Music, Pause, Play, Volume1, Volume2, VolumeX } from 'lucide-react'
import { forwardRef, useEffect, useRef, useState } from 'react'
import { usePodStore } from './usePodStore'

/**
 * The foot of the sidebar: the music Pod, shown as the cover of whatever it is
 * playing.
 *
 * At rest it is JUST the cover. Hovering lays play/pause and mute along its
 * BOTTOM edge and slides the drawer out beside it; the rest of the transport -
 * previous, next, the seek bar, the volume slider - lives in that drawer,
 * where there is room for it.
 *
 * That panel is drawn in the overlay WINDOW, not here: it extends over the
 * workspace, and a Pod's native view paints over anything the chrome renderer
 * puts there (see the z-order note in CLAUDE.md). This component only says
 * where to put it; `src/overlay/index.ts` draws it.
 *
 * The Pod is not loaded at startup: until it is opened once there is nothing
 * playing and nothing to command, and the controls say so by being disabled
 * rather than by doing nothing. Keep Awake, in the Pod's own menu, is what
 * makes it load at launch instead.
 */

function showTip(e: React.PointerEvent<HTMLElement>, text: string): void {
  const r = e.currentTarget.getBoundingClientRect()
  void ipc.showTooltip({ text, x: r.right, y: r.top + r.height / 2 })
}
const hideTip = (): void => {
  void ipc.hideTooltip()
}

export function MiniPlayer(): React.JSX.Element {
  const musicPodId = usePodStore((s) => s.musicPodId)
  const media = usePodStore((s) => s.media)
  const pod = usePodStore((s) => s.pods.find((p) => p.id === s.musicPodId))
  const activePodId = usePodStore((s) => s.activePodId)
  const [hovering, setHovering] = useState(false)
  const footerRef = useRef<HTMLDivElement>(null)

  // Tell main where to draw the drawer while the pointer is here: the rail's
  // right edge, the rule above this slot, and the drop from that rule to the
  // foot of the window. Plain viewport coordinates - the overlay window covers
  // exactly this content area, so they carry over unchanged (see
  // MediaPanelPayload for why going through screen coordinates is worse).
  // Cleaned up on unmount too, or leaving the Pod would strand the drawer.
  useEffect(() => {
    if (!hovering || !musicPodId) {
      void ipc.showMediaPanel(null)
      return
    }
    const footer = footerRef.current
    const rail = footer?.closest('nav')
    if (!footer || !rail) return
    const top = Math.round(footer.getBoundingClientRect().top)
    void ipc.showMediaPanel({
      x: Math.round(rail.getBoundingClientRect().right),
      top,
      height: Math.round(window.innerHeight) - top
    })
    return () => {
      void ipc.showMediaPanel(null)
    }
  }, [hovering, musicPodId])

  // No music Pod yet: one button, which opens the picker.
  if (!musicPodId || !pod) {
    return (
      <Footer ref={footerRef}>
        <button
          type="button"
          onPointerEnter={(e) => showTip(e, 'Add a music Pod')}
          onPointerLeave={hideTip}
          onClick={() => usePodStore.getState().setDialog({ type: 'music-pod' })}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-dashed border-[var(--color-border)] text-[var(--color-muted)] transition hover:text-white"
        >
          <Music className="h-5 w-5" />
        </button>
      </Footer>
    )
  }

  const playing = media?.playing ?? false
  const muted = media?.muted ?? false
  // Not merely "the Pod has reported something": the hook reports as soon as
  // the page loads, with nothing playing. Until a track has actually been put
  // on, there is no media session to command and the button would do nothing.
  const hasTrack = !!media && (media.title !== '' || media.duration > 0)

  return (
    <Footer ref={footerRef}>
      {/* One hover region for the cover and the controls over it, so moving
          between them does not flicker the panel shut. */}
      <div
        className="relative"
        onPointerEnter={() => setHovering(true)}
        onPointerLeave={() => setHovering(false)}
      >
        <button
          type="button"
          onClick={() => void usePodStore.getState().setActive(pod.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            // A native menu takes the pointer without the page ever seeing a
            // `pointerleave`, so the drawer would stay open behind it - and
            // stay open after it closed, since there is no matching enter.
            setHovering(false)
            void ipc.showPodMenu(pod.id)
          }}
          className={cn(
            'flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl text-sm font-semibold transition duration-150',
            pod.id === activePodId
              ? 'bg-[var(--color-accent)] text-white'
              : 'bg-[var(--color-bg)] text-[var(--color-muted)]'
          )}
        >
          {/* The cover stands for what is PLAYING. Paused, there is nothing
              being played for it to stand for, so the Pod's own icon comes
              back and the slot reads as the Pod again. */}
          <Artwork pod={pod} artwork={playing ? (media?.artwork ?? '') : ''} />
        </button>

        {hovering && (
          // Along the bottom edge rather than across the middle: the cover is
          // what identifies the Pod, and a band over its lower third leaves the
          // part you recognise it by visible.
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-center gap-1 rounded-b-2xl bg-gradient-to-t from-black/85 via-black/70 to-transparent pt-2 pb-0.5">
            <Control
              label={playing ? 'Pause' : 'Play'}
              disabled={!hasTrack}
              onClick={() => usePodStore.getState().sendMediaCommand('playpause')}
            >
              {playing ? (
                <Pause className="h-3.5 w-3.5" fill="currentColor" />
              ) : (
                <Play className="h-3.5 w-3.5" fill="currentColor" />
              )}
            </Control>
            <Control
              label={muted ? 'Unmute' : 'Mute'}
              onClick={() => usePodStore.getState().sendMediaCommand('togglemute')}
            >
              <VolumeIcon muted={muted} volume={media?.volume ?? 1} />
            </Control>
          </div>
        )}
      </div>
    </Footer>
  )
}

/** Separated from the Pod list above by a rule, so the slot reads as its own -
 *  and that rule is what the drawer lines up with. */
const Footer = forwardRef<HTMLDivElement, { children: React.ReactNode }>(function Footer(
  { children },
  ref
) {
  return (
    <div
      ref={ref}
      className="mt-2 flex w-full shrink-0 flex-col items-center gap-1.5 border-t border-[var(--color-border)] pt-3"
    >
      {children}
    </div>
  )
})

/** Silenced, quiet or loud - the same three states the drawer's slider shows,
 *  so the two never disagree. */
function VolumeIcon({ muted, volume }: { muted: boolean; volume: number }): React.JSX.Element {
  // Silenced is RED here because it is red in the drawer, and the two show the
  // same state a few pixels apart. The literal matches `#media-drawer
  // button.on` in overlay.html rather than a Tailwind red: that palette is
  // oklch in v4, so the two would be near-identical and not the same colour.
  if (muted || volume <= 0) return <VolumeX className="h-3.5 w-3.5 text-[#f87171]" />
  return volume > 0.5 ? <Volume2 className="h-3.5 w-3.5" /> : <Volume1 className="h-3.5 w-3.5" />
}

/** The cover of what is playing, falling back to the Pod's own icon - which is
 *  also what shows while nothing is playing, see the caller. */
function Artwork({ pod, artwork }: { pod: Pod; artwork: string }): React.JSX.Element {
  if (artwork) {
    return <img src={artwork} alt="" className="h-full w-full object-cover" />
  }
  return pod.icon ? (
    <img src={pod.icon} alt="" className="h-6 w-6 rounded" />
  ) : (
    <Music className="h-5 w-5" />
  )
}

function Control({
  label,
  children,
  onClick,
  disabled = false
}: {
  label: string
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      // The scrim is click-through so it never steals the cover's own clicks;
      // the buttons opt back in.
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={cn(
        'pointer-events-auto flex h-5 w-5 items-center justify-center rounded-full transition',
        disabled ? 'text-white/30' : 'text-white hover:bg-white/20'
      )}
    >
      {children}
    </button>
  )
}
