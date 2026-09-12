import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { adsAndTrackingLists, Request } from '@ghostery/adblocker'
import { ElectronBlocker } from '@ghostery/adblocker-electron'
import { app, type Session, utilityProcess } from 'electron'

/**
 * Ad and tracker blocking, per Pod session.
 *
 * NETWORK filtering only, deliberately: the cosmetic half broke YouTube's
 * player outright. See `enable` for the measurement behind that.
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

/**
 * How long a cached engine is used before the lists are fetched again.
 *
 * The library's caching has no expiry of its own: it reads the file, and only
 * falls back to downloading when that read FAILS. Left alone, the lists would
 * be frozen at whatever they were on the first run, for good - no rebuild of
 * this app would fix it, because nothing in the app carries them.
 *
 * So the read reports a stale file as unreadable, which is what sends the
 * library back to the lists. Three days matches roughly how often uBlock
 * Origin's own lists move, and the refresh costs one fetch on one launch.
 */
const MAX_CACHE_AGE_MS = 3 * 24 * 60 * 60 * 1000

/** How long the off-thread build is given before falling back. The lists come
 *  off the network with retries of their own, so this is generous. */
const WORKER_TIMEOUT_MS = 90_000

export class AdBlock {
  /** The in-flight or settled build. Kept as the promise, not the value, so
   *  two Pods enabling at once share one build instead of racing two. */
  private engine: Promise<ElectronBlocker> | null = null

  /** Sessions currently blocking. Electron gives no way back from a Session to
   *  its partition name, so identity is the key - which is exactly right, since
   *  linked Pods hand over the same object. */
  private readonly active = new Set<Session>()

  /**
   * uBlock Origin's default list set, and what to do with it.
   *
   * Its own filters (filters.txt and the yearly ones, badware, privacy,
   * quick-fixes, resource-abuse, unbreak) alongside EasyList, EasyPrivacy and
   * Peter Lowe's - the same combination uBO ships enabled. Built from the lists
   * rather than from a prebuilt engine so this config applies at parse time.
   *
   * `loadCosmeticFilters` is TRUE, and that is the point: the rules that stop
   * YouTube's ads are cosmetic ones and have to be parsed to exist at all. What
   * is switched off, later and only for the library's own use, is its way of
   * INJECTING them (see `enable`).
   */
  private static readonly CONFIG = { loadCosmeticFilters: true, loadNetworkFilters: true }

  private cacheFile(): string {
    return join(app.getPath('userData'), CACHE_FILE)
  }

  /** The cached engine, or null when there is none or it has gone stale. */
  private async fromCache(): Promise<ElectronBlocker | null> {
    try {
      const file = this.cacheFile()
      const info = await stat(file)
      if (Date.now() - info.mtimeMs > MAX_CACHE_AGE_MS) return null
      return ElectronBlocker.deserialize(await readFile(file))
    } catch {
      // Absent, unreadable, or written by another version of the library.
      return null
    }
  }

  private async toCache(bytes: Uint8Array): Promise<void> {
    try {
      const file = this.cacheFile()
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, bytes)
    } catch {
      // The engine still works; it just will not survive a restart.
    }
  }

  /**
   * Build the engine in a `utilityProcess` and bring back the bytes.
   *
   * Parsing ~100k rules is one synchronous pass. Done in main it owns the
   * thread for about a second, so window drags, native menus and every other
   * Pod's IPC queue behind it - on the first launch and on every refresh of the
   * lists. Deserializing the result here is milliseconds, so main only pays
   * that.
   *
   * Resolves null on any failure, which the caller treats as "build it here
   * instead": a Pod that asked for blocking should get it even if forking does
   * not work.
   */
  private buildOffThread(): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      let child: Electron.UtilityProcess
      try {
        child = utilityProcess.fork(join(__dirname, 'engineWorker.js'))
      } catch {
        resolve(null)
        return
      }

      let settled = false
      const finish = (bytes: Uint8Array | null) => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        try {
          child.kill()
        } catch {
          // Already gone.
        }
        resolve(bytes)
      }

      // The lists come off the network, so this can legitimately take a while -
      // but not forever, and a hung fetch must not leave a Pod unblocked with
      // nothing deciding otherwise.
      const deadline = setTimeout(() => finish(null), WORKER_TIMEOUT_MS)

      child.on('message', (message: { ok?: boolean; engine?: Uint8Array }) => {
        finish(message?.ok === true && message.engine ? message.engine : null)
      })
      child.on('exit', () => finish(null))
      child.postMessage({ lists: adsAndTrackingLists, ...AdBlock.CONFIG })
    })
  }

  private async build(): Promise<ElectronBlocker> {
    const cached = await this.fromCache()
    if (cached) return cached

    const bytes = await this.buildOffThread()
    if (bytes) {
      // Written in the background: the engine is ready, and a Pod waiting on it
      // should not also wait on the disk.
      void this.toCache(bytes)
      return ElectronBlocker.deserialize(bytes)
    }

    // Forking failed. Blocking matters more than the stall, so it is built
    // here, and the result is still cached so this happens once.
    const blocker = await ElectronBlocker.fromLists(fetch, adsAndTrackingLists, AdBlock.CONFIG)
    void this.toCache(blocker.serialize())
    return blocker
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

    /**
     * Only the NETWORK half is handed to the library, and its cosmetic
     * injection is switched off by writing the flag `enable()` reads at this
     * exact moment. The two halves are independent: network filtering
     * registers its webRequest listeners either way.
     *
     * Why, measured: that injection runs a preload in EVERY frame, each asking
     * main for that frame's filters, and main injects the answer with
     * `executeJavaScript` - which always targets the MAIN frame. On a page with
     * thirty frames the main frame therefore receives the payload thirty
     * times, its identifiers are redeclared, and the page dies of a stack
     * overflow. On YouTube that meant no player was built at all, and it was
     * not YouTube refusing an ad blocker: its enforcement dialog was nowhere
     * on the page.
     *
     * Nothing is lost by it. The cosmetic rules are still parsed and still
     * used - `cosmeticsFor` hands them over, to be injected once, by us.
     *
     * A cast because the flag is typed readonly. Only this gate is touched.
     */
    const config = blocker.config as { loadCosmeticFilters: boolean }
    config.loadCosmeticFilters = false
    blocker.enableBlockingInSession(session)
    // Put BACK, immediately. The flag does double duty: `enable()` reads it
    // once, synchronously, to decide whether to register its injection - which
    // is what the line above suppresses - and `getCosmeticsFilters` reads it on
    // every call to decide whether to answer at all. Left false, the library
    // stopped injecting AND the engine stopped handing over the rules, so
    // `cosmeticsFor` returned "not active" and the ads came straight through.
    config.loadCosmeticFilters = true
    this.active.add(session)
  }

  /** Stop blocking in this session. Unknown sessions are simply ignored. */
  disable(session: Session): void {
    if (!this.active.delete(session)) return
    const engine = this.engine
    // Released with the last Pod that wanted it. The filter set is the bulk of
    // this feature's memory, and holding it for a process where blocking is now
    // off everywhere is the cost this module's own "a Pod that does not ask
    // pays nothing" promise rules out. Coming back is a deserialize from the
    // disk cache, which is milliseconds.
    if (this.active.size === 0) this.engine = null
    engine
      ?.then((blocker) => blocker.disableBlockingInSession(session))
      .catch(() => {
        // The engine never built, so nothing was ever enabled to undo.
      })
  }

  /**
   * uBlock Origin's cosmetic rules for one page, ready to be put in it.
   *
   * This is the half the library is no longer allowed to inject (see `enable`),
   * handed over so it can be injected ONCE, into the main frame, at document
   * start. Document start is not a detail: a scriptlet that prunes ad data out
   * of a response has to be in place before the page reads that response.
   *
   * `scripts` are uBO's scriptlets with their arguments already applied -
   * this is what stops YouTube's ads, which no network rule can do because
   * they arrive through the same endpoints as the video. `styles` is the
   * stylesheet that hides what is left.
   *
   * Returns null when there is nothing to do for this page, or when the engine
   * never built - in which case network filtering is also absent and there is
   * nothing to report from here.
   */
  async cosmeticsFor(url: string): Promise<{ styles: string; scripts: string[] } | null> {
    if (!this.engine) return null
    let blocker: ElectronBlocker
    try {
      blocker = await this.engine
    } catch {
      return null
    }

    // Parsed by the engine's OWN helper, so the keys it is asked about are the
    // keys its filters were compiled under. Deriving the domain by hand -
    // taking the last two labels - is wrong for every multi-part public suffix:
    // www.bbc.co.uk gives co.uk and foo.com.au gives com.au, and domain-scoped
    // rules then miss silently on those sites, which is the one thing this
    // module exists to prevent. `Request` consults the public suffix list.
    const request = Request.fromRawDetails({ url })
    // Only pages. An about: or a file: has no rules and no ads.
    if (!request.isHttp && !request.isHttps) return null
    const { hostname, domain } = request

    const { active, styles, scripts } = blocker.getCosmeticsFilters({
      url,
      hostname,
      domain,
      // The rules that matter here: those tied to this hostname, and the
      // scriptlets. Generic hiding rules need the page's classes and ids,
      // which are not known before the document exists.
      getRulesFromHostname: true,
      getInjectionRules: true,
      getBaseRules: false,
      getRulesFromDOM: false
    })
    if (!active) return null
    if (!styles && (!scripts || scripts.length === 0)) return null
    return { styles: styles || '', scripts: scripts || [] }
  }
}
