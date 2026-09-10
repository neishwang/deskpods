import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolveInside } from '@main/git'
import type { FileEncoding, ListDirResult, ReadFileResult, WriteFileResult } from '@types'

/**
 * Reading a folder, a file, and writing one back — on behalf of a Pod's page,
 * inside the folder granted to it.
 *
 * These ride under the EXISTING git permission rather than one of their own: a
 * Pod allowed to run git in a folder can already `git ls-files`, read the
 * content of anything tracked and write the whole tree with a checkout. Asking
 * a second time for the same capability would cost a click and protect nothing.
 * The confinement to the granted folder is the same, and is the only guard.
 */

/** Beyond this a file is refused rather than loaded: the content crosses IPC as
 *  a string, and a page has no business pulling a gigabyte through it. */
const MAX_FILE_BYTES = 16 * 1024 * 1024

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isEncoding(value: unknown): value is FileEncoding {
  return value === 'utf8' || value === 'base64'
}

/**
 * One level of a folder, never recursive: a recursive walk of a drive would
 * never answer, and a caller that wants to descend knows how to call again.
 *
 * Entries are returned as they are, hidden ones included — what to keep is the
 * caller's decision, not ours.
 */
export async function listDirectory(root: string, requested?: string): Promise<ListDirResult> {
  const target = resolveInside(root, requested)
  if (!target)
    return { ok: false, entries: [], error: 'Path outside the folder granted to this Pod.' }

  try {
    const entries = await readdir(target, { withFileTypes: true })
    return {
      ok: true,
      entries: entries.map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
    }
  } catch (error) {
    return { ok: false, entries: [], error: messageOf(error) }
  }
}

/**
 * A file's content, as text by default or base64 for anything binary (an image,
 * a PDF, an archive). A missing file answers `{ ok: false }` like everything
 * else here — never an exception, because the whole caller is written that way.
 */
export async function readFileAt(
  root: string,
  requested: unknown,
  encoding: unknown = 'utf8'
): Promise<ReadFileResult> {
  if (typeof requested !== 'string' || requested.trim() === '') {
    return { ok: false, error: 'readFile expects a path relative to the granted folder.' }
  }
  if (!isEncoding(encoding)) {
    return { ok: false, error: "readFile expects encoding 'utf8' or 'base64'." }
  }

  const target = resolveInside(root, requested)
  if (!target) return { ok: false, error: 'Path outside the folder granted to this Pod.' }

  try {
    const info = await stat(target)
    if (info.isDirectory()) return { ok: false, error: 'That path is a folder, not a file.' }
    if (info.size > MAX_FILE_BYTES) {
      return { ok: false, error: `File too large (${info.size} bytes, limit ${MAX_FILE_BYTES}).` }
    }

    const content = await readFile(target, encoding)
    return { ok: true, content, size: info.size, encoding }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

/**
 * Writes a file inside the granted folder, replacing it if it exists. Missing
 * parent folders are created, but only ever under the granted root — the same
 * resolution refuses everything else.
 */
export async function writeFileAt(
  root: string,
  requested: unknown,
  content: unknown,
  encoding: unknown = 'utf8'
): Promise<WriteFileResult> {
  if (typeof requested !== 'string' || requested.trim() === '') {
    return { ok: false, error: 'writeFile expects a path relative to the granted folder.' }
  }
  if (typeof content !== 'string') {
    return { ok: false, error: 'writeFile expects the content as a string.' }
  }
  if (!isEncoding(encoding)) {
    return { ok: false, error: "writeFile expects encoding 'utf8' or 'base64'." }
  }

  const target = resolveInside(root, requested)
  if (!target) return { ok: false, error: 'Path outside the folder granted to this Pod.' }

  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, encoding)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}
