// Chrome confinement (ES-05, EDD-44): HyperFrames starts Chrome with --no-sandbox
// (EH-27) and doesn't stop a composition reaching the network (EX-14), so the OS
// sandbox is the boundary. Every Chrome render runs inside it: no network except
// loopback, no reading people's files, writing only to its own work folder.

import { existsSync, realpathSync } from "node:fs"
import { dirname } from "node:path"

import { EngineFailure } from "./tool.js"

const SANDBOX_EXEC = "/usr/bin/sandbox-exec"
// Where people's files and other programs' temporary files live
const PRIVATE = ["/Users", "/Volumes", "/private/tmp", "/private/var/folders", "/private/var/tmp"]

const real = (path) => realpathSync(path)
// SBPL string literal: our own absolute paths, refused if they could break out of the quotes
function quoted(path) {
  if (!path.startsWith("/") || /["\\\n\r\0]/.test(path)) throw new RangeError(`a confinement path must be a plain absolute path, got "${path}"`)
  return `"${path}"`
}

/** What this computer can confine with, or why it can't. @returns {{ kind: "sandbox-exec" } | { kind: null, missing: string }} */
export function confinement(platform = process.platform, exists = existsSync) {
  if (platform === "darwin" && exists(SANDBOX_EXEC)) return { kind: "sandbox-exec" }
  // shortcut: bubblewrap on Linux and Windows' AppContainer (EQ-11) aren't written yet, so motion is refused there
  return { kind: null, missing: "The motion layer runs Chrome inside the operating system's sandbox, and this system's sandbox isn't supported yet." }
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
  return { command: SANDBOX_EXEC, args: ["-p", sandboxProfile(paths), command, ...args] }
}

/** The folder a program's whole install lives in: Node's prefix, from its binary. */
export const installOf = (binary) => dirname(dirname(real(binary)))
