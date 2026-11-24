import { execFile, spawn } from "node:child_process"
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs"
import { join, relative, sep } from "node:path"

import { confirmedCheck } from "./verify.js"

// The Developer tab's data and actions (plugins/cockpit; Kriya-Tavi
// docs/kriya-harness/DEVELOPER_COCKPIT.md). Connections are each provider's
// own CLI and the person's own login there: Kriya runs fixed argv (execFile,
// never a shell), never reads a token or a credential file, and never types a
// login code. Secrets are found by file name only; no value is read.

export class CockpitError extends Error {}

// Telemetry off and no prompts for every provider CLI Kriya runs
const QUIET = { NO_COLOR: "1", DO_NOT_TRACK: "1", RENDER_CLI_DISABLE_ANALYTICS: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", SUPABASE_TELEMETRY_DISABLED: "1" }

/** argv only, bounded, stdin closed. Resolves { code, stdout, stderr, missing }. */
export function runner({ env = process.env, timeoutMs = 20_000 } = {}) {
  return (file, args, cwd) =>
    new Promise((done) => {
      const child = execFile(file, args, { cwd, env: { ...env, ...QUIET }, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) =>
        done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), missing: error?.code === "ENOENT" })
      )
      child.stdin?.end()
    })
}

/**
 * The providers the Developer tab connects through. `status` exits 0 only when
 * signed in (for Render the docs don't state whoami's exit code, so a non-zero
 * exit reads as "not signed in or not checked"). `login` is what the person
 * runs; GitHub's is also one click (githubSignIn).
 */
export const PROVIDERS = [
  { id: "github", name: "GitHub", cli: "gh", version: ["--version"], status: ["auth", "status", "--hostname", "github.com"], login: "gh auth login", install: "brew install gh", docs: "https://cli.github.com" },
  { id: "supabase", name: "Supabase", cli: "supabase", version: ["--version"], status: ["projects", "list", "-o", "json"], login: "supabase login", install: "brew install supabase/tap/supabase", docs: "https://supabase.com/docs/guides/cli" },
  { id: "render", name: "Render", cli: "render", version: ["--version"], status: ["whoami", "-o", "json"], login: "render login", install: "brew install render", docs: "https://render.com/docs/cli" },
  { id: "vercel", name: "Vercel", cli: "vercel", version: ["--version"], status: ["whoami"], login: "vercel login", install: "npm install -g vercel", docs: "https://vercel.com/docs/cli" },
]

/** "gh version 2.103.3 (2026-10-26)" → "2.103.3" */
export const versionOf = (text) => /\b(\d+\.\d+(?:\.\d+)?)\b/.exec(String(text ?? ""))?.[1] ?? null

/** One provider's state: installed, its version, signed in (true, false), and GitHub's account name */
export async function connection(provider, run = runner()) {
  const base = { id: provider.id, name: provider.name, cli: provider.cli, login: provider.login, install: provider.install, docs: provider.docs }
  const v = await run(provider.cli, provider.version)
  if (v.missing) return { ...base, installed: false, signedIn: false }
  const s = await run(provider.cli, provider.status)
  const signedIn = s.code === 0
  // gh says "Logged in to github.com account <name>"; the other CLIs' account isn't parsed
  const account = provider.id === "github" && signedIn ? /account\s+([A-Za-z0-9-]{1,39})\b/.exec(`${s.stdout}\n${s.stderr}`)?.[1] ?? null : null
  return { ...base, installed: true, version: versionOf(v.stdout || v.stderr), signedIn, ...(account && { account }) }
}

export const connections = (run = runner()) => Promise.all(PROVIDERS.map((p) => connection(p, run)))

/**
 * GitHub's one-click sign-in: `gh auth login --web`, whose one-time code the
 * person enters on github.com in their browser (gh opens it). Kriya only shows
 * the code gh prints for that purpose; the token stays in gh's own store.
 * One at a time.
 */
export function githubSignIn({ spawnImpl = spawn, env = process.env } = {}) {
  let current = null
  return {
    // The code only while the person still needs it
    state: () => (current ? { status: current.status, ...(current.status === "waiting" && { code: current.code }), ...(current.error && { error: current.error }) } : { status: "idle" }),
    start() {
      if (current?.status === "waiting" || current?.status === "starting") return this.state()
      const child = spawnImpl("gh", ["auth", "login", "--web", "--hostname", "github.com", "--git-protocol", "https", "--skip-ssh-key"], {
        env: { ...env, NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      })
      const run = { status: "starting", code: null, error: null, child }
      current = run
      let seen = ""
      const read = (chunk) => {
        seen = (seen + chunk).slice(-4000)
        const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(seen)?.[1]
        if (code && !run.code) {
          run.code = code
          run.status = "waiting"
          // gh waits for Enter before it opens the browser
          child.stdin?.write("\n")
        }
      }
      child.stdout?.on("data", read)
      child.stderr?.on("data", read)
      child.on("error", (e) => Object.assign(run, { status: "failed", error: e.code === "ENOENT" ? "The GitHub CLI (gh) isn't installed." : "gh couldn't start." }))
      child.on("close", (exit) => {
        if (run.status === "failed") return
        Object.assign(run, exit === 0 ? { status: "done" } : { status: "failed", error: "GitHub sign-in didn't finish. Try again, or run gh auth login in a terminal." })
      })
      const timer = setTimeout(() => run.status === "waiting" || run.status === "starting" ? (child.kill("SIGTERM"), Object.assign(run, { status: "failed", error: "GitHub sign-in timed out after 10 minutes." })) : null, 10 * 60_000)
      timer.unref?.()
      return this.state()
    },
    cancel() {
      if (current && (current.status === "waiting" || current.status === "starting")) {
        current.child.kill("SIGTERM")
        Object.assign(current, { status: "failed", error: "Canceled." })
      }
      return this.state()
    },
  }
}

/* ─────────────────────────── running servers ─────────────────────────── */

const inside = (root, path) => {
  const rel = relative(root, path)
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel))
}

/** lsof -F output → [{ pid, command, ports }] for listening TCP sockets */
export function parseListeners(text) {
  const byPid = new Map()
  let cur = null
  for (const line of String(text ?? "").split("\n")) {
    const tag = line[0]
    const value = line.slice(1)
    if (tag === "p") {
      const pid = Number(value)
      cur = byPid.get(pid) ?? { pid, command: "", ports: [] }
      byPid.set(pid, cur)
    } else if (tag === "c" && cur) cur.command = value.slice(0, 60)
    else if (tag === "n" && cur) {
      const port = Number(/:(\d+)$/.exec(value)?.[1])
      if (Number.isInteger(port) && port > 0 && !cur.ports.includes(port)) cur.ports.push(port)
    }
  }
  return [...byPid.values()].filter((p) => Number.isInteger(p.pid) && p.pid > 0 && p.ports.length)
}

/** Servers listening on TCP whose working folder is inside the project; never this process or its parent */
export async function servers(folder, run = runner({ timeoutMs: 10_000 })) {
  let root
  try {
    root = realpathSync(folder)
  } catch {
    return { available: true, list: [] }
  }
  const all = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"])
  if (all.missing) return { available: false, list: [] }
  const list = []
  for (const p of parseListeners(all.stdout)) {
    if (p.pid === process.pid || p.pid === process.ppid) continue
    const cwd = /^n(.+)$/m.exec((await run("lsof", ["-a", "-p", String(p.pid), "-d", "cwd", "-Fn"])).stdout)?.[1]
    if (!cwd) continue
    let real
    try {
      real = realpathSync(cwd)
    } catch {
      continue
    }
    if (inside(root, real)) list.push({ ...p, ports: p.ports.sort((a, b) => a - b).slice(0, 8), folder: relative(root, real) || "." })
  }
  return { available: true, list: list.slice(0, 20) }
}

/** Stops one listed server: only a pid the current list shows for this project */
export async function stopServer(folder, pid, run, kill = process.kill.bind(process)) {
  const { list } = await servers(folder, run)
  if (!list.some((s) => s.pid === pid)) throw new CockpitError("That server isn't running in this project any more.")
  kill(pid, "SIGTERM")
  return { stopped: pid }
}

/* ─────────────────────────── project health ─────────────────────────── */

const ENV_FILE = /(^|\/)\.env(\.[^/]*)?$/
const ENV_OK = /(^|\/)\.env\.(example|sample|template)$/
const KEY_FILE = /\.(pem|key|p12|pfx)$/

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

/** What the project is, how it's checked, and secret files git would expose (names only) */
export async function health(folder, run = runner()) {
  const has = (f) => existsSync(join(folder, f))
  const pkg = has("package.json") ? readJson(join(folder, "package.json")) : null
  const manager = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : pkg ? "npm" : null
  const stack = [
    pkg && { id: "node", label: `Node.js${manager ? ` · ${manager}` : ""}` },
    (has("pyproject.toml") || has("requirements.txt")) && { id: "python", label: "Python" },
    has("go.mod") && { id: "go", label: "Go" },
    has("Cargo.toml") && { id: "rust", label: "Rust" },
    has("supabase/config.toml") && { id: "supabase", label: "Supabase project" },
    has("render.yaml") && { id: "render", label: "Render blueprint" },
    (has("vercel.json") || has(".vercel")) && { id: "vercel", label: "Vercel project" },
  ].filter(Boolean)
  const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? ["dev", "build", "test", "lint", "start"].filter((s) => typeof pkg.scripts[s] === "string") : []
  const check = confirmedCheck(folder)
  const git = await run("git", ["-C", folder, "rev-parse", "--show-toplevel"])
  if (git.code !== 0) return { stack, scripts, check: check?.command ?? null, git: false, tracked: [], unignored: [] }
  const root = git.stdout.trim()
  const list = async (args) => (await run("git", ["-C", root, ...args])).stdout.split("\0").filter(Boolean)
  const secret = (f) => (ENV_FILE.test(f) && !ENV_OK.test(f)) || KEY_FILE.test(f)
  const tracked = (await list(["ls-files", "-z"])).filter(secret).slice(0, 20)
  const unignored = (await list(["ls-files", "--others", "--exclude-standard", "-z"])).filter(secret).slice(0, 20)
  return { stack, scripts, check: check?.command ?? null, git: true, tracked, unignored }
}

/** Adds the named, not-yet-ignored secret files to .gitignore (the person clicked it); only files health() listed */
export async function ignoreSecrets(folder, files, run = runner()) {
  const { git, unignored } = await health(folder, run)
  if (!git) throw new CockpitError("This folder isn't a git repository.")
  const wanted = (Array.isArray(files) ? files : []).filter((f) => unignored.includes(f))
  if (!wanted.length) throw new CockpitError("Those files are already ignored, or aren't secret files here.")
  const root = (await run("git", ["-C", folder, "rev-parse", "--show-toplevel"])).stdout.trim()
  const file = join(root, ".gitignore")
  const current = existsSync(file) ? readFileSync(file, "utf8") : ""
  const lines = wanted.map((f) => `/${f}`).filter((l) => !current.split("\n").includes(l))
  if (lines.length) appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}# Secrets (added by Kriya Harness)\n${lines.join("\n")}\n`)
  return { added: lines }
}
