import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { kriyaHome } from "./paths.js"
import { projectRoot } from "./skill-switches.js"

// The Kriya loop's verify step (H14a, docs/kriya-harness/KRIYA_LOOP.md in
// the Kriya repository). "Passed" comes only from the exit code of the
// project's own check, run by the harness, never from what the model says.
//
// - discoverChecks: commands the project already defines (package.json
//   scripts, Makefile targets, cargo, go, pytest…). Only suggestions.
// - The confirmed check: the one command the person chose for a project
//   (`kriya verify use`), kept in ~/.kriya/verify.json by project root. No
//   tool can set it: the agent runs it, the person picks it.
// - Progress: every verify run per session and step, in
//   ~/.kriya/progress/<project>/<session>.json and a readable .md beside
//   it; never inside the project, so Read only stays read-only.
// - The verdict, computed from those runs: verified, failed, blocked at a
//   step, or not checked.

export const MAX_ATTEMPTS = 4 // the first try and 3 fixes (KRIYA_LOOP.md §1, (5))
export const OUTPUT_LIMIT = 4000
const COMMAND_LIMIT = 500
const STEP = /^[\p{L}\p{N}][\p{L}\p{N} ._:/#()-]{0,79}$/u

export class VerifyError extends Error {}

/* ───────────────────────────── discovery ───────────────────────────── */

const read = (file) => {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

function packageManager(dir) {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm"
  if (existsSync(join(dir, "yarn.lock"))) return "yarn"
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun"
  return "npm"
}

const runScript = (pm, script) =>
  pm === "npm" ? (script === "test" ? "npm test" : `npm run ${script}`) : pm === "yarn" ? `yarn ${script}` : `${pm} run ${script}`

// npm init's placeholder isn't a check
const PLACEHOLDER = /no test specified/

/**
 * The checks a project already defines, best first. Suggestions only: none
 * runs until the person confirms it.
 * @param {string} cwd
 * @returns {Array<{ command: string, source: string }>}
 */
export function discoverChecks(cwd) {
  const dir = projectRoot(cwd)
  const found = []
  const add = (command, source) => {
    if (!found.some((c) => c.command === command)) found.push({ command, source })
  }

  const pkg = read(join(dir, "package.json"))
  if (pkg) {
    let scripts = {}
    try {
      scripts = JSON.parse(pkg).scripts ?? {}
    } catch {
      // Unreadable package.json: nothing to suggest from it
    }
    const pm = packageManager(dir)
    for (const name of ["check", "test", "typecheck", "lint", "build"])
      if (typeof scripts[name] === "string" && !PLACEHOLDER.test(scripts[name])) add(runScript(pm, name), `package.json script "${name}"`)
  }
  const makefile = read(join(dir, "Makefile")) ?? read(join(dir, "makefile"))
  if (makefile) for (const target of ["check", "test"]) if (new RegExp(`^${target}\\s*:`, "m").test(makefile)) add(`make ${target}`, `Makefile target "${target}"`)
  if (existsSync(join(dir, "Cargo.toml"))) add("cargo test", "Cargo.toml")
  if (existsSync(join(dir, "go.mod"))) add("go test ./...", "go.mod")
  const pyproject = read(join(dir, "pyproject.toml")) ?? ""
  if (/pytest/.test(pyproject) || existsSync(join(dir, "pytest.ini")) || /pytest/.test(read(join(dir, "tox.ini")) ?? "") || /pytest/.test(read(join(dir, "setup.cfg")) ?? ""))
    add("python -m pytest", "pytest configuration")
  const deno = read(join(dir, "deno.json")) ?? read(join(dir, "deno.jsonc"))
  if (deno && /"test"\s*:/.test(deno)) add("deno task test", "deno.json task \"test\"")
  if (existsSync(join(dir, "gradlew"))) add("./gradlew test", "Gradle wrapper")
  else if (existsSync(join(dir, "pom.xml"))) add("mvn -q test", "pom.xml")
  return found
}

/* ─────────────────────────── the confirmed check ──────────────────────── */

export const checksFile = () => join(kriyaHome(), "verify.json")

function readChecks() {
  try {
    const raw = JSON.parse(readFileSync(checksFile(), "utf8"))
    return raw && typeof raw.projects === "object" ? raw.projects : {}
  } catch {
    return {}
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

/**
 * The person's confirmed check for the project `cwd` is in, if any. A check
 * in KRIYA_VERIFY_CHECK (set in the person's own shell, e.g. by a benchmark
 * run; the model can't set the harness's environment) wins for this run.
 */
export function confirmedCheck(cwd) {
  const root = projectRoot(cwd)
  const fromEnv = (process.env.KRIYA_VERIFY_CHECK ?? "").trim()
  if (fromEnv && fromEnv.length <= COMMAND_LIMIT && !/[\r\n]/.test(fromEnv)) return { root, command: fromEnv, source: "KRIYA_VERIFY_CHECK" }
  const entry = readChecks()[root]
  return entry && typeof entry.command === "string" ? { root, ...entry } : undefined
}

/**
 * The person confirms the project's check (CLI only; no tool calls this).
 * @param {string} cwd
 * @param {string} command
 */
export function confirmCheck(cwd, command, now = () => new Date()) {
  const text = typeof command === "string" ? command.trim() : ""
  if (!text) throw new VerifyError("Which command? kriya verify use <number> or kriya verify use \"<command>\"")
  if (text.length > COMMAND_LIMIT || /[\r\n]/.test(text)) throw new VerifyError(`A check is one line of at most ${COMMAND_LIMIT} characters.`)
  const root = projectRoot(cwd)
  const projects = readChecks()
  projects[root] = { command: text, confirmedAt: now().toISOString() }
  writeJson(checksFile(), { version: 1, projects })
  return { root, command: text }
}

/** The person removes the project's check: its runs end "not checked" again. */
export function clearCheck(cwd) {
  const root = projectRoot(cwd)
  const projects = readChecks()
  const had = root in projects
  delete projects[root]
  writeJson(checksFile(), { version: 1, projects })
  return had
}

/* ───────────────────────────── progress ───────────────────────────── */

const projectKey = (root) => createHash("sha256").update(root).digest("hex").slice(0, 16)
const SESSION = /^[A-Za-z0-9_-]{1,128}$/

export function progressFiles(root, sessionId) {
  if (!SESSION.test(sessionId)) throw new VerifyError("That session id can't name a progress file.")
  const dir = join(kriyaHome(), "progress", projectKey(root))
  return { json: join(dir, `${sessionId}.json`), md: join(dir, `${sessionId}.md`) }
}

export function readProgress(root, sessionId) {
  try {
    const value = JSON.parse(readFileSync(progressFiles(root, sessionId).json, "utf8"))
    if (Array.isArray(value.runs)) return value
  } catch {
    // None yet
  }
  return { version: 1, root, sessionId, runs: [] }
}

/**
 * The session's verdict, from its runs alone. A step that failed its
 * MAX_ATTEMPTS-th run is blocked; otherwise each step's last run decides.
 * @returns {{ status: "verified" | "failed" | "blocked" | "not checked", steps: Array<{ step: string, status: "pass" | "fail" | "blocked", attempts: number, failures: number }> }}
 */
export function verdict(progress) {
  const steps = new Map()
  for (const run of progress.runs) {
    const prev = steps.get(run.step) ?? { step: run.step, attempts: 0, failures: 0, status: "fail" }
    if (prev.status === "blocked") continue
    const failures = run.status === "pass" ? prev.failures : prev.failures + 1
    steps.set(run.step, {
      step: run.step,
      attempts: prev.attempts + 1,
      failures,
      status: run.status === "pass" ? "pass" : failures >= MAX_ATTEMPTS ? "blocked" : "fail",
    })
  }
  const list = [...steps.values()]
  const status = !list.length
    ? "not checked"
    : list.some((s) => s.status === "blocked")
      ? "blocked"
      : list.every((s) => s.status === "pass")
        ? "verified"
        : "failed"
  return { status, steps: list }
}

function renderProgress(progress) {
  const { status, steps } = verdict(progress)
  const lines = [`# Progress`, "", `Project: ${progress.root}`, `Session: ${progress.sessionId}`, `Verdict: ${status}`, ""]
  if (progress.plan) {
    lines.push(`## Plan`, "", `Goal: ${progress.plan.goal}`, "")
    progress.plan.steps.forEach((step, i) => lines.push(`${i + 1}. ${step.title}: done when ${step.doneWhen}`))
    lines.push("")
  }
  for (const s of steps) lines.push(`- ${s.step}: ${s.status} (${s.attempts} run${s.attempts === 1 ? "" : "s"})`)
  lines.push("", "## Runs", "")
  for (const run of progress.runs)
    lines.push(`- ${run.at} · ${run.step} · ${run.status} · exit ${run.exitCode ?? "none"}${run.timedOut ? " (timed out)" : ""} · ${run.durationMs} ms · \`${run.command}\``)
  return `${lines.join("\n")}\n`
}

/** Saves a session's whole progress record (its plan, if any, and its runs) */
export function writeProgress(root, sessionId, progress) {
  const files = progressFiles(root, sessionId)
  writeJson(files.json, progress)
  writeFileSync(files.md, renderProgress(progress), { mode: 0o600 })
  return progress
}

function recordRun(root, sessionId, run) {
  const progress = readProgress(root, sessionId)
  progress.runs.push(run)
  return writeProgress(root, sessionId, progress)
}

/* ───────────────────────────── the verify step ──────────────────────── */

/** The failing part of a long output: its end, where test runners report. */
export function trimOutput(text, limit = OUTPUT_LIMIT) {
  if (text.length <= limit) return text
  return `… (${text.length - limit} earlier characters left out)\n${text.slice(-limit)}`
}

export const normalStep = (step) => {
  const text = typeof step === "string" && step.trim() ? step.trim() : "all"
  if (!STEP.test(text)) throw new VerifyError("A step label is a short name: letters, digits, spaces and . _ : / # ( ) -, up to 80 characters.")
  return text
}

/**
 * Runs the project's confirmed check for one step and records it.
 * @param {{ cwd: string, sessionId: string, step?: string, run: (command: string) => Promise<{ exitCode: number | null, timedOut: boolean, aborted?: boolean, output: string }>, now?: () => Date }} input
 *   run executes the command under the session's own sandbox (the tool passes DSH's shell)
 */
export async function verifyStep({ cwd, sessionId, step, run, now = () => new Date() }) {
  const label = normalStep(step)
  const check = confirmedCheck(cwd)
  if (!check) return { status: "not configured", step: label, suggestions: discoverChecks(cwd) }
  const before = verdict(readProgress(check.root, sessionId)).steps.find((s) => s.step === label)
  if (before?.status === "blocked") return { status: "blocked", step: label, attempts: before.attempts, command: check.command }
  const started = now()
  const result = await run(check.command)
  if (result.aborted) throw new VerifyError("The check was stopped.")
  const status = result.exitCode === 0 && !result.timedOut ? "pass" : "fail"
  const progress = recordRun(check.root, sessionId, {
    at: started.toISOString(),
    step: label,
    command: check.command,
    status,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: Math.max(0, now().getTime() - started.getTime()),
  })
  const after = verdict(progress)
  const mine = after.steps.find((s) => s.step === label)
  return {
    status: mine.status,
    step: label,
    attempts: mine.attempts,
    attemptsLeft: mine.status === "fail" ? MAX_ATTEMPTS - mine.failures : 0,
    command: check.command,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    output: status === "pass" ? "" : trimOutput(result.output),
    verdict: after.status,
  }
}
