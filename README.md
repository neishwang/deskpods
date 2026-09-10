# DeskPods

**A lightweight home for your web apps.**

DeskPods hosts web applications inside isolated Pods: a sidebar of icons, one app
visible at a time, no tabs, no address bar, no browser chrome. It is not a
browser — it is a dedicated place for the handful of tools that would otherwise
monopolise a browser window: Gmail, Teams, Slack, Notion, Jira, an internal
dashboard, anything that runs in Chromium.

A Pod is a URL. There is no catalogue and no list of supported apps.

## Isolation

Each Pod owns a persistent Chromium partition — its own cookies, localStorage,
IndexedDB, cache, service workers and credentials. Two Pods pointing at the same
service are two independent accounts, and neither can see the other's session.

When you *want* a shared login (one Google account across Gmail, Calendar and
Drive), create the Pod as *linked*: it reuses the partition of an existing Pod
on purpose. Folders never affect isolation — they are purely visual.

A Pod's pages are also held to what a web app actually needs: notifications
(the unread badge is built on them), the clipboard, fullscreen, pointer lock and
storage. Microphone, camera, screen capture, location, USB, serial, HID and idle
detection are refused outright — a Pod is a web site, and none of those should be
granted just because it asked.

## Getting started

Requires [Bun](https://bun.sh) and, for the git bridge, `git` on your `PATH`.

```sh
bun install
bun run dev
```

To produce a Windows build (a zip and a portable exe in `dist/`):

```sh
bun run build:win
```

## Using it

**Pods.** The `+` button adds one from a URL; the name and favicon are detected
from the page. Right-click a Pod for Rename, Edit URL, Move to, Suspend and
Delete. Suspend frees a Pod's memory and GPU cost without touching its session —
the next click reloads it.

**Folders.** Drop a Pod onto another to create a folder holding both. Drag to
reorder anywhere, right-click a folder for its name, colour and icon. A folder
left empty disappears on its own.

**Inside a page**, the browser reflexes work:

| | |
|---|---|
| `F5`, `Ctrl+R` | reload (`Shift` variants ignore the cache) |
| `Alt+←`, `Alt+→`, mouse side buttons | history |
| `Ctrl+wheel`, `Ctrl++`, `Ctrl+-`, `Ctrl+0` | zoom, remembered per Pod, shown as a pill above the page |
| `Ctrl+F` | find in page — again to close, `Enter` / `Shift+Enter` to step, with a *Match case* box |

Right-click gives the usual page menu: spelling suggestions, undo/redo, image
actions, opening or searching a selection in your real browser, back/forward and
reload.

**Notifications.** Web notifications are captured rather than shown by the OS:
they become themed toasts above the page, and the taskbar icon carries the total
unread count (read from page titles, e.g. `(3) Discord`).

**Keep Awake.** Only the Pod on screen is visible, so Chromium backgrounds the
others: their timers slow down and the page is told it is hidden — which is how
a chat app decides you are away and drops its connection. *Keep Awake* in a
Pod's right-click menu opts that Pod out, and loads it a few seconds after
startup instead of on first click, so it is connected and notifying before you
have opened it. It costs battery and memory (and, Electron being what it is, one
awake Pod stops frame throttling for the whole window), which is why it is off
by default and set per Pod. *Suspend* still wins: it closes the page until the
next click, awake or not.

## Running git from a Pod

A locally hosted app can drive git through DeskPods, so a page can offer buttons
like *Commit* or *Push* without shipping a server. The bridge is exposed to the
page as:

```js
const result = await window.__deskpods.git(['status', '--porcelain'])
// { ok: true, code: 0, stdout: ' M README.md\n', stderr: '' }

// Optional cwd, RELATIVE to the folder you granted:
await window.__deskpods.git(['pull', '--rebase'], { cwd: 'services/api' })
```

`git(args, options?)` resolves with `{ ok, code, stdout, stderr, error? }`. A
command that fails is a normal answer (`ok: false` with git's exit code and
stderr); `error` is set only when DeskPods declined to run it at all, and the
promise never rejects.

### Permission

The first call from a Pod raises a prompt naming the page and asking you to pick
the folder git may work in. Your answer is stored **with that Pod**:

- allow once, and every later call from that Pod runs without a prompt;
- deny once, and every later call is refused without a prompt;
- take it back from the Pod's right-click menu (*Revoke Git Access* /
  *Reset Git Permission*), which makes the next call ask again;
- delete the Pod and the answer goes with it — recreating a Pod on the same URL
  asks from scratch, since permission follows the Pod, not the address.

While the prompt is open, further calls from that Pod wait on the same dialog
rather than stacking prompts.

### What is enforced

- **The folder.** Commands run in the folder you picked. `options.cwd` may only
  be a relative path that stays inside it; absolute paths and anything climbing
  out with `..` are refused.
- **No shell.** Arguments are passed as an array straight to the process, so
  `&&`, `|`, backticks and the rest are inert — they reach git as literal
  arguments and it complains about them.
- **No hanging.** Commands run with `GIT_TERMINAL_PROMPT=0` (a credential prompt
  would have no terminal to appear on), no pager, a 120 s timeout and a 16 MB
  output cap.

### What is not

**Every git command is allowed.** DeskPods does not filter subcommands or flags,
and some git flags run other programs by design — `git -c core.pager=<program>`,
`--upload-pack`, repository aliases. So any page loaded in an authorised Pod can
execute arbitrary code on your machine, not merely touch a repository. Grant this
to a Pod that loads an app you trust, keep such a Pod pointed at that app, and
revoke it when you no longer need it.

## Reading files from a Pod

The folder you granted for git is also readable — and writable — through three
calls, because a Pod that may run git there can already list it, read what is
tracked and rewrite the tree with a checkout. No extra prompt: the same grant,
the same folder, the same confinement.

```js
// One level of the folder, never recursive. Hidden entries included.
const { ok, entries } = await window.__deskpods.listDir('.')
// entries: [{ name: 'deskpods', directory: true }, { name: 'app.json', directory: false }]

// Text by default, base64 for anything binary.
const file = await window.__deskpods.readFile('config/app.json')
const data = JSON.parse(file.content)
const logo = await window.__deskpods.readFile('assets/logo.png', { encoding: 'base64' })

// Writing creates missing parent folders, inside the granted one only.
await window.__deskpods.writeFile('config/app.json', JSON.stringify(data, null, 2))
```

`listDir` resolves with `{ ok, entries, error? }`, `readFile` with
`{ ok, content, size, encoding, error? }` (files over 16 MB are refused), and
`writeFile` with `{ ok, error? }`. A missing file or a path outside the granted
folder is an `ok: false` answer, never a rejected promise.

## Running a command from a Pod

Anything that is not git — a build, a deployment script, an archiver — goes
through `exec`, which runs a real command line through the system shell:

```js
const result = await window.__deskpods.exec('dotnet build -c Release')
// { ok, code, stdout, stderr, error? } — the same shape as git()

await window.__deskpods.exec('npm ci', { cwd: 'web', timeout: 300000 })
```

`cwd` is relative to the folder granted for git, like everywhere else, and
`timeout` is clamped to 1 s … 10 min (120 s by default). Output is capped at
16 MB, and no console window flashes on screen.

### Secrets, and commands that outlive one answer

A secret goes on **standard input**, never on the command line: what is on the
line appears in the permission dialog and in the machine's process list.

```js
// A KeePass entry, master password fed through stdin.
const r = await window.__deskpods.exec('keepassxc-cli show -q -a Password vault.kdbx GitHub', {
  stdin: masterPassword
})
```

For anything that runs longer than an answer — an agent session, a build, a
deployment — start it and follow it:

```js
const { id } = await window.__deskpods.execStart(
  'cursor-agent -p --force --output-format json "fix the failing test"',
  { cwd: 'my-repo' }
)

for (;;) {
  const step = await window.__deskpods.execPoll(id)
  if (step.stdout) append(step.stdout)          // only what is new since last poll
  if (!step.running) break                      // step.code holds the exit code
  await new Promise((r) => setTimeout(r, 1000))
}

await window.__deskpods.execKill(id)            // ...or stop it early
```

`execStart` resolves with `{ ok, id, error? }`, `execPoll` with
`{ ok, running, stdout, stderr, code?, truncated?, error? }` — each poll carries
only what was printed since the previous one, so appending them in order gives
the whole output. `truncated` says output had to be dropped because nothing
polled for 4 MB. The default limit is 30 minutes (up to 24 h via `timeout`),
four commands at a time per Pod, and everything a Pod started is killed when it
is suspended, when Command Access is revoked, and when DeskPods quits — down the
whole process tree, so nothing carries on unseen.

Because the page polls rather than subscribing, a page that reloads mid-command
finds it again with its id instead of losing an event stream. A finished command
is kept for ten minutes so its last poll still carries the exit code; after that
its id is forgotten and polling answers `Unknown command.`

Two things to know when the command is an agent or any interactive tool:

- **stdin is closed behind you**, whether you passed one or not. A tool that
  stops to ask for confirmation will never get an answer and will sit there
  until its timeout — so run it in whatever non-interactive mode it offers
  (`--force` for `cursor-agent`, `-q` for `keepassxc-cli`, `--yes`, `--no-input`
  and friends elsewhere).
- **a poll hands over bytes, not lines.** It returns whatever arrived since the
  previous one, which can end mid-line. Parsing line-delimited output (NDJSON,
  say) means keeping the tail until its newline arrives:

```js
let rest = ''
// on every poll:
rest += step.stdout
const lines = rest.split('\n')
rest = lines.pop() ?? ''            // the last one may still be incomplete
for (const line of lines) if (line.trim()) handle(JSON.parse(line))
```

### Permission

This one is asked separately from git, and on the command itself: git is one
program, a shell is every program, and confining the working directory changes
nothing when a command line can name an absolute path of its own.

The prompt shows the exact line the page wants to run and offers two grants:

- **Allow “dotnet”** — only that program. DeskPods asks again the first time the
  Pod reaches for another one, and adds it to the list if you agree. While a
  list is in force, a line chaining a second command (`&`, `&&`, `|`, `;`, a
  redirection, `$(…)`, a backquote or a newline) is refused whatever it starts
  with, so `dotnet & rmdir /s /q data` does not slip through.
- **Allow every command** — the Pod may run anything you can run. A Pod is a web
  site; this hands it the machine, not a folder.

Denying is remembered too, and *Revoke Command Access* / *Reset Command
Permission* in the Pod's right-click menu makes the next call ask again.

## Driving another site from a Pod

A Pod can use another site as an API: open it once in a hidden page, wait until
it is ready, run as many scripts as needed against that same loaded document,
then close it.

```js
// Open once, and wait for the site to be genuinely ready — not just loaded.
const page = await window.__deskpods.openPage('https://target.example', {
  waitFor: "typeof _MCS !== 'undefined'",
  timeout: 30000
})

// Several scripts, same document, no reload in between.
const a = await window.__deskpods.runScript(page.id, "_MCS.getObject('a')")
const b = await window.__deskpods.runScript(page.id, "_MCS.getObject('b')")

await window.__deskpods.closePage(page.id)

console.log(a.value, b.value)
```

`openPage(url, options?)` resolves with `{ ok, id, url, error? }`. `waitFor` is a
JavaScript expression polled in the page until it turns truthy, which is how you
wait for a global the site installs after load; without it, `openPage` returns as
soon as the page finishes loading.

`runScript(id, code)` resolves with `{ ok, value, error? }`. The code runs in the
page's own world, so globals the site defines are reachable, and its result is
awaited — an API returning a promise gives you the resolved value. A script that
throws comes back as `ok: false` with the message rather than as a rejection.
Values travel as JSON, so anything unserialisable (a DOM node, a circular
object) is reported as an error instead of arriving mangled.

The page keeps its state between calls: set something on `window` in one script
and the next one still sees it.

### Permission

Like git, the first call raises a one-shot prompt for that Pod, and the answer
is remembered with it — revocable from the Pod's right-click menu (*Revoke Page
Scripting*), forgotten when the Pod is deleted. The two permissions are separate:
granting git does not grant this.

### What it means

The hidden page loads **on the calling Pod's session**, so it is logged in
wherever that Pod is. That is what makes driving a real site possible, and it is
also the reason this is gated: it lets a page read cross-origin content that the
same-origin policy would normally hide from it. The grant covers any site, not
just the first one asked for.

Practical limits: `http`/`https` only, at most 4 background pages open per Pod,
each closed automatically after 5 minutes without a script, when its Pod is
suspended or deleted, and when the permission is revoked.

## Where your data lives

In a packaged build DeskPods is portable: settings *and* every Pod's Chromium
profile live in a `data/` folder next to the executable, so moving the app moves
your sessions with it. In development they sit in the usual Electron `userData`
directory. The app's own state — Pods, folders, per-Pod zoom and git
permissions — is a single `deskpods/state.json`.

Unread state is never persisted; it is derived at runtime.

That file is written by renaming a temporary one over it, so a crash mid-write
cannot leave it half-written. If it is ever unreadable anyway, DeskPods keeps it
as `state.json.corrupt-<timestamp>` and starts on the defaults rather than
quietly pretending you never had any Pods.

## Releases

Pushing a `v*` tag builds Windows artifacts on CI and publishes them as a GitHub
release — see [.github/workflows/release.yml](.github/workflows/release.yml).
The workflow refuses to publish if the tag and `package.json` disagree, or if
typecheck, lint or tests fail.

```sh
git tag -a v1.1.0 -m "…" && git push origin v1.1.0
```

## License

MIT — see [LICENSE](LICENSE). Fork it, ship it, do what you like with it.

## Development

```sh
bun run dev          # electron-vite with HMR
bun run typecheck    # both TS projects (main/preload and renderer)
bun run lint         # biome
bun run format       # biome, writing
bun run test         # vitest
bun run icon         # regenerate build/icon.png and the multi-size .ico
bun run build:win    # zip + portable exe into dist/
```

Three bundles plus a shared package:

- `packages/types` — domain models, the typed IPC surface and channel names.
  No Electron import; every new channel starts here.
- `src/main` — owns all state and all web content: one `WebContentsView` per
  Pod, native menus, notifications, persistence, the git / command / file
  bridges and the background pages a Pod can drive.
- `src/preload` — two bridges: `window.deskpods` for the chrome, and a minimal
  `window.__deskpods` (notifications, git, commands, files, background
  pages) injected into Pod
  pages.
- `src/renderer` — the React chrome (sidebar, dialogs, find bar), plus a second
  tiny renderer in `src/overlay` for what must paint above the Pods.

One constraint shapes most of the UI: a `WebContentsView` always paints above
the renderer. Anything that must appear over a page therefore either lives in
the transparent overlay window (tooltips, toasts, the zoom pill), asks main to
hide the view (dialogs), or takes room away from it (the find bar).
