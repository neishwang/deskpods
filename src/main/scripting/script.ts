import type { ScriptResult } from '@types'

/**
 * The two pure halves of running a script in a background page, kept clear of
 * Electron so they can be tested on their own.
 */

/**
 * Wraps a caller's expression so the result comes back as JSON and a throw
 * comes back as data. Awaiting means `_MCS.getObject('a')` can return a promise
 * and the caller still receives the resolved value.
 */
export function wrapScript(code: string): string {
  return `(async () => {
  try {
    const value = await (${code});
    return { ok: true, json: JSON.stringify(value === undefined ? null : value) }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
})()`
}

/** Turns what the page returned into a ScriptResult, never throwing. */
export function parseScriptResult(raw: unknown): ScriptResult {
  const answer = raw as { ok?: boolean; json?: string; error?: string } | null
  if (!answer || typeof answer !== 'object') {
    return { ok: false, error: 'The script returned nothing usable.' }
  }
  if (!answer.ok) return { ok: false, error: answer.error ?? 'Script failed.' }
  if (typeof answer.json !== 'string') {
    return { ok: false, error: 'The script returned a value that cannot be serialised.' }
  }
  try {
    return { ok: true, value: JSON.parse(answer.json) }
  } catch {
    return { ok: false, error: 'The script returned a value that cannot be serialised.' }
  }
}
