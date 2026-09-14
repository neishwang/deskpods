import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const openPath = vi.fn<(p: string) => Promise<string>>(() => Promise.resolve(''))
vi.mock('electron', () => ({ shell: { openPath: (p: string) => openPath(p) } }))

const { openPathIn } = await import('./openPath')

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'deskpods-open-'))
  await writeFile(join(root, 'job.txucmd'), 'run', 'utf8')
})

beforeEach(() => {
  openPath.mockClear()
  openPath.mockResolvedValue('')
})

describe('openPathIn', () => {
  it('hands an existing file to the shell, resolved to its absolute path', async () => {
    const result = await openPathIn(root, 'job.txucmd')
    expect(result.ok).toBe(true)
    expect(result.path?.endsWith('job.txucmd')).toBe(true)
    expect(openPath).toHaveBeenCalledWith(result.path)
  })

  it('refuses climbing out of the granted folder, and foreign absolute paths', async () => {
    expect((await openPathIn(root, '../elsewhere.txt')).ok).toBe(false)
    expect((await openPathIn(root, 'C:Windows\notepad.exe')).ok).toBe(false)
    expect((await openPathIn(root, '/etc/passwd')).ok).toBe(false)
    expect(openPath).not.toHaveBeenCalled()
  })

  it('accepts an absolute path that still sits inside the granted folder', async () => {
    const absolute = join(root, 'job.txucmd')
    const result = await openPathIn(root, absolute)
    expect(result.ok).toBe(true)
    expect(openPath).toHaveBeenCalledWith(result.path)
  })

  it('refuses an empty or non-string path', async () => {
    expect((await openPathIn(root, '')).ok).toBe(false)
    expect((await openPathIn(root, undefined)).ok).toBe(false)
    expect(openPath).not.toHaveBeenCalled()
  })

  // Otherwise Windows answers with its own dialog, on screen, over the Pod.
  it('answers rather than letting the shell report a missing file', async () => {
    const result = await openPathIn(root, 'nope.txucmd')
    expect(result).toEqual({ ok: false, error: 'No such file or folder.' })
    expect(openPath).not.toHaveBeenCalled()
  })

  it('reports what the shell could not do', async () => {
    openPath.mockResolvedValue('No application is associated with this file.')
    const result = await openPathIn(root, 'job.txucmd')
    expect(result).toEqual({ ok: false, error: 'No application is associated with this file.' })
  })
})
