// Chrome confinement (ES-05, EDD-44): HyperFrames starts Chrome with --no-sandbox
// (EH-27) and doesn't stop a composition reaching the network (EX-14), so the OS
// sandbox is the boundary. Every Chrome render runs inside it: no network except
// loopback, no reading people's files, writing only to its own work folder.

import { existsSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"

import { activeRuntime } from "../runtime/setup.js"
import { EngineFailure } from "./tool.js"

const SANDBOX_EXEC = "/usr/bin/sandbox-exec"
// TP11 (EQ-11): Linux's bubblewrap where the distribution puts it; never a PATH lookup a folder could shadow
export const BWRAP_PATHS = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"]
// The system's own read-only parts a confined Chrome needs on Linux (libraries, fonts, certificates); never /home
const LINUX_SYSTEM = ["/usr", "/lib", "/lib64", "/lib32", "/bin", "/sbin", "/etc/fonts", "/etc/ssl", "/etc/ld.so.cache", "/etc/alternatives"]
// Windows: an AppContainer runner the Media Runtime ships and verifies by hash (manifest artifact), or nothing
export const WINDOWS_RUNNER = "appcontainer-runner"
// Where people's files and other programs' temporary files live
const PRIVATE = ["/Users", "/Volumes", "/private/tmp", "/private/var/folders", "/private/var/tmp"]

const real = (path) => realpathSync(path)
// SBPL string literal: our own absolute paths, refused if they could break out of the quotes
function quoted(path) {
  if (!path.startsWith("/") || /["\\\n\r\0]/.test(path)) throw new RangeError(`a confinement path must be a plain absolute path, got "${path}"`)
  return `"${path}"`
}

/**
 * The Windows runner the active Media Runtime installed, verified by hash at install: the manifest's
 * `appcontainer-runner` artifact for win32-x64, present on disk. No signed manifest carries one yet (EQ-11).
 * @returns {string | null}
 */
export function windowsRunner(runtime = activeRuntime(), exists = existsSync) {
  const artifact = runtime?.manifest?.platforms?.["win32-x64"]?.artifacts?.find((a) => a.id === WINDOWS_RUNNER)
  if (!artifact || typeof artifact.entry !== "string") return null
  const path = join(runtime.dir, artifact.id, artifact.entry)
  return exists(path) ? path : null
}

/**
 * What this computer can confine with, or why it can't. Never an open process called confined (ES-05):
 * macOS's sandbox-exec, Linux's bubblewrap, or the Windows runner the Media Runtime ships; else none.
 * @returns {{ kind: "sandbox-exec" } | { kind: "bwrap", path: string } | { kind: "appcontainer", path: string } | { kind: null, missing: string }}
 */
export function confinement(platform = process.platform, exists = existsSync, { runner = () => windowsRunner(undefined, exists) } = {}) {
  if (platform === "darwin" && exists(SANDBOX_EXEC)) return { kind: "sandbox-exec" }
  if (platform === "linux") {
    const path = BWRAP_PATHS.find((candidate) => exists(candidate))
    if (path) return { kind: "bwrap", path }
    return { kind: null, missing: "The motion layer runs Chrome inside bubblewrap on Linux, and it isn't installed. Install the bubblewrap package (bwrap), then try again." }
  }
  if (platform === "win32") {
    const path = runner()
    if (path) return { kind: "appcontainer", path }
    return { kind: null, missing: "The motion layer runs Chrome inside an AppContainer on Windows, and this Media Runtime has no runner for it yet." }
  }
  return { kind: null, missing: "The motion layer runs Chrome inside the operating system's sandbox, and this system's sandbox isn't supported yet." }
}

// A path handed to a sandbox: absolute, and nothing that could end an argument or a line
function plain(path) {
  if (!(path.startsWith("/") || /^[A-Za-z]:\\/.test(path)) || /["\n\r\0]/.test(path)) throw new RangeError(`a confinement path must be a plain absolute path, got "${path}"`)
  return path
}

/**
 * Linux (TP11): bubblewrap's arguments. Every namespace unshared, the network too, so only a loopback of its
 * own exists (Chrome and HyperFrames talk over it; nothing reaches another computer or this one's services);
 * the system's libraries read-only; the runtime read-only; the tile's folder read-write; a private /tmp; it
 * dies with its parent. No /home and no /Users unless a folder asked for sits there, and then only that folder.
 * @param {{ read: string[], write: string[] }} paths absolute; made real here
 */
export function bwrapArgs({ read, write }, exists = existsSync) {
  const r = [...new Set(read.map(real).map(plain))]
  const w = [...new Set(write.map(real).map(plain))]
  return [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--cap-drop",
    "ALL",
    ...LINUX_SYSTEM.filter((p) => exists(p)).flatMap((p) => ["--ro-bind", p, p]),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    ...r.flatMap((p) => ["--ro-bind", p, p]),
    ...w.flatMap((p) => ["--bind", p, p]),
  ]
}

/**
 * Windows (TP11): the runner's arguments, a seam for the runner the Media Runtime will ship. The folders it
 * may read and write, loopback only, then the command. Nothing here runs until a verified runner exists.
 */
export function appContainerArgs({ read, write }) {
  return [...read.map(plain).flatMap((p) => ["--read", p]), ...write.map(plain).flatMap((p) => ["--write", p]), "--network", "loopback", "--"]
}

/**
 * The macOS profile. Later rules win in SBPL, so the denials come first and the few
 * folders a render needs are let back in.
 * @param {{ read: string[], write: string[] }} paths absolute; made real here
 */
export function sandboxProfile({ read, write }) {
  const r = [...new Set(read.map(real))]
  const w = [...new Set(write.map(real))]
  return [
    "(version 1)",
    "(allow default)",
    // Chrome and HyperFrames talk over loopback; nothing reaches another computer. Never a
    // `local ip` rule: it matches every outbound connection (found in ED8). SBPL's
    // "localhost" is every address of this computer, not only 127.0.0.1, so services on
    // it stay reachable: the compositions' CSP and the lint are the barrier there (ES-05)
    "(deny network-outbound)",
    '(allow network-outbound (remote ip "localhost:*"))',
    `(deny file-read* file-write* ${PRIVATE.map((p) => `(subpath ${quoted(p)})`).join(" ")})`,
    // Paths resolve through their parents; names only, never contents
    "(allow file-read-metadata)",
    ...(r.length ? [`(allow file-read* ${r.map((p) => `(subpath ${quoted(p)})`).join(" ")})`] : []),
    ...(w.length ? [`(allow file-read* file-write* ${w.map((p) => `(subpath ${quoted(p)})`).join(" ")})`] : []),
  ].join("\n")
}

/**
 * Wraps a command so it runs confined. Refuses, never runs it open, when there is no sandbox.
 * @param {string} command
 * @param {string[]} args
 * @param {{ read: string[], write: string[] }} paths
 * @returns {{ command: string, args: string[] }}
 */
export function confine(command, args, paths, which = confinement()) {
  if (!which.kind) throw new EngineFailure("environment", "no_confinement", which.missing)
  if (which.kind === "bwrap") return { command: which.path, args: [...bwrapArgs(paths), "--", command, ...args] }
  if (which.kind === "appcontainer") return { command: which.path, args: [...appContainerArgs(paths), command, ...args] }
  if (which.kind !== "sandbox-exec") throw new EngineFailure("environment", "no_confinement", "This sandbox isn't one Kriya knows.")
  return { command: SANDBOX_EXEC, args: ["-p", sandboxProfile(paths), command, ...args] }
}

/** The folder a program's whole install lives in: Node's prefix, from its binary. */
export const installOf = (binary) => dirname(dirname(real(binary)))
