import { stat } from 'node:fs/promises'
import { resolveInside } from '@main/git'
import type { OpenPathResult } from '@types'
import { shell } from 'electron'

/**
 * Hands a file (or folder) inside the granted folder to whatever program
 * Windows associates with it - the double-click a page cannot perform itself.
 *
 * It exists so a page need not reach for `cmd /c start "" …` through the exec
 * bridge: naming `cmd` in an allow-list allows every program there is, which is
 * a far wider grant than "open this file". Here the path is confined to the
 * granted folder the same way `readFile` is, so this is the narrower door.
 *
 * What it does NOT narrow is which program runs: that is the machine's file
 * association, unknowable here. So the caller side requires an unrestricted
 * exec grant - see the handler in ipc/index.ts.
 */
export async function openPathIn(root: string, requested: unknown): Promise<OpenPathResult> {
  if (typeof requested !== 'string' || requested.trim() === '') {
    return { ok: false, error: 'openPath expects a path relative to the granted folder.' }
  }

  const target = resolveInside(root, requested)
  if (!target) return { ok: false, error: 'Path outside the folder granted to this Pod.' }

  // Without this, a missing file reaches the shell and Windows answers with its
  // own dialog - on screen, over the Pod, with nothing for the page to read.
  try {
    await stat(target)
  } catch {
    return { ok: false, error: 'No such file or folder.' }
  }

  // openPath answers with the empty string on success, the reason otherwise -
  // it never rejects.
  const failure = await shell.openPath(target)
  if (failure) return { ok: false, error: failure }
  return { ok: true, path: target }
}
