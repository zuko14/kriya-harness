import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Where things live: this package, the pinned DSH it launches, and the
// Kriya home (DSH_HOME for every profile it boots).

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const require = createRequire(join(PACKAGE_ROOT, "package.json"))

export const PACKAGE = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"))

/** The client version sent as X-Kriya-Harness (plain x.y.z, as the contract requires). */
export const CLIENT_VERSION = PACKAGE.version

const DSH_PACKAGE = require.resolve("@deepseek-ai/dsh/package.json")

/** The pinned DSH version (exact, from its own package.json). */
export const DSH_VERSION = JSON.parse(readFileSync(DSH_PACKAGE, "utf8")).version

/** DSH's own launcher; booting stays DSH's ("only dsh profiles launch"). */
export const DSH_BIN = join(dirname(DSH_PACKAGE), "lib", "bin.js")

/** The Kriya home: KRIYA_HOME, else ~/.kriya. Read per call so tests can set it. */
export function kriyaHome() {
  return process.env.KRIYA_HOME || join(homedir(), ".kriya")
}
