// Watch folders (TAVI_INTEGRATION §8, EDD-47). Off unless the person adds a folder on this
// computer. When a new recording settles, Kriya hears its name and duration, nothing else,
// and nothing runs until the person taps its card (ES-21).

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, extname, join, sep } from "node:path"

import { KriyaError } from "../../api.js"
import { probe } from "../engine/probe.js"
import { editHome } from "./paths.js"

const VIDEO = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"])
const FLICKS = 705_600_000
const TICK_MS = 60_000
const SEEN_MAX = 2000

const fileOf = (home) => join(editHome(home), "watch.json")

/** @returns {{ folders: string[], seen: Record<string, { size: number, mtime: number, told?: boolean }> }} */
function readState(home) {
  try {
    const kept = JSON.parse(readFileSync(fileOf(home), "utf8"))
    return { folders: Array.isArray(kept.folders) ? kept.folders : [], seen: kept.seen && typeof kept.seen === "object" ? kept.seen : {} }
  } catch {
    return { folders: [], seen: {} }
  }
}

function writeState(home, state) {
  const file = fileOf(home)
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 })
  renameSync(temporary, file)
}

/** The folder's id, as the daemon offers it (src/daemon.js projectId). */
export const folderId = (path) => createHash("sha256").update(path).digest("hex").slice(0, 16)

const videosIn = (folder) => {
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && VIDEO.has(extname(entry.name).toLowerCase()))
      .map((entry) => join(folder, entry.name))
  } catch {
    return [] // A folder that's gone, or a drive that's out: nothing to say today
  }
}

const statOf = (file) => {
  const { size, mtimeMs } = statSync(file)
  return { size, mtime: mtimeMs }
}

/** What's in it now counts as old, so adding a folder sends nothing. */
export function watchFolder(raw, { home, personal = homedir() }) {
  const path = realpathSync(raw)
  if (!statSync(path).isDirectory()) throw new Error("That isn't a folder.")
  if (path === realpathSync(personal) || path === sep || /^[A-Za-z]:\\?$/.test(path)) throw new Error("Watch one folder of recordings, not your whole home folder or a drive.")
  const state = readState(home)
  if (!state.folders.includes(path)) state.folders.push(path)
  for (const file of videosIn(path)) state.seen[file] = { ...statOf(file), told: true }
  writeState(home, state)
  return path
}

export function unwatchFolder(raw, { home }) {
  const state = readState(home)
  const path = existsSync(raw) ? realpathSync(raw) : raw
  const had = state.folders.includes(path)
  state.folders = state.folders.filter((folder) => folder !== path)
  for (const file of Object.keys(state.seen)) if (dirname(file) === path) delete state.seen[file]
  writeState(home, state)
  return had
}

export const watchedFolders = ({ home }) => readState(home).folders

/**
 * @param {{ home: string, send: (path: string, body: object) => Promise<any>, log: (line: string) => void, probeFile?: typeof probe, tickMs?: number }} options
 */
export function createWatcher({ home, send, log, probeFile = probe, tickMs = TICK_MS }) {
  let busy = false

  /** One look: a file reported once it has stayed the same size between two looks. */
  async function tick() {
    if (busy) return
    busy = true
    try {
      const state = readState(home)
      let changed = false
      for (const folder of state.folders) {
        for (const file of videosIn(folder)) {
          let now
          try {
            now = statOf(file)
          } catch {
            continue
          }
          const known = state.seen[file]
          if (known?.told) continue
          if (!known || known.size !== now.size || known.mtime !== now.mtime || now.size === 0) {
            state.seen[file] = now
            changed = true
            continue
          }
          try {
            const { facts } = await probeFile(file)
            if (!facts.duration) throw new Error("no duration")
            await send("/editing/found", { project: folderId(folder), name: basename(file).slice(0, 200), seconds: Math.round(facts.duration / FLICKS) })
            state.seen[file] = { ...now, told: true }
            changed = true
          } catch (error) {
            // Off on this Kriya, or still being written: the next look tries again. A folder
            // this computer doesn't offer, or a full Inbox, stays quiet until that changes
            if (!(error instanceof KriyaError && [404, 409, 429].includes(error.status))) log(`watch: ${error.code ?? error.name}`)
          }
        }
      }
      const files = Object.keys(state.seen)
      if (files.length > SEEN_MAX) {
        for (const file of files.slice(0, files.length - SEEN_MAX)) delete state.seen[file]
        changed = true
      }
      if (changed) writeState(home, state)
    } finally {
      busy = false
    }
  }

  const timer = setInterval(() => tick().catch((error) => log(`watch: ${error.name}`)), tickMs)
  timer.unref?.()
  return {
    tick,
    /** Folders on the list: the Host stays up for them. */
    count: () => readState(home).folders.length,
    close: () => clearInterval(timer),
  }
}
