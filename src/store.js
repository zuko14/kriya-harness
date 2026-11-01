import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { kriyaHome } from "./paths.js"

// The device sign-in, kept on this machine only: one JSON file readable by
// the same OS user (0600 in a 0700 directory), the property DSH's own
// credentials-local store gives (DSH_DISTRIBUTION §3, P-AUTH). The server
// keeps only the token's sha256.

const FILE = "device.json"

const path = () => join(kriyaHome(), FILE)

export function ensureHome() {
  const home = kriyaHome()
  mkdirSync(home, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") chmodSync(home, 0o700)
  return home
}

/** @returns {{ url: string, token: string, deviceId: string } | null} */
export function readDevice() {
  if (!existsSync(path())) return null
  try {
    const value = JSON.parse(readFileSync(path(), "utf8"))
    if (typeof value?.url === "string" && typeof value?.token === "string") return value
  } catch {
    // A broken file is the same as no sign-in; `kriya login` rewrites it
  }
  return null
}

/** @param {{ url: string, token: string, deviceId: string }} device */
export function writeDevice(device) {
  ensureHome()
  writeFileSync(path(), JSON.stringify(device, null, 2) + "\n", { mode: 0o600 })
  if (process.platform !== "win32") chmodSync(path(), 0o600)
}

export function deleteDevice() {
  rmSync(path(), { force: true })
}

/** Normalises the Kriya address the person gives: https only (http for localhost), no path. */
export function kriyaUrl(raw) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    throw new Error(`Not a web address: ${raw}`)
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("Use the https:// address of your Kriya account.")
  }
  return url.origin
}
