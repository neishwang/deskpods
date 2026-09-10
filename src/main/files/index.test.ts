import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { listDirectory, readFileAt, writeFileAt } from './index'

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'deskpods-files-'))
  await writeFile(join(root, 'app.json'), '{"ok":true}', 'utf8')
  await writeFileAt(root, 'sub/nested.txt', 'nested')
})

describe('listDirectory', () => {
  it('lists one level of the granted folder', async () => {
    const result = await listDirectory(root)
    expect(result.ok).toBe(true)
    expect(result.entries).toContainEqual({ name: 'app.json', directory: false })
    expect(result.entries).toContainEqual({ name: 'sub', directory: true })
  })

  it('accepts a relative sub-folder', async () => {
    const result = await listDirectory(root, 'sub')
    expect(result.entries.map((e) => e.name)).toEqual(['nested.txt'])
  })

  it('refuses climbing out, and absolute paths', async () => {
    expect((await listDirectory(root, '..')).ok).toBe(false)
    expect((await listDirectory(root, 'sub/../..')).ok).toBe(false)
    expect((await listDirectory(root, 'C:/Windows')).ok).toBe(false)
    expect((await listDirectory(root, '/etc')).ok).toBe(false)
  })

  it('answers ok:false on a missing folder rather than throwing', async () => {
    const result = await listDirectory(root, 'nope')
    expect(result.ok).toBe(false)
    expect(result.entries).toEqual([])
    expect(result.error).toBeTruthy()
  })
})

describe('readFileAt', () => {
  it('reads text by default', async () => {
    const result = await readFileAt(root, 'app.json')
    expect(result.ok).toBe(true)
    expect(result.content).toBe('{"ok":true}')
    expect(result.size).toBe(11)
  })

  it('reads base64 when asked', async () => {
    const result = await readFileAt(root, 'app.json', 'base64')
    expect(result.ok).toBe(true)
    expect(Buffer.from(result.content ?? '', 'base64').toString('utf8')).toBe('{"ok":true}')
  })

  it('refuses a path outside the granted folder', async () => {
    expect((await readFileAt(root, '../secrets.txt')).ok).toBe(false)
    expect((await readFileAt(root, 'C:/Windows/win.ini')).ok).toBe(false)
  })

  it('refuses what a page could send instead of a path', async () => {
    expect((await readFileAt(root, '')).ok).toBe(false)
    expect((await readFileAt(root, 42)).ok).toBe(false)
    expect((await readFileAt(root, 'app.json', 'latin1')).ok).toBe(false)
  })

  it('answers ok:false on a folder or a missing file', async () => {
    expect((await readFileAt(root, 'sub')).error).toBe('That path is a folder, not a file.')
    expect((await readFileAt(root, 'nope.json')).ok).toBe(false)
  })
})

describe('writeFileAt', () => {
  it('writes inside the granted folder, creating parents', async () => {
    const result = await writeFileAt(root, 'out/deep/data.json', '[1,2]')
    expect(result.ok).toBe(true)
    expect(await readFile(join(root, 'out/deep/data.json'), 'utf8')).toBe('[1,2]')
  })

  it('decodes base64 content', async () => {
    await writeFileAt(root, 'out/bin.txt', Buffer.from('bytes').toString('base64'), 'base64')
    expect(await readFile(join(root, 'out/bin.txt'), 'utf8')).toBe('bytes')
  })

  it('refuses to step outside, and refuses a non-string content', async () => {
    expect((await writeFileAt(root, '../escaped.txt', 'x')).ok).toBe(false)
    expect((await writeFileAt(root, 'C:/Windows/x.txt', 'x')).ok).toBe(false)
    expect((await writeFileAt(root, 'ok.txt', { a: 1 })).ok).toBe(false)
  })
})
