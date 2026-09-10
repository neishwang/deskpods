import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { commandName, isAllowedCommand, isValidCommand, runCommand } from './index'

describe('isValidCommand', () => {
  it('accepts a non-empty command line', () => {
    expect(isValidCommand('git --version')).toBe(true)
  })

  it('rejects anything else a page could send', () => {
    expect(isValidCommand('')).toBe(false)
    expect(isValidCommand('   ')).toBe(false)
    expect(isValidCommand(['git'])).toBe(false)
    expect(isValidCommand(null)).toBe(false)
  })
})

describe('commandName', () => {
  it('is the first token, normalised', () => {
    expect(commandName('dotnet build -c Release')).toBe('dotnet')
    expect(commandName('  NPM  install ')).toBe('npm')
  })

  it('drops the folder and the executable suffix', () => {
    expect(commandName('C:\\tools\\7z.exe a out.zip')).toBe('7z')
    expect(commandName('/usr/bin/node script.js')).toBe('node')
    expect(commandName('build.cmd')).toBe('build')
  })

  it('reads a quoted path as one token', () => {
    expect(commandName('"C:\\Program Files\\dotnet\\dotnet.exe" build')).toBe('dotnet')
  })

  it('is empty when there is nothing to run', () => {
    expect(commandName('   ')).toBe('')
  })
})

describe('isAllowedCommand', () => {
  it('allows everything when no list was set', () => {
    expect(isAllowedCommand('del /f C:\\x')).toBe(true)
    expect(isAllowedCommand('del /f C:\\x', [])).toBe(true)
  })

  it('allows a listed program', () => {
    expect(isAllowedCommand('dotnet build -c Release', ['dotnet', 'npm'])).toBe(true)
  })

  it('refuses an unlisted one', () => {
    expect(isAllowedCommand('del /f C:\\x', ['dotnet'])).toBe(false)
  })

  it('refuses a listed program chaining a second command', () => {
    // The case that matters: the list decides what runs, not how a line starts.
    expect(isAllowedCommand('dotnet & del /f C:\\x', ['dotnet'])).toBe(false)
    expect(isAllowedCommand('dotnet build && del /f C:\\x', ['dotnet'])).toBe(false)
    expect(isAllowedCommand('dotnet build | more', ['dotnet'])).toBe(false)
    expect(isAllowedCommand('dotnet build > out.txt', ['dotnet'])).toBe(false)
    expect(isAllowedCommand('dotnet build; rm -rf /', ['dotnet'])).toBe(false)
    expect(isAllowedCommand('dotnet $(whoami)', ['dotnet'])).toBe(false)
    expect(isAllowedCommand('dotnet `whoami`', ['dotnet'])).toBe(false)
    expect(isAllowedCommand('dotnet build\ndel /f C:\\x', ['dotnet'])).toBe(false)
  })
})

describe('runCommand', () => {
  const cwd = tmpdir()

  it('reports the exit code of a failing command instead of throwing', async () => {
    const result = await runCommand(process.platform === 'win32' ? 'cmd /c exit 3' : 'exit 3', cwd)
    expect(result.ok).toBe(false)
    expect(result.code).toBe(3)
    expect(result.error).toBeUndefined()
  })

  it('hands back stdout on success', async () => {
    const result = await runCommand('node -e "process.stdout.write(\'hi\')"', cwd)
    expect(result.ok).toBe(true)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('hi')
  })

  it('writes stdin and closes it, so a command waiting for input finishes', async () => {
    const result = await runCommand(
      "node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d.trim().toUpperCase()))\"",
      cwd,
      10_000,
      'secret'
    )
    expect(result.ok).toBe(true)
    expect(result.stdout).toBe('SECRET')
  })

  it('closes stdin even when nothing was given, so nothing waits on it', async () => {
    const result = await runCommand(
      "node -e \"process.stdin.on('end',()=>process.stdout.write('done'));process.stdin.resume()\"",
      cwd,
      10_000
    )
    expect(result.ok).toBe(true)
    expect(result.stdout).toBe('done')
  })

  it('fails with an error when the timeout runs out', async () => {
    const result = await runCommand('node -e "setTimeout(() => {}, 5000)"', cwd, 1000)
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })
})
