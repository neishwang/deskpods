/**
 * Shared domain + IPC contracts between main, preload and renderer.
 * Kept infrastructure-agnostic (no Electron imports here).
 */

export type PodId = string
export type FolderId = string

/**
 * Permission for a Pod's pages to run git commands, decided once by the user
 * and remembered with the Pod. Deleting the Pod forgets it, so a Pod recreated
 * on the same URL is asked again.
 */
export interface PodGitAccess {
  allowed: boolean
  /** Absolute path of the folder picked when granting. Commands run there and
   *  may never step outside it. Absent when access was refused. */
  root?: string
}

/**
 * Permission for a Pod's pages to run arbitrary command lines. Kept apart from
 * `git` on purpose: git is one program, a shell is every program, so this is
 * asked separately and - by default - narrowed to the program names the user
 * agreed to. Commands run in the folder granted for git.
 */
export interface PodExecAccess {
  allowed: boolean
  /** Program names the Pod may run (first word of the command line, without
   *  folder or `.exe`, lowercased). Absent or empty means every command was
   *  allowed. With a list, a command line chaining another one (`&`, `|`, `;`,
   *  redirections…) is refused whatever it starts with. */
  allow?: string[]
}

export interface PodSettings {
  /** Set once the user has answered the scripting permission prompt for this
   *  Pod: true allows it to drive background pages, false refuses. */
  scripting?: boolean
  /** Zoom factor applied to the Pod's contents (1 = 100%). Set with
   *  Ctrl+wheel / Ctrl+`+`-`-` inside the Pod and remembered across restarts. */
  zoom?: number
  /** Set once the user has answered the git permission prompt for this Pod.
   *  Also covers reading the granted folder and its files (see listDir /
   *  readFile / writeFile), which git already allows anyway. */
  git?: PodGitAccess
  /** Set once the user has answered the exec permission prompt for this Pod. */
  exec?: PodExecAccess
  /** Set once the user has answered the download permission prompt for this
   *  Pod: true lets its pages download files with the Pod's own session, false
   *  refuses. The user still picks where every file goes. */
  download?: boolean
  /** Set when the user turns ad and tracker blocking on for this Pod. Off by
   *  default and asked per Pod, not globally: most Pods (chat, mail, an
   *  intranet) have nothing to block, and a filter engine costs memory and a
   *  hop on every request. Pods sharing a partition (`linkTo`) share the
   *  answer, because blocking is enabled on the session. */
  adblock?: boolean
  /** Keep this Pod running as if it were on screen: no timer throttling, no
   *  "hidden" from the Page Visibility API, and its page is loaded shortly
   *  after startup instead of on first click. For the chat app that would
   *  otherwise go away and stop notifying. Costs battery and memory, so it is
   *  opt-in, per Pod. */
  awake?: boolean
}

/** How `openPage` decides the target site is ready. */
export interface OpenPageOptions {
  /** JavaScript expression evaluated in the page until it turns truthy, on top
   *  of waiting for the load itself - e.g. "typeof _MCS !== 'undefined'".
   *  Without it, openPage resolves as soon as the page has finished loading. */
  waitFor?: string
  /** Milliseconds before giving up on the load or on `waitFor` (default 30000,
   *  capped at 120000). */
  timeout?: number
}

/** Handle on a background page, or the reason it could not be opened. */
export interface OpenPageResult {
  ok: boolean
  /** Pass this to runScript / closePage. */
  id?: string
  /** URL actually loaded, after redirects. */
  url?: string
  error?: string
}

/** What a script returned, after a JSON round-trip. */
export interface ScriptResult {
  ok: boolean
  value?: unknown
  error?: string
}

/** A git command a Pod's page asks DeskPods to run. */
export interface GitRequest {
  /** Arguments handed to git as an array - never a shell string, so nothing is
   *  interpreted by a shell. Example: ['status', '--porcelain']. */
  args: string[]
  /** Optional path RELATIVE to the granted folder; absolute paths and anything
   *  climbing out with `..` are refused. */
  cwd?: string
}

/** What the page gets back once the command has run. */
export interface GitResult {
  /** True when git exited with code 0. */
  ok: boolean
  code: number
  stdout: string
  stderr: string
  /** Set when DeskPods declined to run the command at all (no permission,
   *  invalid arguments, path outside the granted folder, git missing…). */
  error?: string
}

/** A command line a Pod's page asks DeskPods to run (see PodExecAccess). */
export interface ExecRequest {
  /** The whole line, run by the system shell - pipes, `&&` and redirections
   *  included, which is precisely why it needs its own permission. */
  command: string
  /** Optional path RELATIVE to the granted folder, same rule as git. */
  cwd?: string
  /** Milliseconds before the command is killed (default 120000, clamped to
   *  1000…600000; for `execStart`, default 1800000 and up to 24 h). */
  timeout?: number
  /** Written to the command's standard input, which is then closed. This is
   *  where a secret goes - a master password on the command line would be
   *  shown in the permission dialog and listed by anything that can read the
   *  machine's processes. */
  stdin?: string
}

/** Handle on a command left running, or the reason it could not start. */
export interface ExecStartResult {
  ok: boolean
  /** Pass this to execPoll / execKill. */
  id?: string
  error?: string
}

/** How a running command is doing, and what it printed since the last poll. */
export interface ExecPollResult {
  ok: boolean
  /** False once the command has exited (or was killed). */
  running: boolean
  /** Output produced SINCE the previous poll - never repeated. */
  stdout: string
  stderr: string
  /** Exit code, once it has finished. */
  code?: number
  /** Set when output had to be dropped because nobody polled fast enough. */
  truncated?: boolean
  /** Set when the command could not run, timed out, or was killed. */
  error?: string
}

export interface ExecHandleRequest {
  /** The id returned by execStart. */
  id: string
}

export interface ExecKillResult {
  ok: boolean
  error?: string
}

/** One entry of a folder listing. */
export interface DirEntry {
  name: string
  directory: boolean
}

export interface ListDirRequest {
  /** Optional path RELATIVE to the granted folder; omitted means the folder
   *  itself. */
  path?: string
}

export interface ListDirResult {
  ok: boolean
  /** One level only, never recursive. Hidden entries included. */
  entries: DirEntry[]
  error?: string
}

/** How a file's bytes are carried across IPC. */
export type FileEncoding = 'utf8' | 'base64'

export interface ReadFileRequest {
  /** Path RELATIVE to the granted folder. */
  path: string
  /** Defaults to 'utf8'; use 'base64' for anything binary. */
  encoding?: FileEncoding
}

export interface ReadFileResult {
  ok: boolean
  content?: string
  /** Size on disk in bytes (not the length of `content`, which differs in
   *  base64). */
  size?: number
  encoding?: FileEncoding
  error?: string
}

export interface WriteFileRequest {
  /** Path RELATIVE to the granted folder. Missing parent folders are created
   *  under it. */
  path: string
  content: string
  /** How to decode `content` before writing. Defaults to 'utf8'. */
  encoding?: FileEncoding
}

export interface WriteFileResult {
  ok: boolean
  error?: string
}

/** A download a Pod's page asks DeskPods to run with the Pod's own session. */
export interface DownloadStartRequest {
  /** http(s) only. The bytes never travel through the page: they go from
   *  Chromium to the disk. */
  url: string
  /** Suggested name, offered in the Save dialog. Folders in it are ignored -
   *  where the file lands is the user's answer to that dialog, not the page's. */
  fileName?: string
}

/** Answer to `start`, given at once: the download has begun, not finished. */
export interface DownloadStartResult {
  ok: boolean
  /** DeskPods' own id, carried by every progress event for this download.
   *  Empty when it never started. */
  id: string
  error?: string
}

/** Answer to `cancel` / `reveal`. */
export interface DownloadResult {
  ok: boolean
  error?: string
}

export interface DownloadHandleRequest {
  /** The id returned by start. */
  id: string
}

export interface DownloadRevealRequest {
  /** Absolute path of a file this Pod downloaded. Anything else is refused:
   *  opening Explorer wherever a page likes is not part of the deal. */
  path: string
}

/** Pushed to the Pod's page while one of its downloads runs. One channel for
 *  the whole Pod; each event says which download it is about. */
export interface DownloadProgress {
  id: string
  fileName: string
  /** Where the file is being written. Empty until the user has answered the
   *  Save dialog. */
  path: string
  received: number
  /** 0 when the server does not say how big the file is - a progress bar has to
   *  go indeterminate rather than pretend. */
  total: number
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
}

export interface Pod {
  id: PodId
  name: string
  url: string
  /** Detected favicon URL, or an emoji/letter fallback. */
  icon?: string
  /** Partition key -> Chromium partition `persist:<profile>`. */
  profile: string
  /** Visual grouping only; null means root level. */
  folderId: FolderId | null
  order: number
  settings?: PodSettings
  /** Runtime-only: the Pod has an unread notification (red dot). Derived by
   *  main from the page title; never persisted. */
  unread?: boolean
  /** Runtime-only: the Pod's page is currently loading. Never persisted. */
  loading?: boolean
}

/** Purely visual organisation in the sidebar. Never affects isolation. */
export interface Folder {
  id: FolderId
  name: string
  icon?: string
  color?: string
  collapsed: boolean
  order: number
}

/** Persisted application state. */
export interface AppState {
  pods: Pod[]
  folders: Folder[]
  activePodId: PodId | null
  /**
   * Services the user typed in by hand for the music Pod, most recent first.
   *
   * Only the ones that are NOT in MUSIC_SITES: a webradio, a self-hosted
   * server, anything the built-in list does not cover. Those are the ones worth
   * remembering, because they took typing and the list cannot offer them.
   * Capped, since this is a shortcut and not a history.
   */
  musicUrls?: string[]
  /** The Pod driven by the mini player at the foot of the sidebar. It is an
   *  ordinary Pod in every other respect - its own partition, its own login -
   *  but it lives in its own slot instead of the list above, and only one Pod
   *  holds the role at a time. Null until the user picks a music service. */
  musicPodId?: PodId | null
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The music services offered when setting up the music Pod. A convenience, not
 * a restriction: the picker also takes any URL, so a webradio or a self-hosted
 * server is just as welcome. Ordered roughly by how common they are.
 */
export interface MusicSite {
  name: string
  url: string
}

export const MUSIC_SITES: readonly MusicSite[] = [
  { name: 'YouTube Music', url: 'https://music.youtube.com/' },
  { name: 'YouTube', url: 'https://www.youtube.com/' },
  { name: 'SoundCloud', url: 'https://soundcloud.com/' },
  { name: 'Deezer', url: 'https://www.deezer.com/' },
  { name: 'Apple Music', url: 'https://music.apple.com/' },
  { name: 'Tidal', url: 'https://listen.tidal.com/' },
  { name: 'Bandcamp', url: 'https://bandcamp.com/' }
]

/**
 * What the music Pod's page reports about what it is playing, read from the
 * standard `navigator.mediaSession` - the same thing that feeds the keyboard's
 * media keys and the Windows volume flyout. Every music service fills it in,
 * so nothing here is specific to any one of them.
 *
 * Runtime-only, like `unread`: never persisted. A restart shows an empty
 * player until the Pod is loaded and playing again.
 */
export interface MediaReport {
  title: string
  artist: string
  album: string
  /** Largest artwork the page offered, or '' when it offered none. */
  artwork: string
  playing: boolean
  /** Whether the page actually handles these, so the buttons can be disabled
   *  rather than lie. */
  canNext: boolean
  canPrevious: boolean
  /**
   * Whether scrubbing and setting a level can do anything at all.
   *
   * Same honesty as canNext, for the two controls that used to be drawn as
   * usable whatever the page offered. Both need something to act ON: a page
   * that drives audio without a media element this side can see (SoundCloud)
   * has no level to set and nothing to seek, so the slider moved and the sound
   * did not.
   */
  canSeek: boolean
  canVolume: boolean
  /** Seconds into the track, and its length. Both 0 when the page offers
   *  neither a media element nor a position state. */
  position: number
  duration: number
  /** 0..1, read from the page's own media element - distinct from `muted`,
   *  which silences the whole Pod from outside the page. */
  volume: number
}

/**
 * What the player is given: the page's report plus the parts only main can
 * know. Muting is done on the Pod's web contents rather than through the page,
 * so it works whatever the site does; the history flags come from Chromium.
 */
export interface MediaInfo extends MediaReport {
  muted: boolean
  canGoBack: boolean
  canGoForward: boolean
}

/**
 * What the player asks for. The first three are replayed into the page through
 * its media-session handlers; the last three are answered by main on the Pod's
 * web contents and need no cooperation from the site at all.
 */
export type MediaCommand =
  | 'playpause'
  | 'next'
  | 'previous'
  | 'togglemute'
  | 'back'
  | 'forward'
  | 'seek'
  | 'volume'

/** A command plus its argument, for the two that need one: `seek` takes
 *  seconds, `volume` a 0..1 level. */
export interface MediaAction {
  command: MediaCommand
  value?: number
}

/**
 * main -> overlay: draw the media drawer beside the mini player, or hide it
 * with null.
 *
 * Plain chrome-viewport coordinates, in CSS pixels - the overlay window sits
 * exactly over the chrome's content area, so they mean the same thing on both
 * sides. The history square is placed the same way and lands correctly, which
 * is the evidence that this is the right frame of reference.
 *
 * Worth recording, because it looks like it should need more care than it does:
 * routing these through SCREEN coordinates instead makes it WORSE, because
 * `window.screenX/Y` do not mean the same thing in a framed window and in a
 * frameless one - the conversion then adds a constant offset of roughly the
 * title bar's height.
 *
 * All three are sent, rather than deriving the height from the overlay's own
 * viewport, so the strip's size is decided entirely by the window that can
 * actually measure the slot.
 */

export interface MediaPanelPayload {
  info: MediaInfo
  /** Left edge: the sidebar's right edge. */
  x: number
  /** Top edge: the rule above the music Pod's slot. */
  top: number
  /** From that rule down to the foot of the content area. */
  height: number
}

/**
 * main -> overlay: the history square drawn INSIDE the music Pod's content
 * area, top-left, or null to remove it.
 *
 * It cannot be drawn by the chrome renderer for the usual reason - the Pod's
 * native view covers it - and it exists only for this Pod: a music service
 * navigates you away from the player with every link, and there is no browser
 * chrome to come back with.
 */
export interface MusicNavPayload {
  x: number
  y: number
  canGoBack: boolean
  canGoForward: boolean
}

/** A tooltip request: text plus the anchor point (right-centre of the icon). */
export interface TooltipPayload {
  text: string
  x: number
  y: number
}

/** Pod page -> main: fields captured from a web app's `window.Notification`. */
export interface PodNotifyPayload {
  title: string
  body?: string
  icon?: string
}

/** main -> overlay: a themed toast drawn above the Pods (replaces the web
 *  app's native/OS notification so it fits DeskPods and never blocks). */
export interface OverlayToast {
  podId: PodId
  podName: string
  title: string
  body?: string
}

/** Progress of an in-page search, pushed by main while the user types. */
export interface FindResult {
  /** Total number of matches on the page. */
  matches: number
  /** 1-based index of the highlighted match, 0 when there is none. */
  activeMatch: number
}

/** Payload to create a Pod; id/order/profile are assigned by main. */
export interface CreatePodInput {
  /** Optional; when empty, main derives it from the URL hostname and later
   *  from the page title once the Pod has loaded. */
  name?: string
  url: string
  icon?: string
  folderId?: FolderId | null
  /** Optional id of an existing Pod whose session (Chromium partition) to
   *  share, so one login (e.g. Google) covers several Pods. Distinct from
   *  `folderId`, which is purely visual and never affects isolation. */
  linkTo?: PodId
}

/** How the next `findInPage` call should move through the matches. */
export interface FindOptions {
  /** Search downwards (default) or upwards. */
  forward?: boolean
  /** True jumps to the next match of the text already being searched; leave it
   *  unset to start a new search. */
  findNext?: boolean
  /** Distinguish "Polski" from "polski". */
  matchCase?: boolean
}

/** Fields of a Pod the user can edit directly. */
export type PodPatch = Partial<Pick<Pod, 'name' | 'url' | 'icon'>>

/** Fields of a Folder the user can edit directly. */
export type FolderPatch = Partial<Pick<Folder, 'name' | 'icon' | 'color' | 'collapsed'>>

/** New placement of a Pod after a drag & drop operation. */
export interface PodPlacement {
  id: PodId
  folderId: FolderId | null
  order: number
}

/** New placement of a Folder after reordering. */
export interface FolderPlacement {
  id: FolderId
  order: number
}

/**
 * Actions raised inside main that the chrome has to carry out: the native
 * context menus (which must paint above the Pods' native views) and the
 * page-level keys pressed while a Pod has focus. Both travel over `uiCommand`.
 */
export type UiCommand =
  | { type: 'add-pod-in-folder'; folderId: FolderId }
  /** Ctrl+F inside a Pod: open the find bar under the active Pod. */
  | { type: 'find-in-page' }
  /** A Pod's page asked to run git and has no answer on file yet. */
  | { type: 'git-permission'; id: PodId; origin: string }
  /** A Pod's page asked to run a command line that its answer on file does not
   *  cover. `command` is the line itself: an authorisation asked on a concrete
   *  case gets decided, asked in the abstract it gets clicked. */
  | { type: 'exec-permission'; id: PodId; origin: string; command: string }
  /** A Pod's page asked to drive a background page and has no answer yet. */
  | { type: 'scripting-permission'; id: PodId; origin: string; target: string }
  /** A Pod's page asked to download a file and has no answer on file yet. */
  | { type: 'download-permission'; id: PodId; origin: string; url: string }
  | { type: 'rename-pod'; id: PodId }
  | { type: 'edit-pod-url'; id: PodId }
  | { type: 'folder-settings'; id: FolderId }
  /** Change which service the music Pod points at, without deleting it. */
  | { type: 'music-pod' }

/**
 * The IPC surface exposed to the renderer as `window.deskpods`.
 * Every channel is explicit and typed.
 */
export interface DeskPodsApi {
  getState(): Promise<AppState>
  createPod(input: CreatePodInput): Promise<Pod>
  activatePod(id: PodId): Promise<void>
  /** Report the workspace region so main can position the active WebContentsView. */
  updateBounds(bounds: Rect): Promise<void>
  /** Hide the active Pod's web view while an HTML overlay (dialog) is shown,
   *  since native views always paint above the renderer chrome. */
  setOverlay(active: boolean): Promise<void>

  // Editing & organisation.
  updatePod(id: PodId, patch: PodPatch): Promise<void>
  reorderPods(placements: PodPlacement[]): Promise<void>
  createFolder(name: string): Promise<Folder>
  updateFolder(id: FolderId, patch: FolderPatch): Promise<void>
  reorderFolders(placements: FolderPlacement[]): Promise<void>

  // In-page search of the active Pod (Chromium's own find, so matches are
  // highlighted by the engine itself).
  findInPage(text: string, options?: FindOptions): Promise<void>
  stopFindInPage(): Promise<void>
  /** Subscribe to match counts for the running search. Returns an unsubscribe
   *  function. */
  onFindResult(listener: (result: FindResult) => void): () => void

  // Native context menus (rendered by main to avoid z-order issues with the
  // Pod's native web view).
  showPodMenu(id: PodId): Promise<void>
  showFolderMenu(id: FolderId): Promise<void>

  /** Open a native file picker (PDF/HTML) and return the chosen file as a
   *  `file://` URL, or null if the dialog was cancelled. */
  pickFile(): Promise<string | null>
  /** Open a native folder picker and return the absolute path, or null. */
  pickFolder(): Promise<string | null>
  /** Answer the git permission prompt for a Pod. `root` is the folder the user
   *  picked; a null root (or allowed=false) records a refusal. */
  resolveGitPermission(id: PodId, allowed: boolean, root: string | null): Promise<void>
  /** Answer the exec permission prompt for a Pod. `allow` is the list of
   *  program names granted (added to whatever was already granted); pass null
   *  to allow every command. Ignored when `allowed` is false. */
  resolveExecPermission(id: PodId, allowed: boolean, allow: string[] | null): Promise<void>
  /** Answer the scripting permission prompt for a Pod. */
  resolveScriptingPermission(id: PodId, allowed: boolean): Promise<void>
  /** Answer the download permission prompt for a Pod. */
  resolveDownloadPermission(id: PodId, allowed: boolean): Promise<void>

  // The music Pod and the mini player at the foot of the sidebar.
  /** Give the music-Pod role to this Pod, or pass null to clear it. The Pod
   *  itself is untouched - only which slot it appears in.
   *
   *  `enableAdblock` is the one exception, and it is passed explicitly rather
   *  than folded into a patch: `PodPatch` deliberately cannot write `settings`,
   *  so the renderer can never hand a Pod its own git or exec grant. This says
   *  "tick ad blocking", nothing else, and is only used when the Pod was just
   *  created for the role. */
  setMusicPod(id: PodId | null, options?: { enableAdblock?: boolean }): Promise<void>
  /**
   * Point the music Pod at a service, in ONE operation owned by main.
   *
   * It navigates unconditionally, including to the service already stored:
   * picking a service means "take me there", and after browsing around inside
   * it the stored url is no longer where the page is. The renderer used to do
   * this as a patch plus an activate, and the patch only navigated when the url
   * differed from the one on record, which is how switching back to a service
   * could quietly do nothing.
   */
  setMusicService(url: string, name?: string): Promise<void>
  /** Drive whatever the music Pod is playing. Ignored when it has no live
   *  view: nothing is queued, since there is nothing to command yet. */
  sendMediaCommand(command: MediaCommand, value?: number): Promise<void>
  /** Subscribe to what the music Pod is playing (null when it is playing
   *  nothing). Returns an unsubscribe function. */
  onMediaState(listener: (info: MediaInfo | null) => void): () => void
  /** Ask main to draw the media panel over the workspace, anchored at this
   *  point; null hides it. It is drawn in the overlay window because anything
   *  the renderer draws there would be painted over by the Pod's native view. */
  showMediaPanel(anchor: { x: number; top: number; height: number } | null): Promise<void>

  // Tooltips are drawn in a transparent overlay window so they can sit above
  // the Pod's native web view.
  showTooltip(payload: TooltipPayload): Promise<void>
  hideTooltip(): Promise<void>
  /** Overlay window only: receive tooltip payloads (null hides). */
  onTooltip(listener: (payload: TooltipPayload | null) => void): () => void
  /** Overlay window only: receive themed toasts to display above the Pods.
   *  Returns an unsubscribe function. */
  onToast(listener: (toast: OverlayToast) => void): () => void
  /** Overlay window only: receive the active Pod's zoom level (in percent) to
   *  flash above the page. Returns an unsubscribe function. */
  onZoomIndicator(listener: (percent: number) => void): () => void
  /** Overlay window only: receive the media panel to draw beside the mini
   *  player (null hides it). Returns an unsubscribe function. */
  onMediaPanel(listener: (payload: MediaPanelPayload | null) => void): () => void
  /** Overlay window only: receive the music Pod's history square (null removes
   *  it). Returns an unsubscribe function. */
  onMusicNav(listener: (payload: MusicNavPayload | null) => void): () => void
  /** Overlay window only: a button in the media panel was pressed. Deliberately
   *  the ONLY thing the overlay can ask for beyond drawing - its content is
   *  built from text a web app supplies, so its bridge stays narrow. */
  sendOverlayMediaCommand(command: MediaCommand, value?: number): void
  /** Overlay window only: whether the pointer is over the media panel, so it
   *  survives leaving the sidebar to reach it. */
  reportMediaPanelHover(hovering: boolean): void
  /** Overlay window only: report the regions that must receive mouse clicks
   *  (currently the toasts, which are dismissed by clicking them). The overlay
   *  is click-through everywhere else. Send an empty list once nothing is
   *  clickable any more. */
  reportHitAreas(areas: Rect[]): void
  /** Overlay window only: report that no tooltip/toast is visible any more, so
   *  main can hide the overlay window (a hidden window costs the compositor
   *  nothing; a visible transparent one is blended every frame). */
  overlayIdle(): void

  /** Subscribe to Pod metadata updates pushed by main (title, favicon).
   *  Returns an unsubscribe function. */
  onPodUpdated(listener: (pod: Pod) => void): () => void
  /** Subscribe to actions raised by main's native context menus (the ones that
   *  open a dialog in the chrome). Returns an unsubscribe function. */
  onUiCommand(listener: (command: UiCommand) => void): () => void
  /** Subscribe to full-state replacements pushed by main after a native
   *  context-menu mutation. Returns an unsubscribe function. */
  onStateChanged(listener: (state: AppState) => void): () => void
}

/**
 * The slice of the API the overlay window is given. It draws what main pushes
 * and reports back; it can change nothing - which matters, because what it
 * draws comes from web apps (a notification's title), and the window that draws
 * it has no business answering permission prompts.
 */
export type OverlayApi = Pick<
  DeskPodsApi,
  | 'onTooltip'
  | 'onToast'
  | 'onZoomIndicator'
  | 'onMediaPanel'
  | 'onMusicNav'
  | 'sendOverlayMediaCommand'
  | 'reportMediaPanelHover'
  | 'reportHitAreas'
  | 'overlayIdle'
>

/** IPC channel names, kept in one place to avoid string drift. */
export const IpcChannels = {
  getState: 'app:getState',
  createPod: 'pods:create',
  activatePod: 'pods:activate',
  updateBounds: 'pods:updateBounds',
  setOverlay: 'ui:setOverlay',
  updatePod: 'pods:update',
  findInPage: 'pods:findInPage',
  stopFindInPage: 'pods:stopFindInPage',
  reorderPods: 'pods:reorder',
  createFolder: 'folders:create',
  updateFolder: 'folders:update',
  reorderFolders: 'folders:reorder',
  showPodMenu: 'ui:podMenu',
  showFolderMenu: 'ui:folderMenu',
  /** renderer -> main: open a native file picker, returns a file:// URL. */
  pickFile: 'dialog:pickFile',
  /** renderer -> main: open a native folder picker, returns an absolute path. */
  pickFolder: 'dialog:pickFolder',
  /** Pod page -> main: run a git command (see PodGitAccess). */
  podGit: 'pods:git',
  /** renderer -> main: the user answered the git permission prompt. */
  gitPermission: 'pods:gitPermission',
  /** Pod page -> main: run a command line (see PodExecAccess). */
  podExec: 'pods:exec',
  /** Pod page -> main: start a command that outlives one answer, then follow
   *  it (an agent session, a long build) and stop it. */
  podExecStart: 'pods:execStart',
  podExecPoll: 'pods:execPoll',
  podExecKill: 'pods:execKill',
  /** renderer -> main: the user answered the exec permission prompt. */
  execPermission: 'pods:execPermission',
  /** Pod page -> main: read the granted folder and the files in it. Covered by
   *  the git permission, which already allows as much. */
  podListDir: 'pods:listDir',
  podReadFile: 'pods:readFile',
  podWriteFile: 'pods:writeFile',
  /** Pod page -> main: open / drive / close a background page. */
  podOpenPage: 'pods:openPage',
  podRunScript: 'pods:runScript',
  podClosePage: 'pods:closePage',
  /** renderer -> main: the user answered the scripting permission prompt. */
  scriptingPermission: 'pods:scriptingPermission',
  /** Pod page -> main: download a file with this Pod's session, stop one, or
   *  show a finished one in the file manager. */
  podDownloadStart: 'pods:download:start',
  podDownloadCancel: 'pods:download:cancel',
  podDownloadReveal: 'pods:download:reveal',
  /** main -> Pod page push: how one of its downloads is doing. */
  podDownloadProgress: 'pods:download:progress',
  /** renderer -> main: the user answered the download permission prompt. */
  downloadPermission: 'pods:downloadPermission',
  /** Pod page -> main: the web app raised a Notification (via the Pod preload). */
  podNotification: 'pods:notification',
  /** Music Pod page -> main: what it is playing now (via the Pod preload). */
  podMedia: 'pods:media',
  /** main -> music Pod page push: a transport command from the mini player. */
  podMediaCommand: 'pods:media:command',
  /** renderer -> main: drive the music Pod, or give the role to another Pod. */
  mediaCommand: 'app:mediaCommand',
  setMusicPod: 'app:setMusicPod',
  setMusicService: 'app:setMusicService',
  /** renderer -> main: the pointer entered (payload) or left (null) the mini
   *  player, so the media panel can be drawn in the overlay window. */
  showMediaPanel: 'app:mediaPanel:show',
  /** main -> overlay window push: the media panel, or null to hide it. */
  mediaPanel: 'ui:mediaPanel',
  /** main -> overlay window push: the music Pod's history square, or null. */
  musicNav: 'ui:musicNav',
  /** overlay window -> main: a button in the media panel was pressed. */
  overlayMediaCommand: 'ui:mediaPanel:command',
  /** overlay window -> main: the pointer is over the panel, so it must stay up
   *  even though it has left the sidebar. */
  mediaPanelHover: 'ui:mediaPanel:hover',
  /** main -> renderer push: what the music Pod is playing (null when it is
   *  playing nothing, or has no live view). */
  mediaState: 'app:mediaState',
  tooltipShow: 'ui:tooltip:show',
  tooltipHide: 'ui:tooltip:hide',
  /** main -> renderer push. */
  podUpdated: 'pods:updated',
  /** main -> renderer push: match count for the running in-page search. */
  findResult: 'pods:findResult',
  uiCommand: 'ui:command',
  stateChanged: 'app:stateChanged',
  /** overlay window -> main: nothing visible, the overlay can be hidden. */
  overlayIdle: 'ui:overlay:idle',
  /** overlay window -> main: regions of the overlay that must be clickable. */
  overlayHitAreas: 'ui:overlay:hitAreas',
  /** main -> overlay window push. */
  tooltip: 'ui:tooltip',
  /** main -> overlay window push: a themed notification toast. */
  overlayToast: 'ui:toast',
  /** main -> overlay window push: the zoom level to flash above the Pod. */
  zoomIndicator: 'ui:zoom'
} as const
