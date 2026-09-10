import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isValidArgs, resolveInside, resolveWorkingDirectory } from './index'

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

describe('resolveInside', () => {
  // A real folder tree: this is about what the filesystem does, not about
  // string arithmetic, so nothing here is mocked.
  const root = mkdtempSync(join(tmpdir(), 'deskpods-root-'))
  const outside = mkdtempSync(join(tmpdir(), 'deskpods-outside-'))
  mkdirSync(join(root, 'sub'), { recursive: true })
  writeFileSync(join(outside, 'secret.txt'), 'nope', 'utf8')

  it('accepts what lives inside the granted folder', () => {
    expect(resolveInside(root, 'sub')).toBeTruthy()
    expect(resolveInside(root)).toBeTruthy()
  })

  it('still refuses the lexical escapes', () => {
    expect(resolveInside(root, '..')).toBeNull()
    expect(resolveInside(root, 'sub/../..')).toBeNull()
    expect(resolveInside(root, outside)).toBeNull()
  })

  it('refuses a link that points out of the granted folder', () => {
    // The whole point: `relative()` sees "escape/secret.txt", which looks
    // perfectly contained, while the filesystem hands over another folder.
    symlinkSync(outside, join(root, 'escape'), 'junction')
    expect(resolveWorkingDirectory(root, 'escape')).not.toBeNull() // lexically fine…
    expect(resolveInside(root, 'escape')).toBeNull() // …and refused anyway.
    expect(resolveInside(root, 'escape/secret.txt')).toBeNull()
  })

  it('accepts a path that does not exist yet, inside the folder', () => {
    // writeFile creates files: the check has to work before they are there.
    expect(resolveInside(root, 'sub/new/file.json')).toBeTruthy()
  })
})
