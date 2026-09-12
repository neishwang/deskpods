import { basename } from 'node:path'

/**
 * What a download request from a page has to survive before Chromium sees it.
 *
 * Kept apart from `index.ts` (which owns the Electron side) so both rules can be
 * tested without an Electron runtime - the same reason `windows/hitTest.ts` sits
 * beside its window.
 */

/** The file name a page suggested, stripped of everything but the name itself:
 *  where the file goes is the user's answer to the Save dialog, never the
 *  page's. Undefined when nothing usable is left, and the download keeps the
 *  name the server gave it. */
export function suggestedName(fileName: unknown): string | undefined {
  if (typeof fileName !== 'string') return undefined
  const name = basename(fileName.trim().replace(/[\\/]+$/, '')).replace(/[\\/:*?"<>|]/g, '_')
  if (!name || name === '.' || name === '..') return undefined
  return name
}

/** True for a URL worth handing to Chromium's downloader. `blob:` and `data:`
 *  belong to the page's own context and would never resolve from main; `file://`
 *  would turn this bridge into a way to copy the disk around. */
export function isDownloadableUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0) return false
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}
