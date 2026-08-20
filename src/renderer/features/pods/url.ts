/** Normalize user input into a valid URL, adding https:// when omitted.
 *  Local files (`file://`, e.g. a PDF or personal HTML) are accepted as-is —
 *  they legitimately have an empty hostname. */
export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (/^file:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).toString()
    } catch {
      return null
    }
  }
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(candidate)
    return url.hostname ? url.toString() : null
  } catch {
    return null
  }
}
