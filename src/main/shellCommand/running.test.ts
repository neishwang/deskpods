import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { RunningCommands } from './running'

const CWD = tmpdir()
const POD = 'pod-1'

let commands: RunningCommands

afterEach(() => {
  commands?.disposeAll()
})

/** Poll until the command is done (or we give up), collecting its output. */
async function drain(
  runner: RunningCommands,
  podId: string,
  id: string,
  tries = 100
): Promise<{ stdout: string; stderr: string; code?: number; error?: string }> {
  let stdout = ''
  let stderr = ''
  for (let i = 0; i < tries; i++) {
    const poll = runner.poll(podId, id)
    stdout += poll.stdout
    stderr += poll.stderr
    if (!poll.running) return { stdout, stderr, code: poll.code, error: poll.error }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return { stdout, stderr, error: 'never finished' }
}

describe('RunningCommands', () => {
  it('starts a command and hands back its output and exit code', async () => {
    commands = new RunningCommands()
    const started = commands.start(
      POD,
      'node -e "process.stdout.write(\'hi\'); process.exit(2)"',
      CWD
    )
    expect(started.ok).toBe(true)

    const result = await drain(commands, POD, started.id as string)
    expect(result.stdout.trim()).toBe('hi')
    expect(result.code).toBe(2)
  })

  it('hands each piece of output over exactly once', async () => {
    commands = new RunningCommands()
    const started = commands.start(
      POD,
      "node -e \"process.stdout.write('a'); setTimeout(() => process.stdout.write('b'), 300)\"",
      CWD
    )
    const id = started.id as string

    // Whatever arrived first must not come back on the next poll.
    await new Promise((resolve) => setTimeout(resolve, 150))
    const first = commands.poll(POD, id)
    expect(first.running).toBe(true)
    expect(first.stdout).toBe('a')

    const rest = await drain(commands, POD, id)
    expect(rest.stdout).toBe('b')
    expect(first.stdout + rest.stdout).toBe('ab')
  })

  it('writes stdin and closes it, so a command waiting for input finishes', async () => {
    commands = new RunningCommands()
    const started = commands.start(
      POD,
      "node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d.trim().toUpperCase()))\"",
      CWD,
      { stdin: 'secret' }
    )

    const result = await drain(commands, POD, started.id as string)
    expect(result.stdout).toBe('SECRET')
    expect(result.code).toBe(0)
  })

  it('kills a command that would otherwise run on', async () => {
    commands = new RunningCommands()
    const started = commands.start(POD, 'node -e "setInterval(() => {}, 1000)"', CWD)
    const id = started.id as string

    expect(commands.poll(POD, id).running).toBe(true)
    expect(commands.kill(POD, id).ok).toBe(true)

    const result = await drain(commands, POD, id)
    expect(result.code).toBeDefined()
  }, 20_000)

  it('stops a command that outstays its timeout', async () => {
    commands = new RunningCommands()
    const started = commands.start(POD, 'node -e "setInterval(() => {}, 1000)"', CWD, {
      timeout: 1000
    })

    const result = await drain(commands, POD, started.id as string)
    expect(result.error).toBeTruthy()
    expect(result.error).not.toBe('never finished')
  }, 20_000)

  it('refuses a handle that belongs to another Pod', async () => {
    commands = new RunningCommands()
    const started = commands.start(POD, 'node -e "0"', CWD)
    const id = started.id as string

    expect(commands.poll('pod-2', id).error).toBe('Unknown command.')
    expect(commands.kill('pod-2', id).ok).toBe(false)
    // The real owner is unaffected.
    expect(commands.poll(POD, id).ok).toBe(true)
  })

  it('answers ok:false on an unknown or malformed handle', () => {
    commands = new RunningCommands()
    expect(commands.poll(POD, 'nope').ok).toBe(false)
    expect(commands.poll(POD, 42).ok).toBe(false)
    expect(commands.poll(POD, undefined).ok).toBe(false)
    expect(commands.kill(POD, 'nope').ok).toBe(false)
  })

  it('caps how many a single Pod may run at once', () => {
    commands = new RunningCommands()
    const idle = 'node -e "setInterval(() => {}, 1000)"'
    for (let i = 0; i < 4; i++) {
      expect(commands.start(POD, idle, CWD).ok).toBe(true)
    }
    const extra = commands.start(POD, idle, CWD)
    expect(extra.ok).toBe(false)
    expect(extra.error).toMatch(/already has/)

    // Another Pod is not held back by the first one's commands.
    expect(commands.start('pod-2', idle, CWD).ok).toBe(true)
  })

  it('drops everything a Pod started when it loses access', async () => {
    commands = new RunningCommands()
    const started = commands.start(POD, 'node -e "setInterval(() => {}, 1000)"', CWD)
    const id = started.id as string

    commands.killAllFor(POD)
    expect(commands.poll(POD, id).ok).toBe(false)
  })
})
