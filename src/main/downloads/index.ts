import { randomUUID } from 'node:crypto'
import { isDownloadableUrl, suggestedName } from '@main/downloads/request'
import type {
  DownloadProgress,
  DownloadResult,
  DownloadStartRequest,
  DownloadStartResult,
  PodId
} from '@types'
import { type DownloadItem, type Session, type WebContents, shell } from 'electron'

/**
 * Downloads run by a Pod's page, with the Pod's own session.
 *
 * Why this exists at all: a link opening a new window leaves DeskPods for the
 * default browser, which has its own cookies — so a file the Pod is logged in
 * for may well be a login page over there — and the page that asked for it never
 * learns where it went, or whether it arrived. Downloading here keeps the
 * session that is already authenticated, keeps the user in the app, and lets the
 * page follow the file it asked for.
 *
 * The bytes never pass through the page. A fetch into a blob would put a 300 MB
 * package in the renderer's memory to end up on a link a Pod cannot click
 * anyway; here Chromium writes to disk directly and the page only sees counters.
 *
 * Two things this deliberately does NOT do:
 *
 *  - it never chooses the destination. Electron's own Save dialog does, and a
 *    page-suggested name is stripped to its last segment before being offered;
 *  - it never adopts a download it did not start. A Pod can be any site, and
 *    `will-download` also fires for a link the user clicked or for "Save Image
 *    As…" — those keep Electron's default behaviour and are reported to nobody.
 */

/** A page in a loop must not be able to open a hundred sockets and Save
 *  dialogs; four at a time is more than any real use of this. */
const MAX_ACTIVE_PER_POD = 4

/** A 300 MB download fires `updated` constantly. The page needs a moving bar,
 *  not every chunk: state changes are always sent, progress at this cadence. */
const PROGRESS_INTERVAL_MS = 250

/** A request that never reaches `will-download` (bad host, instant 404) must
 *  not sit in the pending list for the life of the app. */
const PENDING_TIMEOUT_MS = 30_000

/** Completed paths remembered per Pod, so `reveal` has something to check
 *  against without growing without end. */
const MAX_REMEMBERED_PATHS = 64

/**
 * Stop a download, tolerating an item Chromium has already taken away.
 *
 * A DownloadItem has no `isDestroyed()` to ask, and touching one that is gone
 * throws — which is why this is the only place that calls `cancel`.
 */
function cancelItem(item: DownloadItem): void {
  try {
    if (item.getState() === 'progressing') item.cancel()
  } catch {
    // Already finished or destroyed; there is nothing left to stop.
  }
}

/** A download asked for, waiting for the session to report it has begun. */
interface PendingDownload {
  id: string
  podId: PodId
  /** The web contents the request was made from: it pairs the session event
   *  with the Pod that asked, even when Pods share a partition (`linkTo`). */
  wc: WebContents
  url: string
  /** Name the page suggested, already reduced to a bare file name. */
  fileName?: string
  at: number
  /** `cancel` reached us before the download did; drop it on arrival. */
  cancelled?: boolean
}

interface ActiveDownload {
  podId: PodId
  item: DownloadItem
  /** When the last progress event was pushed (see PROGRESS_INTERVAL_MS). */
  lastSent: number
}

export class PodDownloads {
  /** Sessions already listened to. Pods sharing a partition share a session,
   *  and one `will-download` listener is enough for both. */
  private readonly wired = new WeakSet<Session>()
  private readonly pending: PendingDownload[] = []
  private readonly active = new Map<string, ActiveDownload>()
  /** What each Pod actually downloaded: the only paths it may reveal. */
  private readonly downloaded = new Map<PodId, string[]>()

  /** Set by the IPC layer: push progress to the Pod's page. */
  onProgress?: (podId: PodId, progress: DownloadProgress) => void

  /**
   * Listen to a Pod's session, once. A download is not the answer to an invoke:
   * it arrives at the session, so this is wired where the rest of a Pod's
   * session is set up, and the request it belongs to is found here.
   */
  wire(session: Session): void {
    if (this.wired.has(session)) return
    this.wired.add(session)
    session.on('will-download', (_event, item, webContents) => this.adopt(item, webContents))
  }

  /**
   * Start a download and answer at once with our id. Waiting for the file would
   * be useless: it takes minutes, and the page has a bar to draw meanwhile.
   */
  start(podId: PodId, wc: WebContents, request: DownloadStartRequest): DownloadStartResult {
    if (!isDownloadableUrl(request?.url)) {
      return { ok: false, id: '', error: 'download expects an http(s) URL.' }
    }
    this.reapPending()
    if (this.countFor(podId) >= MAX_ACTIVE_PER_POD) {
      return {
        ok: false,
        id: '',
        error: `No more than ${MAX_ACTIVE_PER_POD} downloads at a time.`
      }
    }

    const id = randomUUID()
    this.pending.push({
      id,
      podId,
      wc,
      url: request.url,
      fileName: suggestedName(request.fileName),
      at: Date.now()
    })

    // The session event is what turns this into a real download (see `adopt`).
    wc.downloadURL(request.url)
    return { ok: true, id }
  }

  /** Stop one of this Pod's downloads. An unknown id is refused rather than
   *  silently accepted: an id belongs to the Pod that created it. */
  cancel(podId: PodId, id: unknown): DownloadResult {
    if (typeof id !== 'string' || !id) return { ok: false, error: 'cancel expects a download id.' }

    const running = this.active.get(id)
    if (running && running.podId === podId) {
      cancelItem(running.item)
      return { ok: true }
    }

    // Still on its way to `will-download`: mark it, and it is dropped the moment
    // it shows up.
    const waiting = this.pending.find((p) => p.id === id && p.podId === podId)
    if (waiting) {
      waiting.cancelled = true
      return { ok: true }
    }

    return { ok: false, error: 'Unknown download.' }
  }

  /**
   * Show a finished file in the file manager — but only one this Pod
   * downloaded. The contract the page sees is `reveal(path)`; what it may point
   * at is what it received, not any path it can name. A Pod is a web site, and a
   * web site does not get to open the file manager on someone's home folder.
   */
  reveal(podId: PodId, path: unknown): DownloadResult {
    if (typeof path !== 'string' || !path) return { ok: false, error: 'reveal expects a path.' }
    if (!this.downloaded.get(podId)?.includes(path)) {
      return { ok: false, error: 'This Pod did not download that file.' }
    }
    shell.showItemInFolder(path)
    return { ok: true }
  }

  /** Drop everything about a Pod: its permission was revoked, or it is gone. A
   *  download nobody can follow or stop any more is cancelled, not left
   *  running. */
  forget(podId: PodId): void {
    for (const [id, running] of [...this.active]) {
      if (running.podId !== podId) continue
      this.active.delete(id)
      cancelItem(running.item)
    }
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].podId === podId) this.pending.splice(i, 1)
    }
    this.downloaded.delete(podId)
  }

  disposeAll(): void {
    for (const podId of new Set([...this.active.values()].map((d) => d.podId))) this.forget(podId)
    this.pending.length = 0
    this.downloaded.clear()
  }

  /** Downloads this Pod has running or waiting to start. */
  private countFor(podId: PodId): number {
    let count = 0
    for (const running of this.active.values()) if (running.podId === podId) count++
    for (const waiting of this.pending) if (waiting.podId === podId) count++
    return count
  }

  private reapPending(): void {
    const cutoff = Date.now() - PENDING_TIMEOUT_MS
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].at < cutoff) this.pending.splice(i, 1)
    }
  }

  /**
   * Pair a download the session is starting with the request that asked for it.
   *
   * Matched on the web contents FIRST, so a Pod is never handed another Pod's
   * download even when they share a session, then on the URL — including the
   * redirect chain, since a download link usually ends up somewhere else. A
   * download with no request behind it is left to Electron (its own Save dialog)
   * and reported to nobody: the page did not ask for it.
   */
  private adopt(item: DownloadItem, webContents: WebContents | undefined): void {
    this.reapPending()
    const url = item.getURL()
    const chain = item.getURLChain()
    const mine = this.pending.filter((p) => p.wc === webContents)
    const matched =
      mine.find((p) => p.url === url || chain.includes(p.url)) ??
      // A server may answer from a URL nothing here could predict; the oldest
      // request from this very page is the only candidate left.
      mine[0]
    if (!matched) return

    this.pending.splice(this.pending.indexOf(matched), 1)
    if (matched.cancelled) {
      item.cancel()
      return
    }

    // No `setSavePath`: where a file goes is the user's answer to the Save
    // dialog, and the page's suggestion is only the name it opens with.
    item.setSaveDialogOptions({
      title: 'Save download',
      ...(matched.fileName ? { defaultPath: matched.fileName } : {})
    })

    const { id, podId } = matched
    this.active.set(id, { podId, item, lastSent: 0 })
    // Right away, so the page has a line to draw before a single byte lands.
    this.emit(id, item, true)

    item.on('updated', () => this.emit(id, item, false))
    item.once('done', (_e, state) => {
      this.active.delete(id)
      if (state === 'completed') this.remember(podId, item.getSavePath())
      this.onProgress?.(podId, {
        id,
        fileName: item.getFilename(),
        path: item.getSavePath(),
        received: item.getReceivedBytes(),
        total: item.getTotalBytes(),
        state:
          state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted'
      })
    })
  }

  /** Push progress, at most every PROGRESS_INTERVAL_MS unless `force`. */
  private emit(id: string, item: DownloadItem, force: boolean): void {
    const running = this.active.get(id)
    if (!running) return

    const now = Date.now()
    if (!force && now - running.lastSent < PROGRESS_INTERVAL_MS) return
    running.lastSent = now

    try {
      this.onProgress?.(running.podId, {
        id,
        fileName: item.getFilename(),
        // Empty while the Save dialog is still open: the page is showing a file
        // it is waiting for, not one it could find.
        path: item.getSavePath(),
        received: item.getReceivedBytes(),
        total: item.getTotalBytes(),
        state: 'progressing'
      })
    } catch {
      // The item was destroyed between the event and this read (a Pod closing
      // mid-download): there is nothing to report any more.
    }
  }

  private remember(podId: PodId, path: string): void {
    if (!path) return
    const paths = this.downloaded.get(podId) ?? []
    if (!paths.includes(path)) paths.push(path)
    if (paths.length > MAX_REMEMBERED_PATHS) paths.splice(0, paths.length - MAX_REMEMBERED_PATHS)
    this.downloaded.set(podId, paths)
  }
}
