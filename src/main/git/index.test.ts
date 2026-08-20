import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isValidArgs, resolveWorkingDirectory } from './index'

const ROOT = resolve('C:/work/repos')

describe('resolveWorkingDirectory', () => {
  it('defaults to the granted folder', () => {
    expect(resolveWorkingDirectory(ROOT)).toBe(ROOT)
  })

  it('accepts a relative sub-folder', () => {
    expect(resolveWorkingDirectory(ROOT, 'app')).toBe(resolve(ROOT, 'app'))
    expect(resolveWorkingDirectory(ROOT, 'app/api')).toBe(resolve(ROOT, 'app/api'))
  })

  it('refuses anything climbing out of the granted folder', () => {
    expect(resolveWorkingDirectory(ROOT, '..')).toBeNull()
    expect(resolveWorkingDirectory(ROOT, '../secrets')).toBeNull()
    expect(resolveWorkingDirectory(ROOT, 'app/../../secrets')).toBeNull()
  })

  it('refuses absolute paths', () => {
    expect(resolveWorkingDirectory(ROOT, 'C:/Windows')).toBeNull()
    expect(resolveWorkingDirectory(ROOT, '/etc')).toBeNull()
  })

  it('allows a sibling folder whose name merely starts like the root', () => {
    // `relative()` would return "../repos-backup", which must stay refused.
    expect(resolveWorkingDirectory(ROOT, '../repos-backup')).toBeNull()
  })
})

describe('isValidArgs', () => {
  it('accepts a non-empty array of non-empty strings', () => {
    expect(isValidArgs(['status', '--porcelain'])).toBe(true)
  })

  it('rejects anything else a page could send', () => {
    expect(isValidArgs('status')).toBe(false)
    expect(isValidArgs([])).toBe(false)
    expect(isValidArgs(['status', ''])).toBe(false)
    expect(isValidArgs(['status', 42])).toBe(false)
    expect(isValidArgs(null)).toBe(false)
    expect(isValidArgs({ 0: 'status' })).toBe(false)
  })
})
