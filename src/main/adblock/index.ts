import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ElectronBlocker } from '@ghostery/adblocker-electron'
import { app, type Session } from 'electron'

/**
 * Ad and tracker blocking, per Pod session.
 *
 * IT CAN BREAK A SITE, and that is why it is asked for rather than assumed.
 * Measured on YouTube: the video area stays black and the page reports a
 * script declared twice with a stack overflow behind it. Not the request
 * blocking - every endpoint the player needs was checked and none is on a
 * list, including `youtubei/v1/player` and the `googlevideo` stream itself -
 * but the cosmetic side, which injects into the page. So a Pod that plays
 * media is a Pod where this may cost the thing the Pod is for, and it was
 * removed as a default for the music Pod after doing exactly that.
 *
 * Off by default and opt-in per Pod (`PodSettings.adblock`): most Pods - chat,
 * mail, an intranet - have no ads to block, and every filter engine costs
 * memory and a hop on each request. A Pod that does not ask pays nothing.
 *
 * ONE engine is shared by every session that turns this on: the filter set is
 * the same for all of them, and a second copy would cost another ~10 MB for
 * nothing. It is built lazily, on the first Pod that enables blocking, so an
 * app where nobody uses this never loads it at all.
 *
 * Blocking is enabled on the SESSION, so Pods sharing a partition (`linkTo`)
 * share the answer - the same way they share cookies, downloads and permission
 * grants. Enabling twice on one session is harmless; the blocker keeps one
 * blocking context per session.
 */

/**
 * Where the serialized engine is cached. Building it means fetching EasyList
 * and EasyPrivacy and parsing ~100k rules (about a second); deserializing the
 * cache is a few milliseconds. The library handles the round trip - including
 * noticing when the cache is stale or was written by another version - as long
 * as it is handed a path and a way to read and write it.
 */
const CACHE_FILE = 'adblock/engine.bin'

export class AdBlock {
  /** The in-flight or settled build. Kept as the promise, not the value, so
   *  two Pods enabling at once share one build instead of racing two. */
  private engine: Promise<ElectronBlocker> | null = null

  /** Sessions currently blocking. Electron gives no way back from a Session to
   *  its partition name, so identity is the key - which is exactly right, since
   *  linked Pods hand over the same object. */
  private readonly active = new Set<Session>()

  private build(): Promise<ElectronBlocker> {
    const path = join(app.getPath('userData'), CACHE_FILE)
    return ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path,
      read: (file) => readFile(file),
      write: async (file, buffer) => {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, buffer)
      }
    })
  }

  /**
   * Start blocking in this session. Resolves once blocking is actually on, so
   * a caller that wants the Pod to reload afterwards knows when to do it.
   *
   * A failure here (offline on the very first run, with no cache yet) leaves
   * the Pod working WITHOUT blocking rather than not working at all - the ads
   * are the lesser problem. The next attempt rebuilds.
   */
  async enable(session: Session): Promise<void> {
    if (this.active.has(session)) return
    if (!this.engine) this.engine = this.build()

    let blocker: ElectronBlocker
    try {
      blocker = await this.engine
    } catch (error) {
      // Let the next Pod (or the next toggle) try again from scratch.
      this.engine = null
      throw error
    }

    // Checked again after the await: the Pod may have been toggled back off,
    // or another session may have won the race while the engine was building.
    if (this.active.has(session)) return
    blocker.enableBlockingInSession(session)
    this.active.add(session)
  }

  /** Stop blocking in this session. Unknown sessions are simply ignored. */
  disable(session: Session): void {
    if (!this.active.delete(session)) return
    this.engine
      ?.then((blocker) => blocker.disableBlockingInSession(session))
      .catch(() => {
        // The engine never built, so nothing was ever enabled to undo.
      })
  }

  isEnabled(session: Session): boolean {
    return this.active.has(session)
  }
}
