import { execFile } from 'node:child_process'
import { isAbsolute, relative, resolve } from 'node:path'
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
