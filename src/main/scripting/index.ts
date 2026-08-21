import { randomUUID } from 'node:crypto'
import { parseScriptResult, wrapScript } from '@main/scripting/script'
import type { OpenPageOptions, OpenPageResult, PodId, ScriptResult } from '@types'
import { BrowserWindow } from 'electron'

/**
 * Background pages a Pod can drive like an API: open a site once, run several
 * scripts against that same loaded document, read the results, close it.
 *
 * The page is a hidden window on the CALLING POD'S partition, so it carries
 * that Pod's login — which is the point, and also why the capability sits
 * behind a per-Pod permission. It gets no preload, so the site being driven
 * never sees a DeskPods bridge of its own.
 *
 * Scripts run in the page's own world (not an isolated one), so globals the
 * site defines — `_MCS` and friends — are reachable.
 */

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
/** A page a caller forgot to close is dropped after this long without use. */
const IDLE_MS = 5 * 60_000
/** Guard against a runaway loop opening pages without end. */
const MAX_PAGES_PER_POD = 4

interface BackgroundPage {
  id: string
  podId: PodId
  window: BrowserWindow
  idleTimer: NodeJS.Timeout
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class BackgroundPages {
  private readonly pages = new Map<string, BackgroundPage>()

  private touch(page: BackgroundPage): void {
    clearTimeout(page.idleTimer)
    page.idleTimer = setTimeout(() => this.close(page.podId, page.id), IDLE_MS)
  }

  private get(podId: PodId, id: string): BackgroundPage | null {
    const page = this.pages.get(id)
    // A handle only works for the Pod that opened it.
    if (!page || page.podId !== podId || page.window.isDestroyed()) return null
    return page
  }

  async open(
    podId: PodId,
    profile: string,
    url: string,
    options?: OpenPageOptions
  ): Promise<OpenPageResult> {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      return { ok: false, error: `Not a valid URL: ${url}` }
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      return { ok: false, error: `Unsupported protocol: ${target.protocol}` }
    }

    const open = [...this.pages.values()].filter((p) => p.podId === podId)
    if (open.length >= MAX_PAGES_PER_POD) {
      return {
        ok: false,
        error: `This Pod already has ${MAX_PAGES_PER_POD} background pages open; close one first.`
      }
    }

    const timeout = Math.min(Math.max(options?.timeout ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS)
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        partition: `persist:${profile}`,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // A hidden window is throttled hard by Chromium, which would stall the
        // very timers the target site needs to finish setting itself up.
        backgroundThrottling: false
      }
    })

    const deadline = Date.now() + timeout
    try {
      await withTimeout(window.loadURL(url), timeout, 'Timed out loading the page.')

      if (options?.waitFor) {
        await this.waitFor(window, options.waitFor, deadline)
      }
    } catch (error) {
      window.destroy()
      return { ok: false, error: messageOf(error) }
    }

    const id = randomUUID()
    const page: BackgroundPage = {
      id,
      podId,
      window,
      idleTimer: setTimeout(() => this.close(podId, id), IDLE_MS)
    }
    this.pages.set(id, page)

    // If the site closes itself (window.close), forget the handle.
    window.on('closed', () => {
      clearTimeout(page.idleTimer)
      this.pages.delete(id)
    })

    return { ok: true, id, url: window.webContents.getURL() }
  }

  /** Poll an expression in the page until it turns truthy or time runs out. */
  private async waitFor(
    window: BrowserWindow,
    expression: string,
    deadline: number
  ): Promise<void> {
    while (Date.now() < deadline) {
      if (window.isDestroyed()) throw new Error('The page was closed while waiting for it.')
      const ready = await window.webContents
        .executeJavaScript(`!!(${expression})`)
        .catch(() => false)
      if (ready === true) return
      await sleep(100)
    }
    throw new Error(`Timed out waiting for: ${expression}`)
  }

  async run(podId: PodId, id: string, code: string): Promise<ScriptResult> {
    const page = this.get(podId, id)
    if (!page) return { ok: false, error: 'Unknown page handle; it may have been closed.' }
    if (typeof code !== 'string' || code.trim() === '') {
      return { ok: false, error: 'runScript expects a non-empty string of JavaScript.' }
    }
    this.touch(page)

    try {
      const raw = await page.window.webContents.executeJavaScript(wrapScript(code), true)
      return parseScriptResult(raw)
    } catch (error) {
      // Thrown when the page navigated away mid-script, or the world went away.
      return { ok: false, error: messageOf(error) }
    }
  }

  close(podId: PodId, id: string): void {
    const page = this.get(podId, id)
    if (!page) return
    clearTimeout(page.idleTimer)
    this.pages.delete(id)
    page.window.destroy()
  }

  /** Drop every page a Pod opened — it was deleted, suspended, or lost access. */
  closeAllFor(podId: PodId): void {
    for (const page of [...this.pages.values()]) {
      if (page.podId !== podId) continue
      clearTimeout(page.idleTimer)
      this.pages.delete(page.id)
      if (!page.window.isDestroyed()) page.window.destroy()
    }
  }

  disposeAll(): void {
    for (const page of [...this.pages.values()]) {
      clearTimeout(page.idleTimer)
      if (!page.window.isDestroyed()) page.window.destroy()
    }
    this.pages.clear()
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
