import { exec } from 'node:child_process'
import { basename } from 'node:path'
import type { GitResult } from '@types'

/**
 * Runs an arbitrary command line on behalf of a Pod's page, once the user has
 * granted that Pod the `exec` permission (see PodExecAccess).
 *
 * This is deliberately NOT the git bridge. git is one program; a shell is every
 * program. The working directory is confined to the granted folder the same
 * way, but confinement buys little here: a command line can name an absolute
 * path of its own. The guard rail is therefore the permission itself, and — by
 * default — the allow-list of program names the user agreed to.
 */

/** Same bound as git: long enough for a real build, short enough that a wedged
 *  command cannot hang the page's promise forever. */
const TIMEOUT_MS = 120_000

/** Callers may ask for more or less, within these bounds. */
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 600_000

/** A chatty command must not fill the main process's memory; beyond this the
 *  child is killed. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

/**
 * Characters that chain a second command onto the first. When the Pod holds an
 * allow-list, they are refused outright: `dotnet & del /f C:\x` starts with an
 * allowed name and is not an allowed command.
 */
const SHELL_OPERATORS = /[&|;<>`\n\r]|\$\(/

/** True when the page sent something that can be run at all. */
export function isValidCommand(command: unknown): command is string {
  return typeof command === 'string' && command.trim().length > 0
}

/**
 * The program a command line invokes, normalised for comparison: first token
 * (quoted or not), without its folder or `.exe`/`.cmd`/`.bat` suffix, lowercased.
 * Returns an empty string when there is nothing to run.
 */
export function commandName(command: string): string {
  const line = command.trim()
  if (!line) return ''

  const quoted = line.match(/^"([^"]*)"/)
  const token = quoted ? quoted[1] : line.split(/\s+/)[0]
  return basename(token)
    .replace(/\.(exe|cmd|bat|com|ps1)$/i, '')
    .toLowerCase()
}

/**
 * Whether a Pod holding `allow` may run this command line.
 *
 * An absent or empty list means the user allowed every command, so anything
 * passes. With a list, both the program name AND the absence of shell operators
 * are required — otherwise the list would only decide how a command line
 * starts, not what it does.
 */
export function isAllowedCommand(command: string, allow?: string[]): boolean {
  if (!allow || allow.length === 0) return true
  if (SHELL_OPERATORS.test(command)) return false

  const name = commandName(command)
  return name.length > 0 && allow.includes(name)
}

export function runCommand(command: string, cwd: string, timeout?: number): Promise<GitResult> {
  const limit = Math.min(Math.max(timeout ?? TIMEOUT_MS, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)

  return new Promise((done) => {
    exec(
      command,
      {
        cwd,
        timeout: limit,
        maxBuffer: MAX_OUTPUT_BYTES,
        // Without this a black console window blinks on every call.
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (!error) {
          done({ ok: true, code: 0, stdout, stderr })
          return
        }

        // A number means the command ran and exited non-zero, which is a normal
        // answer the caller reads itself (a failing build, a test suite in the
        // red). Anything else means it never ran properly: unknown program,
        // timeout, output too large.
        const code = (error as NodeJS.ErrnoException & { code?: number | string }).code
        if (typeof code === 'number') {
          done({ ok: false, code, stdout, stderr })
          return
        }

        done({ ok: false, code: -1, stdout, stderr, error: error.message })
      }
    )
  })
}
