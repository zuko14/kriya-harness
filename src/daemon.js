import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, join, sep } from "node:path"
import { gzipSync } from "node:zlib"

import { BASE_PATH, call, KriyaError, models } from "./api.js"
import { doctor } from "./doctor.js"
import { CLIENT_VERSION, kriyaHome } from "./paths.js"
import { confirmRule, dismissRule, listRules } from "./rules.js"

// `kriya daemon` (the Control Center, CONTROL_CENTER.md in the Kriya
// repository): this computer listens for actions the person queues in
// Kriya (/harness, or the phone) and runs them with the same routines as
// the terminal. What it accepts is decided here, on the computer:
// - only the folders the person offered (the one it started in and each
//   --folder), never a path from Kriya;
// - only typed actions (a task, a health check, a rule decision, handoff,
//   pull, serve), never a command;
// - Full access and serving only with --allow-full-access / --allow-serve;
// - a task runs `kriya run` exactly as typed in a terminal would, so Ask
//   mode's approvals still go to Kriya and the person answers them there.

export const POLL_WAIT_S = 25
export const MAX_RUNNING = 2
const OUTPUT_TAIL = 4000
const REHELLO_MS = 5 * 60_000
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

/** A folder's id: the first 16 hex of the sha256 of its real path */
export const projectId = (path) => createHash("sha256").update(path).digest("hex").slice(0, 16)

/**
 * The folders this computer offers: real, existing directories, never the
 * home folder or a drive root, at most 50.
 * @param {string[]} folders
 */
export function offeredProjects(folders, home = homedir()) {
  const out = []
  for (const raw of folders) {
    let path
    try {
      path = realpathSync(raw)
      if (!statSync(path).isDirectory()) continue
    } catch {
      continue
    }
    if (path === realpathSync(home) || path === sep || /^[A-Za-z]:\\?$/.test(path)) continue
    if (out.some((p) => p.path === path)) continue
    out.push({
      id: projectId(path),
      name: basename(path).slice(0, 80) || path,
      path,
      shown: (path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path).slice(0, 300),
      git: existsSync(join(path, ".git")),
    })
    if (out.length >= 50) break
  }
  return out
}

/** Each offered folder's loop rules: proposed ones by number, then confirmed */
export function projectRules(projects) {
  const rules = []
  for (const p of projects) {
    try {
      const { proposed, confirmed } = listRules(p.path)
      proposed.forEach((text, i) => rules.push({ project: p.id, n: i + 1, text: text.slice(0, 400), status: "proposed" }))
      confirmed.forEach((text, i) => rules.push({ project: p.id, n: i + 1, text: text.slice(0, 400), status: "confirmed" }))
    } catch {
      // No rules file: nothing to list
    }
  }
  return rules.slice(0, 200)
}

/** The modes and switches of a task, as `kriya run` flags */
export function runArgs(payload) {
  const s = payload.switches ?? {}
  return [
    "run",
    "--mode",
    payload.mode,
    ...(s.loopV2 ? ["--loop-v2"] : []),
    ...(s.budget === false ? ["--no-budget"] : []),
    ...(s.anchor ? ["--anchor"] : []),
    ...(s.browser === false ? ["--no-browser-tools"] : []),
    payload.prompt,
  ]
}

// The harness switches a flow may set (KU-ADR-16: nothing protected has a name)
const PROFILE_ENV = /^KRIYA_(LOOP|LOOP_V2|LOOP_GUARD|STRICT_LOOP|DEFENSIVE|RECON|JIT_TOOLS|BUDGET|ANCHOR|MINIMAL|MAX_STEPS|TURN_MINUTES|MAX_REPEATS)$/
const FLOW_REPORT_MS = 3_000

/**
 * What a flow from Kriya adds to `kriya run`: its plan in a file the loop
 * saves as written, a file the loop reports into, and its harness settings,
 * only the known switches, each a short value. Refuses anything else, as the
 * server does, so a tampered action changes nothing protected.
 */
export function flowEnv(payload, dir) {
  const env = {}
  if (payload.profile) {
    for (const [name, value] of Object.entries(payload.profile.env ?? {}))
      if (PROFILE_ENV.test(name) && /^(on|off|[0-9]{1,3})$/.test(String(value))) env[name] = String(value)
  }
  if (!payload.plan) return env
  const seed = join(dir, "plan.json")
  writeFileSync(seed, JSON.stringify(payload.plan))
  return { ...env, KRIYA_SEED_PLAN: seed, KRIYA_PROGRESS_FILE: join(dir, "progress.json") }
}

const readProgressFile = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

const tail = (text) => (text.length > OUTPUT_TAIL ? `…${text.slice(-OUTPUT_TAIL)}` : text)
const MODES = new Set(["ask", "auto", "read", "plan", "full"])

/** Sends to Kriya, with bodies past the host's firewall when Kriya decodes them (as the relay does) */
export async function deviceSender(device) {
  let encode = false
  try {
    encode = ((await models(device.url, device.token)).bodyEncodings ?? []).includes("gzip+base64")
  } catch {
    // Plain JSON until the next sender asks
  }
  return (method, path, body) =>
    encode && body !== undefined
      ? call(device.url, method, path, {
          token: device.token,
          raw: true,
          headers: { "Content-Type": "text/plain; charset=us-ascii", "x-kriya-body": "gzip+base64" },
          bodyText: gzipSync(Buffer.from(JSON.stringify(body))).toString("base64"),
        }).then(async (r) => (r.status === 204 ? null : r.json()))
      : call(device.url, method, path, { token: device.token, ...(body !== undefined && { body }) })
}

/* The running `kriya daemon` command's pid: Remote Control leaves listening to it */
export const daemonPidFile = () => join(kriyaHome(), "daemon.pid")

export function externalDaemon(file = daemonPidFile()) {
  try {
    process.kill(Number(readFileSync(file, "utf8")), 0)
    return true
  } catch {
    return false
  }
}

/**
 * The daemon: hello, then a long poll for actions, each run on this
 * computer and reported. Stops when `signal` aborts (Ctrl-C).
 * @param {{
 *   device: { url: string, token: string },
 *   folders: string[],
 *   allowFullAccess?: boolean,
 *   allowServe?: boolean,
 *   allowEdit?: boolean,
 *   editHost?: { hand: (job: object) => Promise<any>, cancel: (body: object) => Promise<{ known: boolean }> },
 *   env?: Record<string, string | undefined>,
 *   signal?: AbortSignal,
 *   log?: (line: string) => void,
 *   kriya?: { bin: string, node: string },
 *   once?: boolean,
 * }} options once: handle one poll and return (tests)
 */
export async function runDaemon(options) {
  const { device, signal, log = (line) => process.stdout.write(`${line}\n`) } = options
  const kriya = options.kriya ?? { bin: join(import.meta.dirname, "..", "bin", "kriya.js"), node: process.execPath }
  let projects = offeredProjects(options.folders)
  const capabilities = { fullAccess: Boolean(options.allowFullAccess), serve: Boolean(options.allowServe), handoff: true }
  const send = await deviceSender(device)

  const running = new Map() // dispatch id → { child, canceled }
  let serving = null // { child, project, id }
  let helloAt = 0

  // Editing (track E). Edits never enter `running`, so MAX_RUNNING stays the person's
  // tasks (EH-02), and the Host, detached, outlives this process (EH-05). With KRIYA_EDIT
  // off none of this does anything: no request, no field, the old cancel path.
  const editSwitch = (options.env ?? process.env).KRIYA_EDIT === "on"
  const editing = new Set()
  const canceling = new Set() // forwarded to the Host and not yet over
  let allowEdit = Boolean(options.allowEdit)
  let editAdvertised = false
  const editHost = options.editHost ?? {
    async hand(job) {
      const { ensureHost, hostCall } = await import("./edit/host/client.js")
      await ensureHost()
      return hostCall(kriyaHome(), "POST", "/internal/job", job)
    },
    async cancel(body) {
      const { hostCall } = await import("./edit/host/client.js")
      return hostCall(kriyaHome(), "POST", "/internal/cancel", body)
    },
    // After a restart the Host isn't up yet, and a watched folder needs it to be
    async wake() {
      const { watchedFolders } = await import("./edit/host/watch.js")
      if (!watchedFolders({ home: kriyaHome() }).length) return
      const { ensureHost } = await import("./edit/host/client.js")
      await ensureHost()
    },
  }
  // Strict schemas: a field only after this server said it knows editing (EH-01)
  const refreshEdit = async () => {
    if (editSwitch && allowEdit && !editAdvertised) {
      try {
        await call(device.url, "GET", "/editing/manifest", { token: device.token })
        editAdvertised = true
      } catch {
        // Not on this Kriya yet; asked again at the next hello
      }
    }
    if (editSwitch && allowEdit && editAdvertised) {
      capabilities.edit = true
      await editHost.wake?.().catch((error) => log(`kriya daemon: the Edit Host didn't start: ${error.message}`))
    } else delete capabilities.edit
  }

  const hello = async () => {
    await refreshEdit()
    await send("POST", "/daemon/hello", { daemonVersion: CLIENT_VERSION, capabilities, projects: projects.map((p) => ({ id: p.id, name: p.name, path: p.shown, git: p.git })), rules: projectRules(projects) })
    helloAt = Date.now()
  }
  // Remote Control changes folders and switches without stopping running tasks
  if (options.control)
    options.control.update = (next) => {
      projects = offeredProjects(next.folders)
      capabilities.fullAccess = Boolean(next.allowFullAccess)
      capabilities.serve = Boolean(next.allowServe)
      allowEdit = Boolean(next.allowEdit)
      return hello().catch(() => (helloAt = 0))
    }
  const report = (id, status, result) => send("POST", `/dispatch/${id}`, { status, ...(result && { result }) }).catch((error) => log(`kriya daemon: couldn't report ${id.slice(0, 8)}: ${error.message}`))

  const folderOf = (payload) => projects.find((p) => p.id === payload.project)

  // A child kriya command in a folder; resolves with its exit code and output
  const child = (id, args, cwd, extraEnv = {}) =>
    new Promise((done) => {
      const proc = spawn(kriya.node, [kriya.bin, ...args], { cwd, env: { ...process.env, KRIYA_DISPATCH_ID: id, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] })
      let out = ""
      let err = ""
      proc.stdout.on("data", (d) => (out = (out + d).slice(-OUTPUT_TAIL * 2)))
      proc.stderr.on("data", (d) => (err = (err + d).slice(-OUTPUT_TAIL * 2)))
      running.set(id, { child: proc, canceled: false })
      proc.on("error", (error) => done({ code: 1, out, err: `${err}\n${error.message}`, canceled: running.get(id)?.canceled }))
      proc.on("close", (code, sig) => done({ code: code ?? (sig ? 1 : 0), out, err, canceled: running.get(id)?.canceled }))
    }).finally(() => running.delete(id))

  const handle = async ({ id, kind, payload }) => {
    const refuse = (error) => report(id, "failed", { error })
    if (kind === "doctor") {
      const lines = []
      await report(id, "running")
      const ok = await doctor({ say: (line) => lines.push(line) }).catch((error) => (lines.push(`FAIL  doctor — ${error.message}`), false))
      const checks = lines.map((line) => {
        const m = /^(ok|FAIL)\s+(.*?)(?: — (.*))?$/.exec(line)
        return m ? { name: m[2].slice(0, 200), ok: m[1] === "ok", ...(m[3] && { fix: m[3].slice(0, 300) }) } : { name: line.slice(0, 200), ok: true }
      })
      return report(id, ok ? "done" : "failed", { checks })
    }
    if (kind === "serve_stop") {
      if (serving) serving.child.kill("SIGTERM")
      return report(id, "done", { output: serving ? "Stopped serving." : "Wasn't serving." })
    }
    const folder = folderOf(payload)
    if (!folder) return refuse("That folder isn't offered by this computer any more.")
    if (kind === "rule_confirm" || kind === "rule_dismiss") {
      try {
        const text = kind === "rule_confirm" ? confirmRule(folder.path, payload.n, payload.wording) : dismissRule(folder.path, payload.n)
        await report(id, "done", { output: `${kind === "rule_confirm" ? "Confirmed" : "Dismissed"}: ${text}` })
      } catch (error) {
        await refuse(error.message)
      }
      return hello().catch(() => {})
    }
    if (kind === "run") {
      if (!MODES.has(payload.mode) || typeof payload.prompt !== "string" || !payload.prompt.trim()) return refuse("That task isn't complete.")
      if (payload.mode === "full" && !capabilities.fullAccess) return refuse("Full access from Kriya is off on this computer.")
      if (running.size >= MAX_RUNNING) return refuse(`This computer is already running ${MAX_RUNNING} tasks from Kriya.`)
      await report(id, "running")
      log(`kriya daemon: task in ${folder.shown} (${payload.mode})`)
      const flow = payload.plan || payload.profile ? mkdtempSync(join(tmpdir(), "kriya-flow-")) : null
      const env = flow ? flowEnv(payload, flow) : {}
      let sent = ""
      const beat = () => {
        const seen = env.KRIYA_PROGRESS_FILE && readProgressFile(env.KRIYA_PROGRESS_FILE)
        if (!seen || JSON.stringify(seen) === sent) return seen
        sent = JSON.stringify(seen)
        report(id, "running", seen)
        return seen
      }
      const reporting = env.KRIYA_PROGRESS_FILE ? setInterval(beat, FLOW_REPORT_MS) : null
      const r = await child(id, runArgs(payload), folder.path, env)
      clearInterval(reporting)
      const progress = env.KRIYA_PROGRESS_FILE ? readProgressFile(env.KRIYA_PROGRESS_FILE) : null
      if (flow) rmSync(flow, { recursive: true, force: true })
      const stopped = r.canceled
      // The answer on success; on failure the last error lines too (DSH writes the reason to stderr)
      const errors = r.err
        .split("\n")
        .filter((line) => line.trim() && !/^(dsh: warning: \d+ entries did not activate|kriya-[\w-]+ \(@kriya-ai\/[\w-]+\): pending)/.test(line))
        .join("\n")
      const answer = r.code === 0 ? r.out.trim() || errors : [r.out.trim(), errors].filter(Boolean).join("\n\n")
      return report(id, stopped ? "canceled" : r.code === 0 ? "done" : "failed", { exitCode: r.code, answer: tail(answer), ...(progress && { plan: progress.plan }) })
    }
    if (kind === "edit") {
      if (!capabilities.edit) return report(id, "failed", { code: "not_allowed" })
      await report(id, "running")
      editing.add(id)
      try {
        await editHost.hand({ dispatch: id, folder: folder.path, job: payload.job, brief: payload.brief, effort: payload.effort, ...(payload.recipe && { recipe: payload.recipe }), ...(payload.revisionOf && { revisionOf: payload.revisionOf }), ...(payload.change && { change: payload.change }) })
        log(`kriya daemon: an edit in ${folder.shown} went to the Edit Host`)
      } catch (error) {
        editing.delete(id)
        log(`kriya daemon: the Edit Host didn't take it: ${error.message}`)
        return report(id, "failed", { code: "runtime_missing" })
      }
      return
    }
    if (kind === "handoff" || kind === "pull") {
      if (!folder.git) return refuse("Handoff and pull need a git repository.")
      await report(id, "running")
      const args = kind === "handoff" ? ["handoff", ...(payload.note ? [payload.note] : [])] : ["pull", ...(payload.workspace ? [payload.workspace] : [])]
      const r = await child(id, args, folder.path)
      const text = `${r.out}\n${r.err}`.trim()
      const workspace = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/.exec(text)?.[1]
      const branch = /\b(kriya\/pull-[\w-]+)\b/.exec(text)?.[1]
      return report(id, r.code === 0 ? "done" : "failed", { exitCode: r.code, output: tail(text), ...(workspace && { workspace }), ...(branch && { branch }) })
    }
    if (kind === "serve_start") {
      if (!capabilities.serve) return refuse("Serving from Kriya is off on this computer.")
      if (serving) return refuse(`Already serving ${serving.project.name}.`)
      const proc = spawn(kriya.node, [kriya.bin, "serve", folder.path], { cwd: folder.path, env: { ...process.env, KRIYA_DISPATCH_ID: id }, stdio: "ignore" })
      serving = { child: proc, project: folder, id }
      proc.on("close", () => {
        if (serving?.child === proc) serving = null
        report(id, "done", { output: `Stopped serving ${folder.name}.` })
      })
      log(`kriya daemon: serving ${folder.shown}`)
      return report(id, "running")
    }
    return refuse("This computer doesn't know that action.")
  }

  log(`kriya daemon: listening for Kriya (${projects.length} folder${projects.length === 1 ? "" : "s"}: ${projects.map((p) => p.shown).join(", ") || "none"})`)
  let failures = 0
  while (!signal?.aborted) {
    try {
      if (Date.now() - helloAt > REHELLO_MS) await hello()
      const next = await call(device.url, "GET", `/dispatch/next?wait=${options.once ? 0 : POLL_WAIT_S}`, { token: device.token, signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout((POLL_WAIT_S + 15) * 1000)]) })
      failures = 0
      for (const id of next.cancel ?? []) {
        // First, so cancelling an edit never reaches `kriya serve` (EH-03). After a
        // restart the set is empty, so an id that's no one's goes to the Host too; the
        // Host's "don't know it" closes it at once, or Kriya's poll runs hot (EH-04)
        if (editSwitch && (editing.has(id) || (!running.has(id) && serving?.id !== id))) {
          if (canceling.has(id)) continue
          canceling.add(id)
          const closed = () => {
            editing.delete(id)
            return report(id, "canceled", { code: "unknown" })
          }
          editHost
            .cancel({ dispatch: id })
            .then(({ known }) => (known ? null : closed()), closed)
            .catch(() => {})
          continue
        }
        const job = running.get(id)
        if (job) {
          job.canceled = true
          job.child.kill("SIGTERM")
        } else if (serving && id) serving.child.kill("SIGTERM")
      }
      // While the Host stops a job Kriya answers this poll at once: don't hammer it
      if (canceling.size && !next.dispatch && next.cancel?.every((id) => canceling.has(id))) await new Promise((done) => setTimeout(done, options.once ? 0 : 2_000))
      for (const id of canceling) if (!next.cancel?.includes(id)) canceling.delete(id)
      if (next.dispatch) {
        const work = handle(next.dispatch).catch((error) => report(next.dispatch.id, "failed", { error: String(error?.message ?? error).slice(0, 500) }))
        if (options.once) await work
      }
    } catch (error) {
      if (signal?.aborted) break
      if (error instanceof KriyaError && error.status === 404) {
        log("kriya daemon: the Control Center isn't on for this Kriya yet; trying again in a minute.")
        await new Promise((done) => setTimeout(done, 60_000))
      } else {
        const wait = BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)]
        log(`kriya daemon: ${error.message}; trying again in ${wait / 1000} s`)
        await new Promise((done) => setTimeout(done, wait))
      }
    }
    if (options.once) break
  }
  for (const { child: proc } of running.values()) proc.kill("SIGTERM")
  serving?.child.kill("SIGTERM")
}

/* ─────────── terminal → Kriya: what this kriya process runs ─────────── */

/**
 * Tells Kriya what a kriya process runs (mode, switches, folder name,
 * state; never the task). Fire-and-forget: a Kriya without the Control
 * Center (404) or a failed request changes nothing for the person.
 * @returns {{ end: (status: string, exitCode?: number) => Promise<void> }}
 */
export const HEARTBEAT_MS = 60_000

export function broadcastRun(device, { kind, mode, switches, cwd = process.cwd(), env = process.env, fetchCall = call, heartbeatMs = HEARTBEAT_MS }) {
  if (!device || env.KRIYA_BROADCAST === "off") return { end: async () => {} }
  const dispatchId = /^[0-9a-f-]{36}$/.test(env.KRIYA_DISPATCH_ID ?? "") ? env.KRIYA_DISPATCH_ID : undefined
  const base = {
    localId: randomUUID(),
    source: dispatchId ? "dispatch" : "terminal",
    kind,
    ...(MODES.has(mode) && { mode }),
    switches,
    project: basename(cwd).slice(0, 80),
    ...(dispatchId && { dispatchId }),
  }
  const post = (body) => fetchCall(device.url, "POST", "/runs", { token: device.token, body, signal: AbortSignal.timeout(5_000) }).catch(() => {})
  const started = post({ ...base, status: "running" })
  // A heartbeat while it runs: a process that dies without a word shows as lost, not running forever
  const beat = setInterval(() => post({ ...base, status: "running" }), heartbeatMs)
  beat.unref?.()
  return {
    end: async (status, exitCode) => {
      clearInterval(beat)
      await started
      await post({ ...base, status, ...(Number.isInteger(exitCode) && { exitCode }) })
    },
  }
}

export { BASE_PATH }

/* ─────────── kriya daemon install: run it in the background ─────────── */

export const LAUNCHD_LABEL = "ai.kriya.harness.daemon"
const xml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/**
 * The daemon as a background service, for the person's own login only:
 * a launchd agent on macOS, a systemd user unit on Linux. The folders and
 * --allow-* flags are the ones given to `kriya daemon install`.
 * @returns {{ path: string, content: string, start: string[][], stop: string[][] } | null} null on other systems
 */
export function serviceDefinition({ platform = process.platform, home = homedir(), node = process.execPath, bin, args }) {
  const command = [node, bin, "daemon", ...args]
  const logs = join(home, ".kriya", "daemon.log")
  if (platform === "darwin") {
    const path = join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${command.map((part) => `    <string>${xml(part)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(logs)}</string>
  <key>StandardErrorPath</key><string>${xml(logs)}</string>
</dict>
</plist>
`
    return { path, content, start: [["launchctl", "load", "-w", path]], stop: [["launchctl", "unload", "-w", path]] }
  }
  if (platform === "linux") {
    const path = join(home, ".config", "systemd", "user", "kriya-daemon.service")
    const quote = (part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `"${part.replace(/(["\\$`])/g, "\\$1")}"`)
    const content = `[Unit]
Description=Kriya Harness daemon (the Control Center)

[Service]
ExecStart=${command.map(quote).join(" ")}
Restart=on-failure
StandardOutput=append:${logs}
StandardError=append:${logs}

[Install]
WantedBy=default.target
`
    return {
      path,
      content,
      start: [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", "kriya-daemon.service"]],
      stop: [["systemctl", "--user", "disable", "--now", "kriya-daemon.service"]],
    }
  }
  return null
}
