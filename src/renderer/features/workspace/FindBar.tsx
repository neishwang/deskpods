import { usePodStore } from '@renderer/features/pods/usePodStore'
import { ipc } from '@renderer/lib/ipc'
import type { FindResult } from '@types'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

const EMPTY: FindResult = { matches: 0, activeMatch: 0 }

/**
 * In-page search for the active Pod, sitting in the strip the workspace frees
 * up at the bottom. The matches themselves are highlighted by Chromium
 * (`findInPage`); this bar only carries the query, the counter and the arrows.
 *
 * It lives in the chrome rather than above the Pod because a native
 * WebContentsView always paints over the renderer — so the workspace shrinks by
 * exactly this bar's height and the bar slides up into the gap.
 */
export function FindBar(): React.JSX.Element {
  const findToken = usePodStore((s) => s.findToken)
  const closeFind = usePodStore((s) => s.closeFind)
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<FindResult>(EMPTY)

  // Focus on open, and again on every Ctrl+F: pressing it while the bar is
  // already open should let you retype straight away, as in a browser.
  // biome-ignore lint/correctness/useExhaustiveDependencies: findToken is a signal, not a value read here — re-running this effect is its only job.
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [findToken])

  useEffect(() => ipc.onFindResult(setResult), [])

  // Search as you type, like Chrome's incremental find.
  const search = (text: string) => {
    setQuery(text)
    if (!text) setResult(EMPTY)
    void ipc.findInPage(text)
  }

  /** Jump to the next/previous match of the text already being searched. */
  const step = (forward: boolean) => {
    if (!query) return
    void ipc.findInPage(query, { forward, findNext: true })
    inputRef.current?.focus()
  }

  const counter = query
    ? result.matches > 0
      ? `${result.activeMatch}/${result.matches}`
      : 'No results'
    : ''

  return (
    <div className="h-11 shrink-0 overflow-hidden">
      <div className="flex h-11 animate-slide-up items-center gap-1 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => search(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              step(!e.shiftKey)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              closeFind()
            }
          }}
          placeholder="Find in page"
          spellCheck={false}
          className="h-8 w-64 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm text-white placeholder:text-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        />

        <span
          className={cnCounter(query, result)}
          // Fixed width so the arrows don't shift as the counter changes.
          style={{ minWidth: '5.5rem' }}
        >
          {counter}
        </span>

        <FindButton label="Previous match" onClick={() => step(false)} disabled={!result.matches}>
          <ChevronUp className="h-4 w-4" />
        </FindButton>
        <FindButton label="Next match" onClick={() => step(true)} disabled={!result.matches}>
          <ChevronDown className="h-4 w-4" />
        </FindButton>
        <FindButton label="Close" onClick={closeFind}>
          <X className="h-4 w-4" />
        </FindButton>
      </div>
    </div>
  )
}

/** Muted counter, turning red-ish when the query matches nothing. */
function cnCounter(query: string, result: FindResult): string {
  const base = 'px-2 text-xs tabular-nums'
  if (query && result.matches === 0) return `${base} text-[#f87171]`
  return `${base} text-[var(--color-muted)]`
}

function FindButton({
  label,
  onClick,
  disabled = false,
  children
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-muted)] hover:bg-[var(--color-bg)] hover:text-white disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--color-muted)]"
    >
      {children}
    </button>
  )
}
