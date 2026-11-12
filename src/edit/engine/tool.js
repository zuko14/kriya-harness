// Running FFmpeg and friends: `spawn` with an argument array, never a shell, in a
// built environment. Every way a tool can fail ends as one typed failure.

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { basename } from "node:path"

import { childEnv } from "../runtime/setup.js"

const TAIL = 4000

// ES-03: FFmpeg and FFprobe get no network at all where the OS can say so: macOS's sandbox-exec, and
// (TP11) Linux's bubblewrap with a network namespace of its own. On Linux a media tool never runs without
// it. Windows has no runner yet (EQ-11): there the protocol whitelist is the only barrier, as before, and
// nothing calls that confined
const SANDBOX_EXEC = "/usr/bin/sandbox-exec"
const NO_NETWORK = "(version 1)(allow default)(deny network*)"
const BWRAP_PATHS = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"]
const CONFINED = new Set(["ffmpeg", "ffprobe"])

/**
 * The command line that actually runs: a media tool wrapped in the no-network profile.
 * @returns {[string, string[]]} throws no_confinement for a media tool on Linux without bubblewrap
 */
export function confined(command, args, { platform = process.platform, exists = existsSync } = {}) {
  const name = basename(command).replace(/\.exe$/i, "")
  if (!CONFINED.has(name)) return [command, args]
  if (platform === "darwin") return exists(SANDBOX_EXEC) ? [SANDBOX_EXEC, ["-p", NO_NETWORK, command, ...args]] : [command, args]
  if (platform === "linux") {
    const bwrap = BWRAP_PATHS.find((path) => exists(path))
    if (!bwrap) throw new EngineFailure("environment", "no_confinement", `${name} runs without network inside bubblewrap on Linux, and it isn't installed. Install the bubblewrap package (bwrap).`)
    // The files where they are (FFmpeg reads the person's footage and writes the cache), the network gone
    return [bwrap, ["--die-with-parent", "--unshare-net", "--bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--", command, ...args]]
  }
  return [command, args]
}

export class EngineFailure extends Error {
  /**
   * @param {"input" | "environment" | "render" | "plan"} kind EDIT_LOOP §11's class
   * @param {string} reason
   * @param {string} message plain enough to show the person
   */
  constructor(kind, reason, message) {
    super(message)
    this.kind = kind
    this.reason = reason
  }
}

const PATTERNS = [
  [/No space left on device/i, "environment", "low_disk", "The disk filled up."],
  [/No such filter|Unknown encoder|Encoder .* not found|Filter not found/i, "environment", "missing_feature", "This FFmpeg can't do that."],
  [/Invalid data found|moov atom not found|does not contain any stream|End of file|No such file or directory|Could not find codec/i, "input", "unreadable", "This file can't be read."],
]

function classify(tail, code, signal, command) {
  if (/^sandbox-exec: execvp\(\) of '[^']*' failed/m.test(tail)) return new EngineFailure("environment", "missing_tool", `${command} isn't installed.`)
  if (signal) return new EngineFailure("render", "crash", `The tool crashed (${signal}).`)
  for (const [pattern, kind, reason, message] of PATTERNS) if (pattern.test(tail)) return new EngineFailure(kind, reason, message)
  return new EngineFailure("render", "failed", `The tool stopped with code ${code}: ${tail.trim().split("\n").at(-1)?.slice(0, 200) ?? ""}`)
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ timeoutMs?: number, stallMs?: number, signal?: AbortSignal, onStdout?: (chunk: Buffer) => void, env?: object, cwd?: string }} [options]
 *   stallMs: a tool that prints nothing for this long is hung
 * @returns {Promise<string>} stdout, unless onStdout takes it
 */
export function runTool(command, args, { timeoutMs = 0, stallMs = 0, signal, onStdout, env = childEnv(), cwd } = {}) {
  return new Promise((done, fail) => {
    if (signal?.aborted) return fail(signal.reason)
    const [file, argv] = confined(command, args)
    const child = spawn(file, argv, { env, stdio: ["ignore", "pipe", "pipe"], ...(cwd ? { cwd } : {}) })
    let out = ""
    let tail = ""
    let stopped = null
    let stall
    const stop = (failure) => {
      stopped ??= failure
      child.kill("SIGKILL")
    }
    const watch = () => {
      clearTimeout(stall)
      if (stallMs) stall = setTimeout(() => stop(new EngineFailure("render", "hang", "The tool stopped making progress.")), stallMs)
    }
    const limit = timeoutMs ? setTimeout(() => stop(new EngineFailure("render", "timeout", "The tool took too long.")), timeoutMs) : null
    const cancel = () => stop(signal.reason)
    signal?.addEventListener("abort", cancel, { once: true })
    watch()
    child.stdout.on("data", (chunk) => {
      watch()
      if (onStdout) onStdout(chunk)
      else out += chunk
    })
    child.stderr.on("data", (chunk) => {
      watch()
      tail = (tail + chunk).slice(-TAIL)
    })
    const finish = () => {
      clearTimeout(limit)
      clearTimeout(stall)
      signal?.removeEventListener("abort", cancel)
    }
    child.on("error", (error) => {
      finish()
      fail(error.code === "ENOENT" ? new EngineFailure("environment", "missing_tool", `${command} isn't installed.`) : error)
    })
    child.on("close", (code, killed) => {
      finish()
      if (stopped) fail(stopped)
      else if (code === 0) done(out)
      else fail(classify(tail, code, killed, command))
    })
  })
}
