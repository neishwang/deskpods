import { describe, expect, it } from 'vitest'
import { parseScriptResult, wrapScript } from './script'

describe('wrapScript', () => {
  it('awaits the expression, so a promise-returning API works', () => {
    expect(wrapScript("_MCS.getObject('a')")).toContain("await (_MCS.getObject('a'))")
  })

  it('keeps the caller expression as an expression', () => {
    // Parenthesised, so `a, b` or a ternary cannot break out of the wrapper.
    expect(wrapScript('1 + 1')).toContain('await (1 + 1)')
  })
})

describe('parseScriptResult', () => {
  it('reads a serialised value back', () => {
    expect(parseScriptResult({ ok: true, json: '{"a":1}' })).toEqual({ ok: true, value: { a: 1 } })
    expect(parseScriptResult({ ok: true, json: 'null' })).toEqual({ ok: true, value: null })
    expect(parseScriptResult({ ok: true, json: '[1,2]' })).toEqual({ ok: true, value: [1, 2] })
  })

  it('passes the page error through', () => {
    expect(parseScriptResult({ ok: false, error: '_MCS is not defined' })).toEqual({
      ok: false,
      error: '_MCS is not defined'
    })
  })

  it('never throws on a malformed answer', () => {
    expect(parseScriptResult(null).ok).toBe(false)
    expect(parseScriptResult(undefined).ok).toBe(false)
    expect(parseScriptResult('nope').ok).toBe(false)
    expect(parseScriptResult({ ok: true }).ok).toBe(false)
    expect(parseScriptResult({ ok: true, json: '{oops' }).ok).toBe(false)
  })
})
