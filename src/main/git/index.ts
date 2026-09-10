import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { GitResult } from '@types'

/**
 * Runs git on behalf of a Pod's page, once the user has granted that Pod access
 * to a folder (see PodGitAccess).
 *
 * Every command git accepts is allowed: the guard rail is the folder, not the
 * command. Two things are enforced regardless:
 *   - arguments travel as an ARRAY straight to `execFile`, so no shell parses
 *     them and nothing in a page's string can inject a second command;
 *   - the working directory can never leave the granted folder.
 */

/** Long enough for a real push over a slow link, short enough that a wedged
 *  command cannot hang the page's promise forever. */
const TIMEOUT_MS = 120_000

/** A `git log` on a big repository can be large; beyond this git is killed. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

/**
 * Working directory for a request, or null when it would escape `root`.
 * Only relative paths are accepted, and the result must still sit inside the
 * granted folder once resolved (so `..`, symlink-ish tricks and absolute paths
 * are all refused).
 */
export function resolveWorkingDirectory(root: string, requested?: string): string | null {
  if (!requested) return root
  if (isAbsolute(requested)) return null

  const target = resolve(root, requested)
  const inside = relative(root, target)
  if (inside.startsWith('..') || isAbsolute(inside)) return null
  return target
}

/**
 * Real path of `p`, resolved as far as it exists. A path that is not there yet
 * (a file about to be written) still has to be checked against the links on the
 * way to it, so the deepest existing ancestor is resolved and the rest appended.
 */
function realPathOf(p: string): string {
  let current = p
  const trail: string[] = []
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return trail.length > 0 ? join(real, ...trail.reverse()) : real
    } catch {
      const parent = dirname(current)
      // Nothing along this path exists (or none of it can be read): the lexical
      // answer is the best we have, and it was already checked.
      if (parent === current) return p
      trail.push(basename(current))
      current = parent
    }
  }
}

/**
 * The path a request may actually touch, or null when it would leave `root`.
 *
 * THIS is what every caller must use; `resolveWorkingDirectory` alone compares
 * strings, and a junction or symlink sitting inside the granted folder points
 * wherever it likes without the string ever saying so. Both ends are resolved
 * to their real location before being compared, and the real path is what comes
 * back, so the link is not walked a second time.
 */
export function resolveInside(root: string, requested?: string): string | null {
  const lexical = resolveWorkingDirectory(root, requested)
  if (!lexical) return null

  const realRoot = realPathOf(root)
  const realTarget = realPathOf(lexical)
  const inside = relative(realRoot, realTarget)
  if (inside.startsWith('..') || isAbsolute(inside)) return null
  return realTarget
}

/** True when the page sent something that can be handed to git as arguments. */
export function isValidArgs(args: unknown): args is string[] {
  return (
    Array.isArray(args) &&
    args.length > 0 &&
    args.every((arg) => typeof arg === 'string' && arg.length > 0)
  )
}

export function runGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((done) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        env: {
          ...process.env,
          // There is no terminal to answer on: without this, a command needing
          // credentials would block until the timeout with nothing on screen.
          GIT_TERMINAL_PROMPT: '0',
          // Never hand output to a pager, which would never exit here.
          GIT_PAGER: 'cat'
        }
      },
      (error, stdout, stderr) => {
        if (!error) {
          done({ ok: true, code: 0, stdout, stderr })
          return
        }

        // A number means git ran and exited non-zero, which is a normal answer
        // (nothing to commit, merge conflict…). Anything else means it never
        // ran properly: git missing from PATH, timeout, output too large.
        const code = (error as NodeJS.ErrnoException & { code?: number | string }).code
        if (typeof code === 'number') {
          done({ ok: false, code, stdout, stderr })
          return
        }

        done({
          ok: false,
          code: -1,
          stdout,
          stderr,
          error: error.message
        })
      }
    )
  })
}
