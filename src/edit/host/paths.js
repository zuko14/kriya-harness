// Where the Host keeps things (ARCHITECTURE §5): never in a synced folder (EF-28).

import { createHash } from "node:crypto"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

import { kriyaHome } from "../../paths.js"

export const editHome = (home = kriyaHome()) => join(home, "edit")
export const socketPath = (home) => join(editHome(home), "host.sock")
export const lockPath = (home) => join(editHome(home), "host.lock")
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
