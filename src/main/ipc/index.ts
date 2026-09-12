import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AdBlock } from '@main/adblock'
import { PodDownloads } from '@main/downloads'
import { listDirectory, readFileAt, writeFileAt } from '@main/files'
import { isValidArgs, resolveInside, runGit } from '@main/git'
import { cleanTitle, setTaskbarBadge, titleUnreadCount } from '@main/notifications'
import { saveState } from '@main/persistence/store'
import type { PodManager } from '@main/pods/PodManager'
import { BackgroundPages } from '@main/scripting'
import { commandName, isAllowedCommand, isValidCommand, runCommand } from '@main/shellCommand'
import { openPathIn } from '@main/shellCommand/openPath'
import { RunningCommands } from '@main/shellCommand/running'
import { createHitAreaTracker } from '@main/windows/overlayWindow'
import {
  type AppState,
  type CreatePodInput,
  type DownloadResult,
  type DownloadStartRequest,
  type DownloadStartResult,
  type ExecHandleRequest,
  type ExecKillResult,
  type ExecPollResult,
  type ExecRequest,
  type ExecStartResult,
  type FindOptions,
  type Folder,
  type FolderId,
  type FolderPatch,
  type FolderPlacement,
  type GitRequest,
  type GitResult,
  IpcChannels,
  type ListDirRequest,
  type ListDirResult,
  type MediaAction,
  type MediaCommand,
  type MediaInfo,
  type MediaReport,
  MUSIC_SITES,
  type OpenPageOptions,
  type OpenPageResult,
  type OpenPathRequest,
  type OpenPathResult,
  type OverlayToast,
  type Pod,
  type PodExecAccess,
  type PodGitAccess,
  type PodId,
  type PodPatch,
  type PodPlacement,
  type ReadFileRequest,
  type ReadFileResult,
  type Rect,
  type ScriptResult,
  type TooltipPayload,
  type UiCommand,
  type WriteFileRequest,
  type WriteFileResult
} from '@types'
import {
  app,
  type BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions
} from 'electron'

/** How many hand-typed music services are kept (see AppState.musicUrls). A
 *  shortcut, not a history: enough to cover the ones actually reused. */
const MAX_REMEMBERED_MUSIC_URLS = 5

/** Preset folder colours offered in the native context menu. */
const FOLDER_COLORS = [
  '#6d6dff',
  '#ef4444',
  '#f59e0b',
  '#10b981',
  '#3b82f6',
  '#a855f7',
  '#ec4899',
  '#64748b'
]

/**
 * Initial Pod name derived from the URL: the main domain label between the
 * protocol and the TLD (e.g. https://mail.google.com -> "Google"). Replaced by
 * the real page title once the Pod loads.
 */
function defaultNameFromUrl(url: string): string {
  try {
    if (/^file:\/\//i.test(url)) {
      const name = basename(fileURLToPath(url))
      return name || url
    }
    const host = new URL(url).hostname.replace(/^www\./i, '')
    const parts = host.split('.')
    const core = parts.length >= 2 ? parts[parts.length - 2] : parts[0]
    return core ? core.charAt(0).toUpperCase() + core.slice(1) : host
  } catch {
    return url
  }
}

/**
 * Registers every IPC handler. Holds the authoritative AppState in the main
 * process; the renderer is a view over it.
 */
export function registerIpc(
  pods: PodManager,
  window: BrowserWindow,
  overlay: BrowserWindow | null,
  state: AppState
): AppState {
  pods.setPods(state.pods)
  pods.setMusicPod(state.musicPodId ?? null)

  // Pods whose name was auto-derived and may still be replaced by the first
  // page title. Cleared once the title is applied so the sidebar name stops
  // following later title changes (e.g. unread counters).
  const autoNamed = new Set<PodId>()

  const persist = () => {
    saveState(state)
    pods.setPods(state.pods)
  }
  const send = (channel: string, payload: unknown) => {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }

  /**
   * These channels answer the DeskPods chrome and its overlay, nobody else.
   *
   * A Pod's page cannot reach them today - it is sandboxed and context-isolated,
   * and its preload exposes `__deskpods` and nothing more - so this is the belt
   * that keeps it true if a preload ever grows. Everything a Pod IS allowed to
   * ask for goes through `wc.ipc` on its own web contents, which carries the
   * Pod it came from.
   */
  const fromApp = (event: IpcMainInvokeEvent): boolean =>
    event.sender === window.webContents || event.sender === overlay?.webContents

  const handle = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: never[]) => unknown
  ): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!fromApp(event)) return { ok: false, error: 'Refused: not the DeskPods chrome.' }
      return (listener as (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown)(event, ...args)
    })
  }

  // --- unread notifications (runtime only; never persisted) ---
  // Unread is DERIVED from each Pod's latest title: the count in "(2) Discord"
  // is the source of truth, so the badge persists even while that Pod is active
  // and clears only once the web app itself drops the count (i.e. once you've
  // actually read it). A Notification raised by an app that doesn't put a count
  // in its title contributes 1 until you view that Pod (its only "read" signal).
  //
  // Everything is EVENT-driven - `page-title-updated` (via onMeta), captured
  // notifications, Pod activation and window focus. No polling: an idle
  // DeskPods schedules zero wakeups in main.
  const lastTitle = new Map<PodId, string>()
  const notified = new Set<PodId>()
  const unreadCount = new Map<PodId, number>()
  const loading = new Set<PodId>()

  // Merge the runtime flags (unread, loading) onto a Pod before it goes to the
  // renderer, which shows them as sidebar indicators.
  const withRuntime = (pod: Pod): Pod => ({
    ...pod,
    unread: (unreadCount.get(pod.id) ?? 0) > 0,
    loading: loading.has(pod.id)
  })
  const stateForRenderer = (): AppState => ({ ...state, pods: state.pods.map(withRuntime) })
  const pushPod = (pod: Pod) => send(IpcChannels.podUpdated, withRuntime(pod))

  /** Whether the music Pod is playing, for the taskbar overlay. Kept here, in
   *  its own flag, rather than read off the media state below: `refreshUnread`
   *  is defined before that state exists and would be reaching into a binding
   *  that is not initialised yet. */
  let musicPlaying = false
  let musicMuted = false

  /** Re-derive every Pod's unread count in one pass; push the ones that changed
   *  and update the taskbar badge: a NUMBER when titles carry real counts, a
   *  plain dot when unread comes only from caught notifications, and failing
   *  both, a speaker while the music Pod is playing. */
  const refreshUnread = (forceBadge = false) => {
    let dirty = false
    let titleTotal = 0
    let anyUnread = false
    for (const pod of state.pods) {
      const fromTitle = titleUnreadCount(lastTitle.get(pod.id) ?? '')
      titleTotal += fromTitle
      const want = fromTitle > 0 ? fromTitle : notified.has(pod.id) ? 1 : 0
      if (want > 0) anyUnread = true
      if (want !== (unreadCount.get(pod.id) ?? 0)) {
        if (want > 0) unreadCount.set(pod.id, want)
        else unreadCount.delete(pod.id)
        pushPod(pod)
        dirty = true
      }
    }
    if (dirty || forceBadge) {
      setTaskbarBadge(window, titleTotal, anyUnread && titleTotal === 0, musicPlaying, musicMuted)
    }
  }

  // Focusing the window "reads" the Pod on screen: clear its notification
  // signal (a notification that arrived for the active Pod while DeskPods was
  // in the background stops flagging unread once you come back to it).
  window.on('focus', () => {
    const active = pods.activePodId
    if (active && notified.delete(active)) refreshUnread()
  })

  /** Persist and push the full state to the renderer (for main-driven edits). */
  const pushState = () => {
    persist()
    send(IpcChannels.stateChanged, stateForRenderer())
  }

  // --- internal mutations shared by IPC handlers and native menus ---

  const removePod = (id: PodId) => {
    settleGitPrompt(id, { allowed: false })
    settleExecPrompt(id, { allowed: false })
    settleScriptingPrompt(id, false)
    settleDownloadPrompt(id, false)
    pages.closeAllFor(id)
    commands.killAllFor(id)
    downloads.forget(id)
    state.pods = state.pods.filter((p) => p.id !== id)
    if (state.activePodId === id) state.activePodId = state.pods[0]?.id ?? null
    if (state.musicPodId === id) {
      state.musicPodId = null
      report = null
      pods.setMusicPod(null)
      pushMedia()
    }
    pods.destroy(id)
    lastTitle.delete(id)
    notified.delete(id)
    unreadCount.delete(id)
    loading.delete(id)
    // Force the badge: the removed Pod no longer appears in the loop, so its
    // vanished count would otherwise leave a stale number on the taskbar.
    refreshUnread(true)
  }

  const movePodToFolder = (id: PodId, folderId: FolderId | null) => {
    const pod = state.pods.find((p) => p.id === id)
    if (!pod) return
    const siblings = state.pods.filter((p) => p.folderId === folderId && p.id !== id)
    pod.folderId = folderId
    pod.order = siblings.length
  }

  const applyFolderPatch = (id: FolderId, patch: FolderPatch) => {
    const folder = state.folders.find((f) => f.id === id)
    if (folder) Object.assign(folder, patch)
  }

  const deleteFolder = (id: FolderId) => {
    for (const pod of state.pods) {
      if (pod.folderId === id) pod.folderId = null
    }
    state.folders = state.folders.filter((f) => f.id !== id)
  }

  // Discord-style: drop any folder left without Pods. Returns whether the set
  // of folders changed, so callers can decide to push state to the renderer.
  const cleanupEmptyFolders = (): boolean => {
    const used = new Set(state.pods.map((p) => p.folderId))
    const before = state.folders.length
    state.folders = state.folders.filter((f) => used.has(f.id))
    return state.folders.length !== before
  }

  // --- git bridge -------------------------------------------------------
  // A Pod's page can run git, but only once the user has said yes FOR THAT POD
  // and picked the folder to work in. The answer rides with the Pod, so
  // deleting it (or creating another one on the same URL) asks again.
  const gitPrompts = new Map<
    PodId,
    { promise: Promise<PodGitAccess>; answer: (g: PodGitAccess) => void }
  >()

  const refuse = (error: string): GitResult => ({
    ok: false,
    code: -1,
    stdout: '',
    stderr: '',
    error
  })

  /** Ask the chrome to prompt, or join the prompt already on screen for this
   *  Pod so a page firing several commands raises a single dialog. */
  const askGitAccess = (id: PodId): Promise<PodGitAccess> => {
    const pending = gitPrompts.get(id)
    if (pending) return pending.promise

    let answer!: (grant: PodGitAccess) => void
    const promise = new Promise<PodGitAccess>((resolve) => {
      answer = resolve
    })
    gitPrompts.set(id, { promise, answer })
    send(IpcChannels.uiCommand, { type: 'git-permission', id, origin: pods.urlOf(id) })
    return promise
  }

  /** Settle a pending prompt (user answer, or the Pod going away). */
  const settleGitPrompt = (id: PodId, grant: PodGitAccess) => {
    const pending = gitPrompts.get(id)
    if (!pending) return
    gitPrompts.delete(id)
    pending.answer(grant)
  }

  /** The folder granted to this Pod, asking the user if they never answered.
   *  Null when the Pod is unknown or access was refused. */
  const grantedRoot = async (id: PodId): Promise<string | null> => {
    const pod = state.pods.find((p) => p.id === id)
    if (!pod) return null
    const grant = pod.settings?.git ?? (await askGitAccess(id))
    return grant.allowed && grant.root ? grant.root : null
  }

  pods.onGitRequest = async (id, request: GitRequest): Promise<GitResult> => {
    if (!isValidArgs(request?.args)) {
      return refuse('git expects a non-empty array of string arguments.')
    }

    const root = await grantedRoot(id)
    if (!root) return refuse('This Pod is not allowed to run git commands.')

    const cwd = resolveInside(root, request.cwd)
    if (!cwd) return refuse('Working directory outside the folder granted to this Pod.')

    return runGit(request.args, cwd)
  }

  // --- folder & file reads ----------------------------------------------
  // Under the git grant, not a permission of their own: a Pod that may run git
  // in a folder can already list it, read what is tracked and rewrite the tree.
  pods.onListDirRequest = async (id, request: ListDirRequest): Promise<ListDirResult> => {
    const root = await grantedRoot(id)
    if (!root) return { ok: false, entries: [], error: 'This Pod has no folder granted to it.' }
    return listDirectory(root, request?.path)
  }

  pods.onReadFileRequest = async (id, request: ReadFileRequest): Promise<ReadFileResult> => {
    const root = await grantedRoot(id)
    if (!root) return { ok: false, error: 'This Pod has no folder granted to it.' }
    return readFileAt(root, request?.path, request?.encoding ?? 'utf8')
  }

  pods.onWriteFileRequest = async (id, request: WriteFileRequest): Promise<WriteFileResult> => {
    const root = await grantedRoot(id)
    if (!root) return { ok: false, error: 'This Pod has no folder granted to it.' }
    return writeFileAt(root, request?.path, request?.content, request?.encoding ?? 'utf8')
  }

  // --- command bridge ---------------------------------------------------
  // Its own permission, and by default its own allow-list of program names: git
  // is one program, a shell is every program, and confining the working
  // directory changes nothing when the command line can name a path itself.
  const execPrompts = new Map<
    PodId,
    { promise: Promise<PodExecAccess>; answer: (g: PodExecAccess) => void }
  >()

  /** Ask about THIS command line, or join the prompt already on screen. */
  const askExecAccess = (id: PodId, command: string): Promise<PodExecAccess> => {
    const pending = execPrompts.get(id)
    if (pending) return pending.promise

    let answer!: (grant: PodExecAccess) => void
    const promise = new Promise<PodExecAccess>((resolve) => {
      answer = resolve
    })
    execPrompts.set(id, { promise, answer })
    send(IpcChannels.uiCommand, {
      type: 'exec-permission',
      id,
      origin: pods.urlOf(id),
      command
    })
    return promise
  }

  const settleExecPrompt = (id: PodId, grant: PodExecAccess) => {
    const pending = execPrompts.get(id)
    if (!pending) return
    execPrompts.delete(id)
    pending.answer(grant)
  }

  /**
   * Everything both command entry points have to settle before anything runs:
   * the command is usable, this Pod may run THIS one, and it has a folder to
   * run it in. Returns the working directory, or the refusal to hand back.
   */
  const prepareCommand = async (
    id: PodId,
    request: ExecRequest
  ): Promise<{ cwd: string } | { error: string }> => {
    const pod = state.pods.find((p) => p.id === id)
    if (!pod) return { error: 'Unknown Pod.' }
    if (!isValidCommand(request?.command)) {
      return { error: 'exec expects a non-empty command line.' }
    }
    const command = request.command

    // A refusal on file is final. A grant that does not cover THIS command
    // (allow-list) asks again about it, rather than failing silently.
    let grant = pod.settings?.exec
    if (!grant) grant = await askExecAccess(id, command)
    else if (grant.allowed && !isAllowedCommand(command, grant.allow)) {
      grant = await askExecAccess(id, command)
    }

    if (!grant.allowed) return { error: 'This Pod is not allowed to run commands.' }
    if (!isAllowedCommand(command, grant.allow)) {
      return { error: `This Pod is not allowed to run “${commandName(command)}”.` }
    }

    // Commands run in the folder granted for git: one folder per Pod, one rule.
    const root = await grantedRoot(id)
    if (!root) return { error: 'This Pod has no folder to run commands in.' }

    const cwd = resolveInside(root, request.cwd)
    if (!cwd) return { error: 'Working directory outside the folder granted to this Pod.' }

    return { cwd }
  }

  pods.onExecRequest = async (id, request: ExecRequest): Promise<GitResult> => {
    const prepared = await prepareCommand(id, request)
    if ('error' in prepared) return refuse(prepared.error)
    return runCommand(request.command, prepared.cwd, request.timeout, request.stdin)
  }

  // Commands that outlive a single answer - an agent session, a long build.
  // Same permission, same folder, same allow-list; only the shape differs.
  const commands = new RunningCommands()

  pods.onExecStart = async (id, request: ExecRequest): Promise<ExecStartResult> => {
    const prepared = await prepareCommand(id, request)
    if ('error' in prepared) return { ok: false, error: prepared.error }
    return commands.start(id, request.command, prepared.cwd, {
      timeout: request.timeout,
      stdin: request.stdin
    })
  }

  // Polling and killing re-check the permission rather than trusting the
  // handle: revoking Command Access must stop a session already under way.
  pods.onExecPoll = async (id, request: ExecHandleRequest): Promise<ExecPollResult> => {
    const pod = state.pods.find((p) => p.id === id)
    if (pod?.settings?.exec?.allowed !== true) {
      commands.killAllFor(id)
      return {
        ok: false,
        running: false,
        stdout: '',
        stderr: '',
        error: 'This Pod is not allowed to run commands.'
      }
    }
    return commands.poll(id, request?.id)
  }

  pods.onExecKill = async (id, request: ExecHandleRequest): Promise<ExecKillResult> =>
    commands.kill(id, request?.id)

  // Opening a file with its associated program. On the exec grant rather than a
  // permission of its own: a Pod allowed to run any command line can already
  // spell this `cmd /c start`, so nothing new is being handed out - and the
  // path here is confined to the granted folder, which a command line is not.
  //
  // An allow-list grant does NOT cover it. The list narrows by program name,
  // and the program that opens a file is decided by the machine's association,
  // so the list has nothing to check: honouring it would silently turn
  // "only 7z and robocopy" into "anything with a file extension".
  pods.onOpenPathRequest = async (id, request: OpenPathRequest): Promise<OpenPathResult> => {
    const pod = state.pods.find((p) => p.id === id)
    if (!pod) return { ok: false, error: 'Unknown Pod.' }
    if (typeof request?.path !== 'string' || request.path.trim() === '') {
      return { ok: false, error: 'openPath expects a path relative to the granted folder.' }
    }

    const grant = pod.settings?.exec ?? (await askExecAccess(id, `open ${request.path}`))
    if (!grant.allowed) return { ok: false, error: 'This Pod is not allowed to open files.' }
    if (grant.allow && grant.allow.length > 0) {
      return {
        ok: false,
        error:
          'Opening a file needs Command Access granted without an allow-list: ' +
          'the program that opens it is chosen by Windows, not by the command line.'
      }
    }

    const root = await grantedRoot(id)
    if (!root) return { ok: false, error: 'This Pod has no folder granted to it.' }

    return openPathIn(root, request.path)
  }

  // Closing DeskPods must not leave an agent session or a build running with
  // nobody able to see it or stop it any more.
  app.on('will-quit', () => {
    commands.disposeAll()
    downloads.disposeAll()
  })

  // ...and it must actually close. A background page is a hidden BrowserWindow,
  // and `window-all-closed` waits for every window there is - so one a Pod
  // forgot to close would keep the whole app alive, invisible, until its idle
  // timer expired minutes later.
  window.on('closed', () => {
    pages.disposeAll()
    commands.disposeAll()
    downloads.disposeAll()
  })

  // --- downloads --------------------------------------------------------
  // A Pod's page can download a file with the Pod's OWN session, which is the
  // whole point: the session it is already logged in with. Its own permission,
  // asked once per Pod like scripting - the user still answers a Save dialog for
  // every single file, so what is being granted is "download with my session",
  // not "write where you like".
  const downloads = new PodDownloads()
  const downloadPrompts = new Map<
    PodId,
    { promise: Promise<boolean>; answer: (ok: boolean) => void }
  >()

  const askDownload = (id: PodId, url: string): Promise<boolean> => {
    const pending = downloadPrompts.get(id)
    if (pending) return pending.promise

    let answer!: (allowed: boolean) => void
    const promise = new Promise<boolean>((resolve) => {
      answer = resolve
    })
    downloadPrompts.set(id, { promise, answer })
    send(IpcChannels.uiCommand, {
      type: 'download-permission',
      id,
      origin: pods.urlOf(id),
      url
    })
    return promise
  }

  const settleDownloadPrompt = (id: PodId, allowed: boolean) => {
    const pending = downloadPrompts.get(id)
    if (!pending) return
    downloadPrompts.delete(id)
    pending.answer(allowed)
  }

  /** True when this Pod may download, asking if it never answered. */
  const mayDownload = async (id: PodId, url: string): Promise<boolean> => {
    const pod = state.pods.find((p) => p.id === id)
    if (!pod) return false
    if (pod.settings?.download !== undefined) return pod.settings.download
    return askDownload(id, url)
  }

  // --- ad blocking ------------------------------------------------------
  // Opt-in per Pod, and enabled on the SESSION - so linked Pods share it, like
  // they share cookies. The engine builds on the first Pod that asks; a Pod
  // that never turns it on costs nothing.
  const adblock = new AdBlock()

  // --- the music Pod and its mini player --------------------------------
  // What it is playing is RUNTIME state, like unread: derived from the page,
  // never persisted. Only the role itself (`state.musicPodId`) is remembered.
  let report: MediaReport | null = null

  /**
   * What the page last reported, for a Pod that has never been loaded and so
   * has never reported anything. The player still has to draw - showing an
   * empty strip is the honest answer, and refusing to draw at all is why the
   * drawer used to stay away until the Pod had been clicked once.
   */
  const NOTHING_PLAYING: MediaReport = {
    title: '',
    artist: '',
    album: '',
    artwork: '',
    playing: false,
    canNext: false,
    canPrevious: false,
    canSeek: false,
    canVolume: false,
    position: 0,
    duration: 0,
    volume: 1
  }

  /** The page's last report plus the parts main owns (mute, history). Recomposed
   *  rather than cached: a Back press changes the arrows without the page
   *  saying anything at all. */
  const composeMedia = (): MediaInfo | null => {
    const id = state.musicPodId
    if (!id) return null
    return { ...(report ?? NOTHING_PLAYING), ...pods.transportOf(id) }
  }

  /** The sidebar shows no clock, so the position must not reach it: a value
   *  that ticks every second would re-render the rail once a second forever.
   *  The drawer, which does show it, is refreshed unconditionally below. */
  /** The last key sent to the renderer, for the comparison in `pushMedia`. */
  let mediaSent = 'null'

  const withoutTime = (info: MediaInfo | null) =>
    info ? JSON.stringify({ ...info, position: 0, duration: 0, volume: 0 }) : 'null'

  const pushMedia = () => {
    const next = composeMedia()
    // The previous key is kept rather than recomputed: this runs once a second
    // while music plays, and `withoutTime` spreads a thirteen-field object and
    // stringifies it, so half of that work was rebuilding a string produced a
    // second earlier.
    const key = withoutTime(next)
    if (key !== mediaSent) {
      mediaSent = key
      send(IpcChannels.mediaState, next)
    }
    pushMusicNav()
    // The taskbar overlay says "this app is the one making the sound", or that
    // it would be and has been silenced - but only when there is no unread
    // badge to show, since Windows has a single slot for both (see
    // setTaskbarBadge). Muting no longer just removes the overlay: the reason
    // you hear nothing is worth more than the absence of a badge.
    const playing = next?.playing === true
    const muted = next?.muted === true
    if (playing !== musicPlaying || muted !== musicMuted) {
      musicPlaying = playing
      musicMuted = muted
      refreshUnread(true)
    }
    // The drawer, when up, is showing the same thing and must not go stale.
    if (panelAnchor) sendMediaPanel(panelAnchor)
  }

  pods.onMedia = (_id, info) => {
    report = info
    pushMedia()
  }

  const setMusicPod = (id: PodId | null, enableAdblock = false) => {
    const next = id && state.pods.some((p) => p.id === id) ? id : null
    if ((state.musicPodId ?? null) === next) return
    state.musicPodId = next
    report = null
    // Only on the way in, and only when the caller asked: a music service is
    // the one Pod known in advance to show ads. It stays an ordinary per-Pod
    // setting afterwards, so the Pod's own menu can turn it back off.
    if (next && enableAdblock) {
      const pod = state.pods.find((p) => p.id === next)
      if (pod) pod.settings = { ...pod.settings, adblock: true }
    }
    // Whatever the old Pod was playing is no longer what the player drives.
    pushMedia()
    pods.setMusicPod(next)
    pushState()
  }

  /**
   * Route one command. The transport three are replayed into the page through
   * its media-session handlers; mute and history are answered here, on the web
   * contents, and so work whatever the site does.
   *
   * Nothing is queued for a Pod with no live view: the user loads it by
   * clicking it, which is the whole point of not loading it at startup.
   */
  const runMediaCommand = (action: MediaAction) => {
    const id = state.musicPodId
    if (!id || !action?.command) return
    const { command } = action
    if (command === 'togglemute') pods.toggleMuted(id)
    else if (command === 'back' || command === 'forward') pods.navigatePod(id, command)
    else pods.send(id, IpcChannels.podMediaCommand, action)
    // Mute and history change nothing the page will report, so the player is
    // refreshed here or its buttons would lie until the next poll.
    pushMedia()
  }

  // --- the media panel, drawn in the overlay window ----------------------
  // It has to live there: it extends over the workspace, and anything the
  // renderer draws there is painted over by the Pod's native view.
  const PANEL_GRACE_MS = 220
  let panelAnchor: { x: number; top: number; height: number } | null = null
  let panelHideTimer: NodeJS.Timeout | undefined

  /**
   * Windows plays its own show animation when a window appears, and the overlay
   * is hidden whenever it has nothing to draw. Sending the drawer in the same
   * breath as showing the window meant the CSS slide finished while the WINDOW
   * was still fading in - so the drawer arrived already at full width, drifting
   * into place. That is why it looked right on the music Pod, where the window
   * was already up for the history square, and wrong everywhere else.
   *
   * So: put the window up first (it is empty and transparent, so nothing is
   * seen), let that animation finish, and only then hand it something to draw.
   */
  const OS_WINDOW_SHOW_MS = 220
  /** When the overlay window last went from hidden to visible - by ANY route. */
  let overlayShownAt = 0

  const whenOverlayShown = (then: () => void) => {
    if (!overlay || overlay.isDestroyed()) return
    showOverlay()
    // Waiting only when this call did the showing was not enough: a toast, a
    // tooltip, the zoom pill or the history square may have put the window up
    // a few milliseconds earlier, in which case it already reads as visible
    // while the OS is still animating it in - and the drawer's own slide,
    // starting underneath that, finishes before anyone sees it. Hence the
    // timestamp: whoever raised the window, wait out what is left of it. This
    // is the rare "it faded in from the corner" case.
    const elapsed = Date.now() - overlayShownAt
    if (elapsed >= OS_WINDOW_SHOW_MS) then()
    else setTimeout(then, OS_WINDOW_SHOW_MS - elapsed)
  }

  const sendMediaPanel = (anchor: { x: number; top: number; height: number }) => {
    whenOverlayShown(() => {
      if (!overlay || overlay.isDestroyed()) return
      // The pointer may have left while the window was coming up.
      if (panelAnchor !== anchor && !panelAnchor) return
      const info = composeMedia()
      if (!info) return
      overlay.webContents.send(IpcChannels.mediaPanel, { info, ...anchor })
    })
  }

  /**
   * The history square drawn inside the music Pod's own area - shown only while
   * that Pod is the one on screen, since it is the only Pod whose links walk
   * you away from what you were doing with no chrome to come back with.
   */
  /** The last payload sent, so an unchanged one is not sent again. */
  let musicNavSent = ''

  const pushMusicNav = () => {
    if (!overlay || overlay.isDestroyed()) return
    const id = state.musicPodId
    if (!id || pods.activePodId !== id) {
      if (musicNavSent === 'null') return
      musicNavSent = 'null'
      overlay.webContents.send(IpcChannels.musicNav, null)
      return
    }
    const { muted: _muted, ...history } = pods.transportOf(id)
    const area = pods.workspace
    const payload = {
      x: Math.round(area.x),
      y: Math.round(area.y),
      ...history
    }
    // Nothing in this payload changes once a second, but `pushMedia` runs that
    // often: sending it anyway woke the overlay, forced a layout to re-measure
    // its hit area, and sent an answer back, every second, to move nothing.
    const key = JSON.stringify(payload)
    if (key === musicNavSent) return
    musicNavSent = key
    // The square has no entrance animation of its own, so it does not need the
    // window to have settled first - but it does need the window up.
    showOverlay()
    overlay.webContents.send(IpcChannels.musicNav, payload)
  }

  const hideMediaPanel = () => {
    panelAnchor = null
    if (!overlay || overlay.isDestroyed()) return
    overlay.webContents.send(IpcChannels.mediaPanel, null)
  }

  ipcMain.on(IpcChannels.overlayMediaCommand, (event, command: MediaCommand, value?: number) => {
    if (event.sender !== overlay?.webContents) return
    runMediaCommand({ command, value })
  })

  ipcMain.on(IpcChannels.mediaPanelHover, (event, hovering: boolean) => {
    if (event.sender !== overlay?.webContents) return
    clearTimeout(panelHideTimer)
    if (!hovering) panelHideTimer = setTimeout(hideMediaPanel, PANEL_GRACE_MS)
  })

  // A download is not the answer to an invoke: it arrives at the session. Wired
  // when a Pod's view is created, once per session (Pods sharing a partition
  // share one).
  pods.onSession = (id, session) => {
    downloads.wire(session)
    // Turned on here rather than on the toggle, so a Pod that had it enabled
    // last time starts blocking before its page makes its first request.
    const pod = state.pods.find((p) => p.id === id)
    if (pod?.settings?.adblock) {
      adblock.enable(session).catch(() => {
        // Offline on the very first run, with nothing cached yet: the Pod
        // loads without blocking rather than not loading at all.
      })
    }
  }

  // Progress goes back to the page that asked, on one channel for the whole Pod:
  // each event says which download it is about, and the page sorts them out.
  downloads.onProgress = (id, progress) => pods.send(id, IpcChannels.podDownloadProgress, progress)

  pods.onDownloadStart = async (
    id,
    request: DownloadStartRequest,
    sender
  ): Promise<DownloadStartResult> => {
    if (!(await mayDownload(id, request?.url ?? ''))) {
      return { ok: false, id: '', error: 'This Pod is not allowed to download files.' }
    }
    // The permission may have been taken back while the prompt was up, and the
    // page may have navigated away from the request it made.
    if (sender.isDestroyed()) return { ok: false, id: '', error: 'The page is gone.' }
    return downloads.start(id, sender, request ?? { url: '' })
  }

  // Stopping and revealing re-check the permission rather than trusting the
  // handle: revoking Download Access must stop a download already under way -
  // and `forget` on revocation already cancels it.
  pods.onDownloadCancel = async (id, downloadId): Promise<DownloadResult> =>
    downloads.cancel(id, downloadId)

  pods.onDownloadReveal = async (id, path): Promise<DownloadResult> => {
    const pod = state.pods.find((p) => p.id === id)
    if (pod?.settings?.download !== true) {
      return { ok: false, error: 'This Pod is not allowed to download files.' }
    }
    return downloads.reveal(id, path)
  }

  // --- background pages -------------------------------------------------
  // A Pod can drive another site like an API: open it once on this Pod's
  // session, run scripts against the loaded document, read the results. Same
  // one-shot, per-Pod permission as git, kept separate from it.
  const pages = new BackgroundPages()
  const scriptingPrompts = new Map<
    PodId,
    { promise: Promise<boolean>; answer: (ok: boolean) => void }
  >()

  const askScripting = (id: PodId, target: string): Promise<boolean> => {
    const pending = scriptingPrompts.get(id)
    if (pending) return pending.promise

    let answer!: (allowed: boolean) => void
    const promise = new Promise<boolean>((resolve) => {
      answer = resolve
    })
    scriptingPrompts.set(id, { promise, answer })
    send(IpcChannels.uiCommand, {
      type: 'scripting-permission',
      id,
      origin: pods.urlOf(id),
      target
    })
    return promise
  }

  const settleScriptingPrompt = (id: PodId, allowed: boolean) => {
    const pending = scriptingPrompts.get(id)
    if (!pending) return
    scriptingPrompts.delete(id)
    pending.answer(allowed)
  }

  /** True when this Pod may drive background pages, asking if never answered. */
  const mayScript = async (id: PodId, target: string): Promise<boolean> => {
    const pod = state.pods.find((p) => p.id === id)
    if (!pod) return false
    if (pod.settings?.scripting !== undefined) return pod.settings.scripting
    return askScripting(id, target)
  }

  pods.onOpenPage = async (id, url, options?: OpenPageOptions): Promise<OpenPageResult> => {
    if (!(await mayScript(id, url))) {
      return { ok: false, error: 'This Pod is not allowed to open background pages.' }
    }
    const pod = state.pods.find((p) => p.id === id)
    if (!pod) return { ok: false, error: 'Unknown Pod.' }
    return pages.open(id, pod.profile, url, options)
  }

  pods.onRunScript = async (id, handle, code): Promise<ScriptResult> => {
    const pod = state.pods.find((p) => p.id === id)
    // The handle only exists because permission was granted; re-check anyway,
    // so revoking it stops scripts on pages that are already open.
    if (pod?.settings?.scripting !== true) {
      return { ok: false, error: 'This Pod is not allowed to run scripts.' }
    }
    return pages.run(id, handle, code)
  }

  pods.onClosePage = (id, handle) => pages.close(id, handle)

  // Ctrl+F inside a Pod: ask the chrome to slide its find bar in.
  pods.onFindRequested = () => send(IpcChannels.uiCommand, { type: 'find-in-page' })

  // Match count of the running in-page search, for the find bar's counter.
  pods.onFindResult = (id, result) => {
    if (id === pods.activePodId) send(IpcChannels.findResult, result)
  }

  // The user zoomed a Pod (Ctrl+wheel or Ctrl+±): remember the factor so the
  // Pod reopens at the size they chose.
  pods.onZoom = (id, zoom) => {
    const pod = state.pods.find((p) => p.id === id)
    if (!pod) return
    // Back to 100% drops the saved factor only - the Pod's other settings (git,
    // exec, scripting, Keep Awake) have nothing to do with zoom.
    pod.settings = { ...pod.settings, zoom: zoom === 1 ? undefined : zoom }
    persist()

    // Flash the level above the page, the way a browser does. It goes to the
    // overlay window because a native Pod view paints over the chrome.
    if (id === pods.activePodId && overlay && !overlay.isDestroyed()) {
      showOverlay()
      overlay.webContents.send(IpcChannels.zoomIndicator, Math.round(zoom * 100))
    }
  }

  /**
   * Refuse everything still on screen. The chrome reloading - a crash, or HMR
   * in dev - takes its dialogs with it, and a page blocked on a promise nobody
   * can answer any more would wait for ever. A refusal here is NOT remembered:
   * only the permission handlers write to `pod.settings`, so the next call asks
   * again.
   */
  const refuseOpenPrompts = () => {
    for (const id of [...gitPrompts.keys()]) settleGitPrompt(id, { allowed: false })
    for (const id of [...execPrompts.keys()]) settleExecPrompt(id, { allowed: false })
    for (const id of [...scriptingPrompts.keys()]) settleScriptingPrompt(id, false)
    for (const id of [...downloadPrompts.keys()]) settleDownloadPrompt(id, false)
  }
  window.webContents.on('did-start-loading', refuseOpenPrompts)

  // --- Keep Awake -------------------------------------------------------
  // Pods marked awake are loaded without being shown, so the app inside is
  // connected - and can notify - before it has ever been clicked. Deferred:
  // the point of startup is DeskPods' own window appearing, not a background
  // Pod competing with it for the first seconds. One timer, once, no polling.
  const AWAKE_DELAY_MS = 4_000
  window.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (window.isDestroyed()) return
      for (const pod of state.pods) {
        if (pod.settings?.awake) pods.wake(pod.id)
      }
    }, AWAKE_DELAY_MS).unref()
  })

  // Mouse back/forward buttons drive the active Pod's history, like a browser.
  window.on('app-command', (_e, command) => {
    if (command === 'browser-backward') pods.navigate('back')
    else if (command === 'browser-forward') pods.navigate('forward')
  })

  // Loading indicator for the sidebar (runtime-only, like unread).
  pods.onLoading = (id, isLoading) => {
    if (isLoading === loading.has(id)) return
    if (isLoading) loading.add(id)
    else loading.delete(id)
    const pod = state.pods.find((p) => p.id === id)
    if (pod) pushPod(pod)
    // A finished load is also when the music Pod's history changed, and the
    // square's arrows are that history.
    if (!isLoading && id === state.musicPodId) pushMusicNav()
  }

  /**
   * uBlock Origin's cosmetic rules for a page a Pod is about to show.
   *
   * Answered only for a Pod that asked for blocking, and only because the
   * library's own injection cannot be used (see AdBlock.enable). PodManager
   * puts these in at document start, once, in the main frame.
   */
  pods.onCosmetics = async (id, url) => {
    const pod = state.pods.find((p) => p.id === id)
    if (pod?.settings?.adblock !== true) return null
    return adblock.cosmeticsFor(url)
  }

  pods.onNavigated = (id, url) => {
    if (id !== state.musicPodId) return
    pushMusicNav()
    // Remember where the music Pod is, so a restart reopens it there rather
    // than at the service's front page (see Pod.lastUrl). Only this Pod, and
    // only http(s): an error page or an about: URL is not somewhere to return
    // to. Writing goes through the debounced save, which is what keeps a
    // service that routes by pushState from hitting the disk per click.
    const pod = state.pods.find((p) => p.id === id)
    if (!pod || !/^https?:/i.test(url) || pod.lastUrl === url) return
    pod.lastUrl = url
    persist()
  }

  // The overlay window is shown only while it has content to draw; a hidden
  // window costs the compositor nothing, a visible transparent one is blended
  // every frame. It reports back (overlayIdle) once everything faded out.
  const showOverlay = () => {
    if (overlay && !overlay.isDestroyed() && !overlay.isVisible()) {
      overlayShownAt = Date.now()
      overlay.showInactive()
    }
  }
  // Toasts are clickable; everything else in the overlay stays click-through.
  const setHitAreas = overlay ? createHitAreaTracker(overlay) : () => {}
  ipcMain.on(IpcChannels.overlayHitAreas, (event, areas: Rect[]) => {
    if (event.sender === overlay?.webContents) setHitAreas(areas)
  })

  ipcMain.on(IpcChannels.overlayIdle, (event) => {
    if (event.sender !== overlay?.webContents) return
    setHitAreas([])
    if (overlay && !overlay.isDestroyed()) overlay.hide()
  })

  // A Pod's web app raised a notification → flag unread AND draw a themed toast
  // above the Pods (replacing the app's own out-of-theme/blocking popup). The
  // toast shows regardless of which Pod is active. If the window isn't focused,
  // flash the taskbar so a reminder isn't missed while DeskPods is in the back.
  pods.onNotification = (id, payload) => {
    // A notification for the Pod you are currently looking at is already read;
    // otherwise it flags unread until that Pod is viewed (or the window
    // refocused, for the active Pod).
    const onScreen = id === pods.activePodId && !window.isDestroyed() && window.isFocused()
    if (!onScreen) {
      notified.add(id)
      refreshUnread()
    }
    const pod = state.pods.find((p) => p.id === id)
    if (pod && overlay && !overlay.isDestroyed()) {
      const toast: OverlayToast = {
        podId: id,
        podName: pod.name,
        title: payload?.title ?? '',
        body: payload?.body
      }
      showOverlay()
      overlay.webContents.send(IpcChannels.overlayToast, toast)
    }
    if (!window.isDestroyed() && !window.isFocused()) window.flashFrame(true)
  }

  // Receive title/favicon updates from the Pod views and reflect them.
  pods.onMeta = (id, meta) => {
    const pod = state.pods.find((p) => p.id === id)
    if (!pod) return
    let changed = false

    if (meta.title && autoNamed.has(id)) {
      const name = cleanTitle(meta.title)
      if (name) {
        pod.name = name
        autoNamed.delete(id)
        changed = true
      }
    }
    if (meta.favicon && pod.icon !== meta.favicon) {
      pod.icon = meta.favicon
      changed = true
    }

    // Remember the latest title so unread can be re-derived on any change
    // (a count in the title, e.g. "(2) Discord", means unread once backgrounded).
    if (typeof meta.title === 'string') lastTitle.set(id, meta.title)

    if (changed) {
      saveState(state)
      pushPod(pod)
    }
    refreshUnread()
  }

  // --- renderer-driven handlers ---

  handle(IpcChannels.getState, (): AppState => stateForRenderer())

  // Root Pods and folders share ONE visual order sequence; a new root entry
  // must therefore go after the max across BOTH, not after its own kind's
  // count, or the two independent counters collide and it lands mid-list.
  const nextRootOrder = (): number =>
    Math.max(
      -1,
      ...state.pods.filter((p) => p.folderId === null).map((p) => p.order),
      ...state.folders.map((f) => f.order)
    ) + 1

  handle(IpcChannels.createPod, (_e, input: CreatePodInput): Pod => {
    const id = randomUUID()
    const providedName = (input.name ?? '').trim()
    const folderId = input.folderId ?? null
    // A linked Pod reuses the referenced Pod's partition so one login (e.g.
    // Google) is shared; otherwise it gets its own isolated profile.
    const linkedProfile = input.linkTo
      ? state.pods.find((p) => p.id === input.linkTo)?.profile
      : undefined
    const pod: Pod = {
      id,
      name: providedName || defaultNameFromUrl(input.url),
      url: input.url,
      icon: input.icon,
      profile: linkedProfile ?? id,
      folderId,
      order:
        folderId === null
          ? nextRootOrder()
          : Math.max(-1, ...state.pods.filter((p) => p.folderId === folderId).map((p) => p.order)) +
            1
    }
    if (!providedName) autoNamed.add(id)
    state.pods.push(pod)
    persist()
    return pod
  })

  handle(IpcChannels.activatePod, (_e, id: PodId): void => {
    // A Pod that is not there cannot become the active one: `pods.activate`
    // would no-op and we would persist an id pointing at nothing.
    if (!state.pods.some((p) => p.id === id)) return
    // Leave no search highlighted behind on the Pod we are stepping away from.
    pods.stopFind()
    state.activePodId = id
    pods.activate(id)
    // Viewing a Pod clears a title-less Notification signal (its only "read"
    // cue). A count carried in the title is NOT cleared here - it clears only
    // when the web app itself drops it, so the badge survives switching Pods.
    notified.delete(id)
    refreshUnread()
    // Stepping onto or off the music Pod puts its history square up or takes
    // it down: it belongs to that Pod's area, not to the app.
    pushMusicNav()
    saveState(state)
  })

  handle(IpcChannels.updateBounds, (_e, bounds: Rect): void => {
    pods.updateBounds(bounds)
    // The square sits inside that rectangle, so it moves with it.
    pushMusicNav()
  })

  handle(IpcChannels.setOverlay, (_e, active: boolean): void => {
    pods.setOverlay(active)
  })

  handle(IpcChannels.setMusicPod, (_e, id: PodId | null, options?: { enableAdblock?: boolean }) => {
    setMusicPod(id, options?.enableAdblock === true)
  })

  handle(IpcChannels.setMusicService, (_e, url: string, name?: string): void => {
    const id = state.musicPodId
    const pod = id ? state.pods.find((p) => p.id === id) : undefined
    if (!id || !pod) return

    // A service the built-in list does not offer is remembered, so it does not
    // have to be typed twice. Moved to the front rather than appended: the one
    // just used is the one most likely wanted again.
    if (!MUSIC_SITES.some((site) => site.url === url)) {
      const kept = (state.musicUrls ?? []).filter((known) => known !== url)
      kept.unshift(url)
      state.musicUrls = kept.slice(0, MAX_REMEMBERED_MUSIC_URLS)
    }

    pod.url = url
    // The page that was open belonged to the service being left.
    pod.lastUrl = undefined
    // The name follows the service only while the Pod is still auto-named: a
    // Pod the user renamed keeps the name they gave it.
    if (name && autoNamed.has(id)) pod.name = name
    // The icon belonged to the site that was there; cleared, the Pod falls back
    // to its initial until the new page reports one.
    pod.icon = undefined
    // Whatever it was playing was the other service's track.
    report = null

    /**
     * The view is DESTROYED and built again, rather than navigated.
     *
     * Navigating a page that is playing does not reliably work: it can refuse
     * to be unloaded, and the switch then silently did nothing, which is the
     * bug this replaces. Negotiating with the page for permission is not worth
     * it when switching service means leaving that service anyway - stopping
     * the music is the expected outcome, not a side effect to avoid.
     *
     * A destroyed web contents has no say. The session stays on disk, so the
     * service is still signed in when you come back to it, and `activate`
     * builds the new view straight from the url set just above.
     */
    pods.suspend(id)
    pods.stopFind()
    state.activePodId = id
    pods.activate(id)
    notified.delete(id)
    refreshUnread()
    pushMusicNav()

    persist()
    pushState()
    pushMedia()
  })

  handle(IpcChannels.mediaCommand, (_e, command: MediaCommand, value?: number): void => {
    runMediaCommand({ command, value })
  })

  handle(
    IpcChannels.showMediaPanel,
    (_e, anchor: { x: number; top: number; height: number } | null): void => {
      if (anchor) {
        panelAnchor = anchor
        clearTimeout(panelHideTimer)
        sendMediaPanel(anchor)
        return
      }
      // Not hidden at once: the pointer has to cross the gap between the sidebar
      // and the panel, and the panel says when it has taken over.
      clearTimeout(panelHideTimer)
      panelHideTimer = setTimeout(hideMediaPanel, PANEL_GRACE_MS)
    }
  )

  handle(
    IpcChannels.gitPermission,
    (_e, id: PodId, allowed: boolean, root: string | null): void => {
      const grant: PodGitAccess = allowed && root ? { allowed: true, root } : { allowed: false }
      const pod = state.pods.find((p) => p.id === id)
      if (pod) {
        pod.settings = { ...pod.settings, git: grant }
        persist()
      }
      settleGitPrompt(id, grant)
    }
  )

  handle(
    IpcChannels.execPermission,
    (_e, id: PodId, allowed: boolean, allow: string[] | null): void => {
      const pod = state.pods.find((p) => p.id === id)
      // A null list means "every command"; a list adds to what was already
      // granted, so answering a second prompt widens the set instead of
      // replacing it.
      const previous = pod?.settings?.exec
      const widerAlready = previous?.allowed === true && !previous.allow?.length
      const merged =
        allow === null || widerAlready
          ? undefined
          : [...new Set([...(previous?.allowed ? (previous.allow ?? []) : []), ...allow])]
      const grant: PodExecAccess = allowed
        ? { allowed: true, ...(merged && merged.length > 0 ? { allow: merged } : {}) }
        : { allowed: false }

      if (pod) {
        pod.settings = { ...pod.settings, exec: grant }
        persist()
      }
      settleExecPrompt(id, grant)
    }
  )

  handle(IpcChannels.scriptingPermission, (_e, id: PodId, allowed: boolean): void => {
    const pod = state.pods.find((p) => p.id === id)
    if (pod) {
      pod.settings = { ...pod.settings, scripting: allowed }
      persist()
    }
    if (!allowed) pages.closeAllFor(id)
    settleScriptingPrompt(id, allowed)
  })

  handle(IpcChannels.downloadPermission, (_e, id: PodId, allowed: boolean): void => {
    const pod = state.pods.find((p) => p.id === id)
    if (pod) {
      pod.settings = { ...pod.settings, download: allowed }
      persist()
    }
    if (!allowed) downloads.forget(id)
    settleDownloadPrompt(id, allowed)
  })

  handle(IpcChannels.pickFolder, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
      title: 'Choose the folder this Pod may run git and read files in'
    })
    return result.filePaths[0] ?? null
  })

  handle(IpcChannels.findInPage, (_e, text: string, options?: FindOptions): void => {
    pods.find(text, options)
  })

  handle(IpcChannels.stopFindInPage, (): void => {
    pods.stopFind()
  })

  handle(IpcChannels.updatePod, (_e, id: PodId, patch: PodPatch): void => {
    const pod = state.pods.find((p) => p.id === id)
    if (!pod) return
    if (patch.name !== undefined) {
      pod.name = patch.name
      autoNamed.delete(id) // explicit name; stop auto-titling.
    }
    if (patch.icon !== undefined) pod.icon = patch.icon
    if (patch.url !== undefined && patch.url !== pod.url) {
      pod.url = patch.url
      // The icon belongs to the site that was there, not to the Pod: kept, it
      // would sit in the sidebar advertising the old service until the new one
      // happened to report a favicon of its own. Cleared, the Pod falls back to
      // its initial until the new page says otherwise.
      if (patch.icon === undefined) pod.icon = undefined
      pods.loadUrl(id, patch.url)
      // Same for what it was playing - that was the other service's track.
      if (id === state.musicPodId) {
        report = null
        pushMedia()
      }
    }
    persist()
    pushState()
  })

  handle(IpcChannels.reorderPods, (_e, placements: PodPlacement[]): void => {
    for (const { id, folderId, order } of placements) {
      const pod = state.pods.find((p) => p.id === id)
      if (pod) {
        pod.folderId = folderId
        pod.order = order
      }
    }
    // If the move emptied a folder, push the pruned state so the renderer drops
    // it too; otherwise the optimistic renderer update already matches.
    if (cleanupEmptyFolders()) pushState()
    else persist()
  })

  handle(IpcChannels.createFolder, (_e, name: string): Folder => {
    const folder: Folder = {
      id: randomUUID(),
      name: name.trim() || 'New Folder',
      color: FOLDER_COLORS[0],
      collapsed: false,
      order: nextRootOrder()
    }
    state.folders.push(folder)
    persist()
    return folder
  })

  handle(IpcChannels.updateFolder, (_e, id: FolderId, patch: FolderPatch): void => {
    applyFolderPatch(id, patch)
    persist()
  })

  handle(IpcChannels.reorderFolders, (_e, placements: FolderPlacement[]): void => {
    for (const { id, order } of placements) {
      const folder = state.folders.find((f) => f.id === id)
      if (folder) folder.order = order
    }
    persist()
  })

  // --- native context menus (main-driven; push full state on mutation) ---

  handle(IpcChannels.showPodMenu, (_e, id: PodId): void => {
    const pod = state.pods.find((p) => p.id === id)
    if (!pod) return
    const zoom = pod.settings?.zoom

    const moveTargets: MenuItemConstructorOptions[] = [
      {
        label: 'No folder',
        type: 'checkbox',
        checked: pod.folderId === null,
        enabled: pod.folderId !== null,
        click: () => {
          movePodToFolder(id, null)
          cleanupEmptyFolders()
          pushState()
        }
      },
      ...state.folders
        .slice()
        .sort((a, b) => a.order - b.order)
        .map<MenuItemConstructorOptions>((folder) => ({
          label: folder.name,
          type: 'checkbox',
          checked: pod.folderId === folder.id,
          click: () => {
            movePodToFolder(id, folder.id)
            cleanupEmptyFolders()
            pushState()
          }
        }))
    ]

    const template: MenuItemConstructorOptions[] = [
      { label: 'Rename', click: () => send(IpcChannels.uiCommand, { type: 'rename-pod', id }) },
      { label: 'Edit URL', click: () => send(IpcChannels.uiCommand, { type: 'edit-pod-url', id }) },
      { type: 'separator' },
      { label: 'Move to', submenu: moveTargets },
      { type: 'separator' },
      // Shown only once an answer exists, so the user can take it back.
      ...(pod.settings?.scripting !== undefined
        ? [
            {
              label: pod.settings.scripting
                ? 'Revoke Page Scripting'
                : 'Reset Scripting Permission',
              click: () => {
                pages.closeAllFor(id)
                pod.settings = { ...pod.settings, scripting: undefined }
                pushState()
              }
            },
            { type: 'separator' } as MenuItemConstructorOptions
          ]
        : []),
      ...(pod.settings?.download !== undefined
        ? [
            {
              label: pod.settings.download ? 'Revoke Download Access' : 'Reset Download Permission',
              click: () => {
                // A download nobody can follow any more is stopped, not left to
                // fill the disk in the background.
                downloads.forget(id)
                pod.settings = { ...pod.settings, download: undefined }
                pushState()
              }
            },
            { type: 'separator' } as MenuItemConstructorOptions
          ]
        : []),
      ...(pod.settings?.git
        ? [
            {
              label: pod.settings.git.allowed ? 'Revoke Git Access' : 'Reset Git Permission',
              click: () => {
                pod.settings = { ...pod.settings, git: undefined }
                pushState()
              }
            },
            { type: 'separator' } as MenuItemConstructorOptions
          ]
        : []),
      ...(pod.settings?.exec
        ? [
            {
              label: pod.settings.exec.allowed
                ? 'Revoke Command Access'
                : 'Reset Command Permission',
              click: () => {
                commands.killAllFor(id)
                pod.settings = { ...pod.settings, exec: undefined }
                pushState()
              }
            },
            { type: 'separator' } as MenuItemConstructorOptions
          ]
        : []),
      // Only worth showing when the Pod is actually zoomed.
      ...(zoom && zoom !== 1
        ? [
            {
              label: `Reset Zoom (${Math.round(zoom * 100)}%)`,
              click: () => {
                pods.resetZoom(id)
                // A suspended Pod has no view to reset, so drop the saved
                // factor here as well - the factor only, not the whole
                // settings object.
                if (pod.settings?.zoom) {
                  pod.settings = { ...pod.settings, zoom: undefined }
                  persist()
                }
              }
            },
            { type: 'separator' } as MenuItemConstructorOptions
          ]
        : []),
      {
        // Off by default: most Pods have nothing to block, and the engine is
        // only built once some Pod asks for it. Enabling on a live Pod reloads
        // the page, so the answer is visible straight away rather than from
        // the next navigation on.
        label: 'Block Ads & Trackers',
        type: 'checkbox',
        checked: pod.settings?.adblock === true,
        click: () => {
          const on = pod.settings?.adblock !== true
          pod.settings = { ...pod.settings, adblock: on || undefined }
          persist()
          pushState()

          const session = pods.sessionFor(id)
          if (!session) return
          if (!on) {
            adblock.disable(session)
            pods.reload(id)
            return
          }
          adblock
            .enable(session)
            .then(() => pods.reload(id))
            .catch(() => {
              // Building the engine needs the filter lists once; offline with
              // nothing cached, the Pod simply carries on unblocked.
            })
        }
      },
      { type: 'separator' },
      {
        // Chromium backgrounds every Pod but the active one: timers slow down
        // and the page is told it is hidden, which is how a chat app decides to
        // go away. This opts the Pod out, and loads it at startup rather than
        // on first click. It costs battery - hence a choice, not a default.
        label: 'Keep Awake',
        type: 'checkbox',
        checked: pod.settings?.awake === true,
        click: () => {
          const awake = pod.settings?.awake !== true
          pod.settings = { ...pod.settings, awake: awake || undefined }
          persist()
          // A live view is switched over on the spot; a suspended one is woken
          // now, so turning this on does what it says without a click.
          if (awake) pods.wake(id)
          pods.setAwake(id, awake)
          pushState()
        }
      },
      { type: 'separator' },
      // The music Pod is a fixture, not an entry in the list: it has its own
      // slot and the player depends on it. Changing SERVICE is what "delete and
      // make another one" was standing in for, so that is offered instead -
      // and Suspend, which would silence the music mid-track, is not offered at
      // all. Clearing the slot lives in the same dialog.
      ...(state.musicPodId === id
        ? [
            {
              label: 'Change Music Service…',
              click: () => send(IpcChannels.uiCommand, { type: 'music-pod' })
            } as MenuItemConstructorOptions
          ]
        : [
            {
              // Free the Pod's renderer/GPU cost now; its session stays on disk
              // and the next click reloads it. Only meaningful when a live view
              // exists.
              label: 'Suspend',
              enabled: pods.hasView(id),
              click: () => {
                pages.closeAllFor(id)
                commands.killAllFor(id)
                pods.suspend(id)
              }
            } as MenuItemConstructorOptions,
            {
              label: 'Delete',
              click: () => {
                removePod(id)
                pushState()
              }
            } as MenuItemConstructorOptions
          ])
    ]
    Menu.buildFromTemplate(template).popup({ window })
  })

  // Tooltips: forward to the transparent overlay window that sits above Pods.
  const sendTooltip = (payload: TooltipPayload | null) => {
    if (!overlay || overlay.isDestroyed()) return
    if (payload) showOverlay()
    overlay.webContents.send(IpcChannels.tooltip, payload)
  }
  handle(IpcChannels.tooltipShow, (_e, payload: TooltipPayload): void => sendTooltip(payload))
  handle(IpcChannels.tooltipHide, (): void => sendTooltip(null))

  handle(IpcChannels.pickFile, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      filters: [
        { name: 'Documents', extensions: ['pdf', 'html', 'htm'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    const filePath = result.filePaths[0]
    return filePath ? pathToFileURL(filePath).href : null
  })

  handle(IpcChannels.showFolderMenu, (_e, id: FolderId): void => {
    const folder = state.folders.find((f) => f.id === id)
    if (!folder) return

    const command = (c: UiCommand) => () => send(IpcChannels.uiCommand, c)

    const template: MenuItemConstructorOptions[] = [
      { label: 'Folder Settings', click: command({ type: 'folder-settings', id }) },
      { label: 'New Pod here', click: command({ type: 'add-pod-in-folder', folderId: id }) },
      { type: 'separator' },
      {
        label: 'Delete Folder',
        click: () => {
          deleteFolder(id)
          pushState()
        }
      }
    ]
    Menu.buildFromTemplate(template).popup({ window })
  })

  return state
}
