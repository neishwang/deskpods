import { FiltersEngine } from '@ghostery/adblocker'

/**
 * Builds the filter engine OFF the main process, and hands back the bytes.
 *
 * Why it is not done in main: the build parses roughly a hundred thousand rules
 * in one synchronous pass. Not awaiting it keeps Pods from waiting, which main
 * already does, but the parse still owns the thread while it runs - so window
 * drags, native menus and every other Pod's IPC queue behind it for about a
 * second. That happens on the first launch and on every refresh of the lists,
 * which is often enough to be felt and easy enough to avoid.
 *
 * It runs in a `utilityProcess`, so this file imports `@ghostery/adblocker` and
 * NOT the Electron wrapper: `session` and `app` do not exist here, and the
 * wrapper only adds the parts that use them. The serialized form is the same
 * either way, so main deserializes these bytes straight into an
 * `ElectronBlocker` (`deserialize` is static on the engine and builds whichever
 * subclass it is called on).
 *
 * Caching is main's business, not this file's: it owns the path, the staleness
 * rule and the write. This one only builds.
 */

interface BuildRequest {
  lists: string[]
  /** Passed through rather than hardcoded, so the two sides cannot disagree
   *  about what was built. */
  loadCosmeticFilters: boolean
  loadNetworkFilters: boolean
}

process.parentPort.on('message', (event) => {
  const request = event.data as BuildRequest
  void FiltersEngine.fromLists(fetch, request.lists, {
    loadCosmeticFilters: request.loadCosmeticFilters,
    loadNetworkFilters: request.loadNetworkFilters
  })
    .then((engine) => {
      // Sent as bytes, which structured clone carries without copying them
      // through a string.
      process.parentPort.postMessage({ ok: true, engine: engine.serialize() })
    })
    .catch((error: unknown) => {
      // Reported rather than thrown: main decides whether to fall back to
      // building in-process or to leave the Pod unblocked.
      process.parentPort.postMessage({ ok: false, error: String(error) })
    })
})
