import { type ChildProcess, exec, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { ExecPollResult, ExecStartResult, PodId } from '@types'

/**
 * Commands that outlive a single answer: an agent session, a long build, a
 * deployment script. `runCommand` waits and resolves once; these are started,
 * followed while they run, and killed if need be.
 *
 * The page polls rather than subscribing: it keeps the whole Pod bridge in one
 * invoke-and-answer style, lets the caller choose its own cadence, and — the
 * reason that matters — a page that reloads mid-command finds it again by id
 * instead of losing an event stream.
 *
 * Output is buffered here between polls and handed over once, so a page that
 * polls every second sees each second's output exactly once.
 */

/** No command runs forever unattended; the caller may ask for less or more. */
const DEFAULT_TIMEOUT_MS = 30 * 60_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 24 * 60 * 60_000

/** Unread output kept per stream. Past this the OLDEST is dropped and the poll
 *  says so, rather than letting a chatty command grow the main process. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024

/** A finished command nobody collects is forgotten after this long. */
const REAP_MS = 10 * 60_000

/** Guard against a runaway loop starting commands without end. */
const MAX_COMMANDS_PER_POD = 4

interface RunningCommand {
  id: string
  podId: PodId
  child: ChildProcess
  stdout: string
  stderr: string
  /** Output was dropped because nobody polled fast enough. */
  truncated: boolean
  running: boolean
  code?: number
  error?: string
  timeoutTimer?: NodeJS.Timeout
  reapTimer?: NodeJS.Timeout
}

/** Append to a buffer, dropping the oldest once it is full. */
function append(buffer: string, chunk: string): { text: string; dropped: boolean } {
  const text = buffer + chunk
  if (text.length <= MAX_BUFFERED_BYTES) return { text, dropped: false }
  return { text: text.slice(text.length - MAX_BUFFERED_BYTES), dropped: true }
}

export class RunningCommands {
  private readonly commands = new Map<string, RunningCommand>()

  /** A handle only ever works for the Pod that created it. */
  private get(podId: PodId, id: unknown): RunningCommand | null {
    if (typeof id !== 'string') return null
    const command = this.commands.get(id)
    return command && command.podId === podId ? command : null
  }

  private finish(command: RunningCommand, code: number, error?: string): void {
    if (!command.running) return
    command.running = false
    command.code = code
    if (error) command.error = error
    if (command.timeoutTimer) clearTimeout(command.timeoutTimer)
    // Keep the result around for a while: the page is entitled to one last poll
    // carrying the exit code and whatever was printed just before the end.
    command.reapTimer = setTimeout(() => this.commands.delete(command.id), REAP_MS)
    command.reapTimer.unref()
  }

  /**
   * Kill a process and everything it spawned. On Windows killing the shell
   * leaves its children running, which for an agent or a build means the work
   * carries on unseen — `taskkill /T` is the only reliable way down the tree.
   */
  private terminate(command: RunningCommand): void {
    const pid = command.child.pid
    if (pid === undefined) return
    if (process.platform === 'win32') {
      exec(`taskkill /pid ${pid} /T /F`, { windowsHide: true }, () => {
        // Already gone, or never started; either way there is nothing to do.
      })
    } else {
      try {
        command.child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }
  }

  start(
    podId: PodId,
    command: string,
    cwd: string,
    options?: { timeout?: number; stdin?: string }
  ): ExecStartResult {
    const live = [...this.commands.values()].filter((c) => c.podId === podId && c.running)
    if (live.length >= MAX_COMMANDS_PER_POD) {
      return { ok: false, error: `This Pod already has ${MAX_COMMANDS_PER_POD} commands running.` }
    }

    const id = randomUUID()
    let child: ChildProcess
    try {
      child = spawn(command, { cwd, shell: true, windowsHide: true })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }

    const entry: RunningCommand = {
      id,
      podId,
      child,
      stdout: '',
      stderr: '',
      truncated: false,
      running: true
    }
    this.commands.set(id, entry)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      const { text, dropped } = append(entry.stdout, chunk)
      entry.stdout = text
      if (dropped) entry.truncated = true
    })
    child.stderr?.on('data', (chunk: string) => {
      const { text, dropped } = append(entry.stderr, chunk)
      entry.stderr = text
      if (dropped) entry.truncated = true
    })

    // Secrets belong here rather than in the command line: a master password
    // written to stdin is never in the permission dialog, and never in the
    // machine's process list. Closing the stream matters — a tool waiting for
    // more input would sit there until the timeout.
    if (options?.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        // The command may not read stdin at all; a broken pipe is not an error.
      })
      child.stdin.end(options.stdin)
    } else {
      child.stdin?.end()
    }

    child.on('error', (error) => this.finish(entry, -1, error.message))
    child.on('close', (code, signal) => {
      if (signal) this.finish(entry, -1, `Killed (${signal}).`)
      else this.finish(entry, code ?? -1)
    })

    const limit = Math.min(
      Math.max(options?.timeout ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
      MAX_TIMEOUT_MS
    )
    entry.timeoutTimer = setTimeout(() => {
      if (!entry.running) return
      entry.error = `Timed out after ${limit} ms.`
      this.terminate(entry)
    }, limit)
    entry.timeoutTimer.unref()

    return { ok: true, id }
  }

  /** Everything printed since the previous poll, plus how the command is doing. */
  poll(podId: PodId, id: unknown): ExecPollResult {
    const command = this.get(podId, id)
    if (!command) {
      return { ok: false, running: false, stdout: '', stderr: '', error: 'Unknown command.' }
    }

    const stdout = command.stdout
    const stderr = command.stderr
    const truncated = command.truncated
    command.stdout = ''
    command.stderr = ''
    command.truncated = false

    return {
      ok: true,
      running: command.running,
      stdout,
      stderr,
      ...(truncated ? { truncated } : {}),
      ...(command.running ? {} : { code: command.code ?? -1 }),
      ...(command.error ? { error: command.error } : {})
    }
  }

  kill(podId: PodId, id: unknown): { ok: boolean; error?: string } {
    const command = this.get(podId, id)
    if (!command) return { ok: false, error: 'Unknown command.' }
    if (command.running) this.terminate(command)
    return { ok: true }
  }

  /** Drop everything a Pod started — it was deleted, suspended, or lost access. */
  killAllFor(podId: PodId): void {
    for (const command of [...this.commands.values()]) {
      if (command.podId !== podId) continue
      if (command.running) this.terminate(command)
      if (command.timeoutTimer) clearTimeout(command.timeoutTimer)
      if (command.reapTimer) clearTimeout(command.reapTimer)
      this.commands.delete(command.id)
    }
  }

  disposeAll(): void {
    for (const command of [...this.commands.values()]) {
      if (command.running) this.terminate(command)
      if (command.timeoutTimer) clearTimeout(command.timeoutTimer)
      if (command.reapTimer) clearTimeout(command.reapTimer)
    }
    this.commands.clear()
  }
}
