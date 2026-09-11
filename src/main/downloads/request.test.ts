import { describe, expect, it } from 'vitest'
import { isDownloadableUrl, suggestedName } from './request'

describe('isDownloadableUrl', () => {
  it('accepts http and https', () => {
    expect(isDownloadableUrl('https://txsms.example/pack.zip')).toBe(true)
    expect(isDownloadableUrl('http://localhost:5173/pack.zip')).toBe(true)
  })

  it('refuses what Chromium could not download from main, or should not', () => {
    // A blob belongs to the page's own context; file:// would make this bridge a
    // way to copy the disk around.
    expect(isDownloadableUrl('blob:https://txsms.example/1234')).toBe(false)
    expect(isDownloadableUrl('data:text/plain,hi')).toBe(false)
    expect(isDownloadableUrl('file:///C:/Windows/System32/config/SAM')).toBe(false)
    expect(isDownloadableUrl('not a url')).toBe(false)
    expect(isDownloadableUrl('')).toBe(false)
    expect(isDownloadableUrl(null)).toBe(false)
  })
})

describe('suggestedName', () => {
  it('keeps a plain file name', () => {
    expect(suggestedName('refresh-2026-09.zip')).toBe('refresh-2026-09.zip')
    expect(suggestedName('  pack.7z  ')).toBe('pack.7z')
  })

  it('keeps only the name: a page does not choose the folder', () => {
    expect(suggestedName('C:\\Windows\\System32\\evil.exe')).toBe('evil.exe')
    expect(suggestedName('../../../etc/passwd')).toBe('passwd')
    expect(suggestedName('sub/dir/pack.zip')).toBe('pack.zip')
    // A trailing separator leaves a bare name, which is a fine suggestion.
    expect(suggestedName('sub/dir/')).toBe('dir')
  })

  it('replaces what a file name may not contain', () => {
    expect(suggestedName('pa:ck?<>.zip')).toBe('pa_ck___.zip')
  })

  it('gives up rather than suggest nonsense', () => {
    expect(suggestedName('')).toBeUndefined()
    expect(suggestedName('   ')).toBeUndefined()
    expect(suggestedName('..')).toBeUndefined()
    expect(suggestedName(42)).toBeUndefined()
  })
})
