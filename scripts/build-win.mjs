// One-command Windows packaging: bundles the JS (electron-vite) then packages
// the installers (electron-builder --win), working around the winCodeSign
// symlink-privilege error this machine hits (no Developer Mode / admin).
//
// electron-builder downloads a `winCodeSign` archive containing macOS .dylib
// SYMLINKS; creating symlinks on Windows needs Developer Mode or admin, so the
// extraction aborts and the final cache folder is never created. We pre-extract
// the archive ourselves with 7za (tolerating the 2 harmless .dylib failures)
// into the folder electron-builder expects, so it skips extraction entirely.
//
// Run via `npm run build:win`. Output (see electron-builder.yml): a zip and a
// portable .exe in `dist/`.

import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const root = process.cwd()
// Ensure local .bin resolves whether launched via npm or `node scripts/...`.
process.env.PATH = join(root, 'node_modules', '.bin') + delimiter + process.env.PATH

const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
const CACHE = join(localAppData, 'electron-builder', 'Cache', 'winCodeSign')
// Version pinned by electron-builder 25.x; bump if a future version changes it.
const FINAL = join(CACHE, 'winCodeSign-2.6.0')
const SEVENZ = join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')

/** Make sure the winCodeSign final folder exists so electron-builder won't try
 *  (and fail) to extract it. Returns true if it's ready, false if we can't
 *  prepare it yet (e.g. the archive hasn't been downloaded). */
function prepareCache() {
  if (existsSync(FINAL)) return true
  if (!existsSync(CACHE)) return false
  const archive = readdirSync(CACHE).find((f) => f.endsWith('.7z'))
  if (!archive || !existsSync(SEVENZ)) return false

  console.log(`[build-win] Pre-extracting ${archive} to bypass symlink error...`)
  // Exit code 2 is expected: the 2 macOS .dylib symlinks can't be created on
  // Windows. They're irrelevant here (signtool lives under windows-10/).
  spawnSync(SEVENZ, ['x', join(CACHE, archive), `-o${FINAL}`, '-y'], { stdio: 'inherit' })

  // Clean numeric temp dirs left behind by aborted extraction attempts.
  for (const entry of readdirSync(CACHE)) {
    if (/^[0-9]+$/.test(entry)) rmSync(join(CACHE, entry), { recursive: true, force: true })
  }
  return existsSync(FINAL)
}

function run(cmd) {
  execSync(cmd, { stdio: 'inherit' })
}

// 1. Bundle main/preload/renderer.
run('electron-vite build')

// 2. Prepare the cache up front when the archive is already present.
prepareCache()

// 3. Package. On a truly fresh cache the archive is only downloaded during this
//    step, so if it fails, try to prepare the cache and retry once.
try {
  run('electron-builder --win')
} catch (err) {
  console.log('[build-win] Packaging failed — attempting winCodeSign fix + one retry...')
  if (prepareCache()) run('electron-builder --win')
  else throw err
}

console.log('[build-win] Done. Artifacts are in dist/.')
