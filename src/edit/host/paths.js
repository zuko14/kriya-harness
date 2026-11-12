// Where the Host keeps things (ARCHITECTURE §5): never in a synced folder (EF-28).

import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

import { kriyaHome } from "../../paths.js"

export const editHome = (home = kriyaHome()) => join(home, "edit")
const PIPE = "\\\\.\\pipe\\"
/** True for a Windows named pipe: it isn't a file, so it has no mode to set and nothing to remove. */
export const isPipe = (path) => path.startsWith(PIPE)
/**
 * Where the Host listens for this computer's own commands. A Unix socket in the Host's folder;
 * on Windows, which has none there, a named pipe, one per Kriya home (a hash of its path,
 * which Windows compares without case).
 * A pipe gets Windows' default access rules, not the socket's owner-only mode, and Node can't narrow them;
 * so (TP11) every command on the channel carries the Host's per-launch token (tokenPath), which only this
 * account can read. Not yet run on Windows (EQ-11).
 */
export function socketPath(home = kriyaHome(), platform = process.platform) {
  if (platform !== "win32") return join(editHome(home), "host.sock")
  return `${PIPE}kriya-edit-host-${createHash("sha256").update(resolve(home).toLowerCase()).digest("hex").slice(0, 16)}`
}
export const lockPath = (home) => join(editHome(home), "host.lock")
/** TP11: the running Host's secret for its own channel, made fresh at each launch, readable by its owner only. */
export const tokenPath = (home) => join(editHome(home), "host.token")
export const TOKEN_HEADER = "x-kriya-edit-token"
/** The running Host's token, or null when none is there (no Host yet, or one from before TP11). */
export function hostToken(home = kriyaHome()) {
  try {
    const token = readFileSync(tokenPath(home), "utf8").trim()
    return /^[a-f0-9]{64}$/.test(token) ? token : null
  } catch {
    return null
  }
}
/** The headers a command to the Host carries. */
export const hostHeaders = (home = kriyaHome()) => {
  const token = hostToken(home)
  return { host: "kriya-edit", ...(token ? { [TOKEN_HEADER]: token } : {}) }
}
export const portPath = (home) => join(editHome(home), "port")
export const logPath = (home) => join(editHome(home), "host.log")

const SRC = join(import.meta.dirname, "..", "..")

/**
 * A fingerprint of the code a Host runs: every source file's name, size and time. A
 * running Host keeps the code it started with, so after an update the Studio looked new
 * (its files are read per request) while the Host ran the old Director (found 2026-11-09).
 */
export function codeStamp(root = SRC) {
  const hash = createHash("sha256")
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(js|swift)$/.test(entry.name)) {
        const { size, mtimeMs } = statSync(path)
        hash.update(`${path.slice(root.length)}:${size}:${mtimeMs}\n`)
      }
    }
  }
  walk(root)
  return hash.digest("hex").slice(0, 16)
}
