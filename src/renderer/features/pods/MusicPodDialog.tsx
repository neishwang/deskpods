import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { MUSIC_SITES } from '@types'
import { type FormEvent, useState } from 'react'
import { type BrandMark, MUSIC_MARKS } from './musicIcons'
import { normalizeUrl } from './url'
import { usePodStore } from './usePodStore'

/**
 * The brand's own colour, unless it is too dark to be seen on the dialog's
 * surface. Tidal's mark is pure black, so using the hex as given would draw it
 * invisible; those are lifted to near-white instead of being stored under a
 * colour their owner does not use.
 *
 * Rec. 601 luma, which is enough to separate "black-ish" from "a colour".
 */
function markColor(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16)
  const luma = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
  return luma < 0.2 ? '#e2e8f0' : hex
}

/** Just the host, so a long URL does not stretch the dialog. The full one is
 *  on the button's title. */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** A service's mark, 20x20 in its own colour. Decorative: the name is right
 *  beside it, so it is hidden from assistive technology rather than repeated. */
function Mark({ mark }: { mark: BrandMark }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5 shrink-0"
      fill={markColor(mark.hex)}
      aria-hidden="true"
      focusable="false"
    >
      <path d={mark.path} />
    </svg>
  )
}

/**
 * Sets up the Pod the mini player drives.
 *
 * The service list is a shortcut, not a gate: the URL field below it takes
 * anything, so a webradio or a self-hosted server is just as valid a choice.
 * And once the Pod exists it navigates like any other - it has to, since
 * signing in to most of these services goes through a different domain
 * entirely.
 *
 * Picking a service REUSES a Pod already pointing at it (see setMusicService),
 * so emptying the slot and coming back does not cost the login.
 */
export function MusicPodDialog(): React.JSX.Element {
  const musicPodId = usePodStore((s) => s.musicPodId)
  const musicUrls = usePodStore((s) => s.musicUrls)
  const close = usePodStore((s) => s.setDialog)
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const pick = async (name: string, siteUrl: string) => {
    await usePodStore.getState().setMusicService(siteUrl, name)
    close(null)
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const normalized = normalizeUrl(url)
    if (!normalized) {
      setError('Enter a valid URL (e.g. radio.example.com).')
      return
    }
    await usePodStore.getState().setMusicService(normalized, '')
    close(null)
  }

  return (
    <Dialog open onOpenChange={(next) => !next && close(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Music Pod</DialogTitle>
          <DialogDescription>
            One Pod, driven by the player at the foot of the sidebar. Pick a service and it switches
            in place, keeping its session - so a service you used before still knows you. Open the
            Pod to sign in and choose what to play; after that the player is enough. Ad blocking is
            turned on for it.
          </DialogDescription>
          {/* Said here rather than per service: what the player can offer is
              decided by what each page chooses to report, which is not
              something this list can know in advance or promise. The controls
              themselves grey out (see MediaReport.canSeek and canVolume), and
              this explains why. */}
          <DialogDescription>
            Services differ in how much they let a player do. Some report the track and take
            play/pause but offer no next or previous, no seeking, or no volume. Whatever a service
            does not offer is greyed out rather than left there doing nothing.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2">
          {MUSIC_SITES.map((site) => (
            <button
              key={site.url}
              type="button"
              onClick={() => void pick(site.name, site.url)}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-left text-sm text-white transition hover:border-[var(--color-accent)]"
            >
              {/* The mark sits beside the name, not above it: the row stays one
                  line tall for the seven services that need no note. */}
              <span className="flex items-center gap-2">
                {MUSIC_MARKS[site.url] && <Mark mark={MUSIC_MARKS[site.url]} />}
                <span className="min-w-0 truncate">{site.name}</span>
              </span>
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="grid gap-2">
          {/* biome-ignore lint/a11y/noLabelWithoutControl: Input renders the control */}
          <label className="text-sm text-[var(--color-muted)]">Or any other URL</label>
          <div className="flex gap-2">
            <Input
              className="flex-1"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value)
                if (error) setError(null)
              }}
              placeholder="https://radio.example.com"
            />
            <Button type="submit">Use</Button>
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
        </form>

        {/* Only what was typed in by hand: the list above already offers the
            rest, and these are the ones that cost keystrokes. */}
        {musicUrls.length > 0 && (
          <div className="grid gap-2">
            <p className="text-sm text-[var(--color-muted)]">Services you added</p>
            <div className="flex flex-wrap gap-2">
              {musicUrls.map((saved) => (
                <button
                  key={saved}
                  type="button"
                  onClick={() => void pick('', saved)}
                  title={saved}
                  className="max-w-full truncate rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-muted)] transition hover:border-[var(--color-accent)] hover:text-white"
                >
                  {hostOf(saved)}
                </button>
              ))}
            </div>
          </div>
        )}

        <DialogFooter>
          {musicPodId && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                void usePodStore.getState().setMusicPod(null)
                close(null)
              }}
            >
              Empty the slot
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={() => close(null)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
