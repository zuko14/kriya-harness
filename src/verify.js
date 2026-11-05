import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"

import { checkpoint } from "./checkpoints.js"
import { classify, signature } from "./failure.js"
import { kriyaHome } from "./paths.js"
import { noteFailure } from "./rules.js"
import { affectedTests, blastRadius, importGraph } from "./recon.js"
import { hasBoundaryTest, newSurface, reviewDiff, sentinel } from "./sentinel.js"
import { projectRoot } from "./skill-switches.js"
import { isSource, ladder, silencers, weakenedTest } from "./strict.js"

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
// What a failed run keeps of its output (loop guard), so a resumed step's next builder still sees it
const KEPT_OUTPUT = 2500
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
  const root = projectRoot(cwd)
  const here = checksIn(root)
  if (here.length) return here
  // A workspace holding its projects in subfolders (e.g. benchmarks/<app>):
  // each one's checks, run from the workspace with `cd <folder> && …`
  const found = []
  for (const rel of projectFolders(root)) for (const c of checksIn(join(root, rel))) found.push({ command: `cd ${rel} && ${c.command}`, source: `${rel}/${c.source}` })
  return found
}

// Folders never searched for projects: dependencies, build output, caches, VCS
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "coverage", "vendor", "venv", "__pycache__"])
const SAFE_REL = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)?$/
const PROJECT_FILES = ["package.json", "Makefile", "makefile", "Cargo.toml", "go.mod", "pyproject.toml", "pytest.ini", "deno.json", "deno.jsonc", "gradlew", "pom.xml"]

/** Subfolders (one or two levels down, at most 5) that hold a project, as safe relative paths */
export function projectFolders(root, limit = 5) {
  const out = []
  const list = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !SKIP_DIRS.has(d.name))
        .map((d) => d.name)
        .sort()
    } catch {
      return []
    }
  }
  const isProject = (dir) => PROJECT_FILES.some((f) => existsSync(join(dir, f)))
  for (const a of list(root)) {
    if (out.length >= limit) break
    if (isProject(join(root, a))) {
      if (SAFE_REL.test(a)) out.push(a)
      continue
    }
    for (const b of list(join(root, a))) {
      if (out.length >= limit) break
      const rel = `${a}/${b}`
      if (SAFE_REL.test(rel) && isProject(join(root, rel))) out.push(rel)
    }
  }
  return out
}

/** The checks one folder's project defines, best first */
function checksIn(dir) {
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

/* ─────────────────────────── the work's state ─────────────────────────── */

// Harness upgrade U8: a pass belongs to the files it ran on. The working
// tree's fingerprint (HEAD, the changed and untracked paths, and their
// contents) is taken with read-only git commands (no objects written, no
// index refresh), so Read only stays read-only. Outside a repository there
// is none, and a pass stays a pass.
const git = (cwd, args, input, encoding = "utf8") =>
  new Promise((done) => {
    const child = execFile("git", args, { cwd, encoding, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) =>
      done(error ? null : stdout)
    )
    if (input !== undefined) child.stdin.end(input)
  })

/**
 * @returns {Promise<{ fingerprint: string, changed: string[] } | undefined>}
 *   changed: paths that differ from HEAD (staged, unstaged, untracked)
 */
export async function workTree(cwd) {
  const status = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"])
  if (status === null) return undefined
  const head = ((await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"])) ?? "no commit").trim()
  const root = ((await git(cwd, ["rev-parse", "--show-toplevel"])) ?? cwd).trim()
  const changed = status
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3))
  const present = changed.filter((rel) => existsSync(join(root, rel)))
  const hashes = present.length ? await git(root, ["hash-object", "--stdin-paths"], present.join("\n") + "\n") : ""
  const fingerprint = createHash("sha256").update(`${head}\0${status}\0${hashes ?? "unreadable"}`).digest("hex").slice(0, 16)
  return { fingerprint, changed: changed.sort() }
}

// Files that decide what "passing" means: tests and the checks' own config.
// A pass that changed one is still a pass, but the person is told which
const CHECK_FILE = [
  /(^|\/)(tests?|__tests__|spec|specs)\//,
  /\.(test|spec)\.[^/]+$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.(go|py|rs)$/,
  /(^|\/)(package\.json|Makefile|makefile|pytest\.ini|pyproject\.toml|setup\.cfg|tox\.ini|Cargo\.toml|go\.mod|deno\.jsonc?|conftest\.py)$/,
  /(^|\/)(jest|vitest|playwright|karma|mocha)\.config\.[^/]+$/,
  /(^|\/)\.mocharc[^/]*$/,
]
export const checkFiles = (paths) => paths.filter((p) => CHECK_FILE.some((re) => re.test(p)))

/**
 * Loop v2: runs `run` with the given test and check files as they are at
 * HEAD (an added one is moved aside), then puts the work's own versions
 * back. A pass that holds only with the changed tests is a weakened check.
 * Reads git (`show`), never writes it: the person's index and refs stay.
 * shortcut: the baseline is HEAD, so the person's own uncommitted test edits
 * count too; commit them first (or use the v1 loop) until the baseline is the
 * session's first checkpoint.
 * @returns {Promise<undefined | Awaited<ReturnType<typeof run>>>} undefined outside a repository or before a first commit
 */
export async function onOriginals(cwd, paths, run) {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"]))?.trim()
  if (!root || (await git(root, ["rev-parse", "--verify", "-q", "HEAD"])) === null) return undefined
  const saved = []
  try {
    for (const rel of paths) {
      const file = join(root, rel)
      const original = await git(root, ["show", `HEAD:${rel}`], undefined, "buffer")
      const entry = { file, mine: existsSync(file) ? readFileSync(file) : null }
      saved.push(entry)
      if (original === null) rmSync(file, { force: true })
      else {
        // The first folder this had to make (a deleted test's), removed again after
        entry.made = mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, original)
      }
    }
    return await run()
  } finally {
    for (const { file, mine, made } of saved.toReversed()) {
      if (mine === null) rmSync(made ?? file, { recursive: true, force: true })
      else writeFileSync(file, mine)
    }
  }
}

/* ───────────────────────────── the strict loop ─────────────────────── */

const gitRoot = async (cwd) => (await git(cwd, ["rev-parse", "--show-toplevel"]))?.trim()
const fileNow = (file) => (existsSync(file) ? readFileSync(file, "utf8") : null)
const refusal = (kind, command, output) => ({ exitCode: 1, timedOut: false, output, command, kind, own: true })

// `a/*` and `a/**` match below a folder; anything else is one path
const matches = (pattern, rel) => (/\*+$/.test(pattern) ? rel.startsWith(pattern.replace(/\*+$/, "")) : rel === pattern)

/**
 * What fails a step before the person's check runs (strict loop): a broken
 * invariant, a weakened test, a silenced compiler, then the ladder's fast
 * rungs. Each can only fail: a pass still needs the confirmed check. Against
 * HEAD, so outside a repository none of this applies.
 * @returns {Promise<undefined | { exitCode: number | null, timedOut: boolean, output: string, command: string, kind?: string, level?: number }>}
 */
async function strictBefore(cwd, plan, work, run, defensive) {
  const root = await gitRoot(cwd)
  if (!root || !work?.changed.length) return undefined
  const head = (rel) => git(root, ["show", `HEAD:${rel}`])
  const hit = work.changed.find((rel) => plan?.invariants?.some((p) => matches(p, rel)))
  if (hit) return refusal("invariant broken", "the plan's invariants", `${hit} must not change in this task (the plan's invariants). Put it back and solve this another way.`)
  const checks = new Set(checkFiles(work.changed))
  for (const rel of checks) {
    const before = await head(rel)
    const why = before !== null && !/(package\.json|Makefile|makefile|\.toml|\.ini|\.cfg|go\.mod|deno\.jsonc?|\.config\.[^/]+|\.mocharc[^/]*)$/.test(rel) && weakenedTest(before, fileNow(join(root, rel)))
    if (why) return refusal("tests changed", "the test files", `${rel} was weakened: ${why}. Put the test back and fix the code; adding tests is fine.`)
  }
  for (const rel of work.changed.filter((f) => isSource(f) && !checks.has(f))) {
    const now = fileNow(join(root, rel))
    const added = now === null ? [] : silencers(await head(rel), now)
    if (added.length) return refusal("silenced", "the changed source", `${rel} adds ${added.join(" and ")} to get past a check. Fix the cause instead.`)
  }
  const tests = affectedTests(root, work.changed)
  let neighbours = []
  if (defensive) {
    const graph = importGraph(root)
    const diffs = await diffsOf(root, work.changed)
    const found = sentinel(diffs, { tenancy: graph.files.some((rel) => /\bwithUser\(/.test(graph.text(rel))) })
    if (found.length) return refusal("invariant violated", "the invariant sentinel", findings(found.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.why}`)))
    // The neighbours' suites too: the work isn't done if it passes here and breaks there
    neighbours = blastRadius(graph, diffs).tests.filter((rel) => !tests.includes(rel))
  }
  for (const rung of ladder(root, work.changed, tests, neighbours)) {
    const result = await run(rung.command)
    if (result.aborted) throw new VerifyError("The check was stopped.")
    if (result.exitCode === 0 && !result.timedOut) continue
    // A type error in a file this work never touched is older than it
    if (rung.names && !rung.names.some((rel) => result.output.includes(rel))) continue
    return { ...result, command: rung.command, level: rung.level, ...(rung.kind && { kind: rung.kind }) }
  }
  return undefined
}

const diffsOf = async (root, changed) =>
  Promise.all(changed.map(async (rel) => ({ rel, before: await git(root, ["show", `HEAD:${rel}`]), after: fileNow(join(root, rel)) })))

const findings = (lines) => `${lines.slice(0, 12).join("\n")}${lines.length > 12 ? `\n… ${lines.length - 12} more` : ""}`

/**
 * Before a plan can read verified (defensive): the whole diff against code it
 * didn't touch, a bad-input test for anything new, and each pre-mortem claim
 * backed by the test it named.
 */
async function defensiveAfter(cwd, plan, work) {
  const root = await gitRoot(cwd)
  if (!root || !work?.changed.length) return undefined
  const diffs = await diffsOf(root, work.changed)
  const hazards = reviewDiff(importGraph(root), diffs)
  if (hazards.length) return refusal("regression hazard", "the diff review", findings(hazards.map((h) => `${h.file}${h.line ? `:${h.line}` : ""} [${h.hazard}] ${h.why}`)))
  const surface = newSurface(diffs)
  if (surface.length && !hasBoundaryTest(diffs)) return refusal("no negative test", "the diff review", `${surface[0]} adds something callers can reach, and no added test tries a bad input (invalid, empty, unauthorized, a boundary). Add one that shows it fails cleanly.`)
  const open = plan?.premortem?.failures.find((f) => !existsSync(join(root, f.coveredBy)))
  if (open) return refusal("premortem open", "the pre-mortem", `"${open.what}" was to be covered by ${open.coveredBy}, which doesn't exist. Write that test.`)
  return undefined
}

/** What fails a passing step afterwards: the plan's acceptance commands, and a bug fix with no proof of the bug */
async function strictAfter(cwd, sessionId, plan, work, check, run, defensive, finishing) {
  for (const command of plan?.acceptance ?? []) {
    const result = await run(command)
    if (result.aborted) throw new VerifyError("The check was stopped.")
    if (result.exitCode !== 0 || result.timedOut) return { ...result, command, kind: "acceptance" }
  }
  if (defensive && finishing) {
    const late = await defensiveAfter(cwd, plan, work)
    if (late) return late
  }
  if (plan?.kind !== "surgical_bugfix") return undefined
  const code = (work?.changed ?? []).filter((rel) => !checkFiles([rel]).length)
  if (!code.length) return undefined
  // The red phase, proved: on the code as it was, the check (with any new test) must fail
  const kept = await checkpoint(cwd, sessionId, "before the check on the old code").catch(() => undefined)
  const old = kept && (await onOriginals(cwd, code, () => run(check.command)))
  if (old?.aborted) throw new VerifyError("The check was stopped.")
  if (old?.exitCode === 0 && !old.timedOut)
    return refusal("no reproduction", check.command, "The check also passes on the code before your change, so nothing proves the bug or its fix. Add a test that fails on the old code and passes on the new.")
  return undefined
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
 * The session's verdict, from its runs and plan. A step that failed its
 * MAX_ATTEMPTS-th run, or that the loop guard stopped as stalled, is blocked;
 * otherwise each step's last run decides. With a plan, "verified" needs every
 * step of it passed: passes with steps still open are "partial", never verified.
 * With `current` (the work's fingerprint now, U8): "verified" holds only for
 * the files the last run saw; changed since, it's "not checked" and stale.
 * `touched`: test or check files the last passing run's work had changed.
 * @returns {{ status: "verified" | "partial" | "failed" | "blocked" | "not checked", stale?: true, touched?: string[], steps: Array<{ step: string, status: "pass" | "fail" | "blocked", attempts: number, failures: number }> }}
 */
export function verdict(progress, current) {
  const steps = new Map()
  for (const run of progress.runs) {
    const prev = steps.get(run.step) ?? { step: run.step, attempts: 0, failures: 0, status: "fail" }
    if (prev.status === "blocked") continue
    const failures = run.status === "pass" ? prev.failures : prev.failures + 1
    steps.set(run.step, {
      step: run.step,
      attempts: prev.attempts + 1,
      failures,
      status: run.status === "pass" ? "pass" : failures >= MAX_ATTEMPTS || run.stalled ? "blocked" : "fail",
    })
  }
  const list = [...steps.values()]
  const open = progress.plan?.steps.some((_, i) => steps.get(stepLabel(progress.plan, i + 1))?.status !== "pass")
  const status = !list.length
    ? "not checked"
    : list.some((s) => s.status === "blocked")
      ? "blocked"
      : list.every((s) => s.status === "pass")
        ? open
          ? "partial"
          : "verified"
        : "failed"
  const last = progress.runs.at(-1)
  const touched = progress.runs.findLast((r) => r.status === "pass")?.touched
  const extra = touched?.length ? { touched } : {}
  if (status === "verified" && current && last?.tree && last.tree !== current) return { status: "not checked", stale: true, steps: list, ...extra }
  return { status, steps: list, ...extra }
}

function renderProgress(progress) {
  const { status, steps, touched } = verdict(progress)
  const lines = [`# Progress`, "", `Project: ${progress.root}`, `Session: ${progress.sessionId}`, `Verdict: ${status}`, ""]
  if (touched) lines.push(`Changed test or check files: ${touched.join(", ")}`, "")
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

/** The step label kriya_verify records runs under: "<n> <title>", within its limits */
export const stepLabel = (plan, n) => normalStep(`${n} ${plan.steps[n - 1].title}`.replace(/[^\p{L}\p{N} ._:/#()-]/gu, " ").replace(/\s+/g, " ").slice(0, 80).trim())

/**
 * Runs the project's confirmed check for one step and records it.
 * @param {{ cwd: string, sessionId: string, step?: string, run: (command: string) => Promise<{ exitCode: number | null, timedOut: boolean, aborted?: boolean, output: string }>, now?: () => Date, tree?: (cwd: string) => Promise<{ fingerprint: string, changed: string[] } | undefined>, v2?: { readOnly?: boolean }, guard?: boolean }} input
 *   run executes the command under the session's own sandbox (the tool passes DSH's shell)
 *   v2 (loop v2, KRIYA_LOOP_V2=on): a failure's class and excerpt, a pass that changed tests re-run on the originals, repeated failures proposed as rules
 *   guard (KRIYA_LOOP_GUARD=on): a failure's class and excerpt too, with its signature, and the excerpt kept in the run so a resumed step can use it
 *   strict (KRIYA_STRICT_LOOP=on): the checks of strictBefore and strictAfter around the person's check; never in Read only
 */
export async function verifyStep({ cwd, sessionId, step, run, now = () => new Date(), tree = workTree, v2, guard, strict }) {
  const label = normalStep(step)
  const check = confirmedCheck(cwd)
  if (!check) return { status: "not configured", step: label, suggestions: discoverChecks(cwd) }
  const before = verdict(readProgress(check.root, sessionId)).steps.find((s) => s.step === label)
  if (before?.status === "blocked") return { status: "blocked", step: label, attempts: before.attempts, command: check.command }
  // The files this run checks, taken before the command (a check that writes
  // files, e.g. a build, doesn't make its own pass stale)
  const work = await tree(cwd)
  const started = now()
  const hard = strict && !strict.readOnly
  const plan = hard ? readProgress(check.root, sessionId).plan : undefined
  const early = hard ? await strictBefore(cwd, plan, work, run, strict.defensive) : undefined
  const result = early ?? (await run(check.command))
  if (result.aborted) throw new VerifyError("The check was stopped.")
  const passes = (r) => r.exitCode === 0 && !r.timedOut
  let status = passes(result) ? "pass" : "fail"
  let touched = work && status === "pass" ? checkFiles(work.changed) : []
  // v2 and strict: a pass that changed tests or the check's files must hold on the originals too
  let checked = result
  let weakened
  if (((v2 && !v2.readOnly) || hard) && touched.length) {
    // The work's own files are saved first, so a crash mid-swap loses nothing (kriya undo); no save, no swap
    const kept = await checkpoint(cwd, sessionId, "before the check on the committed tests").catch(() => undefined)
    const originals = kept && (await onOriginals(cwd, touched, () => run(check.command)))
    if (originals?.aborted) throw new VerifyError("The check was stopped.")
    if (originals && !passes(originals)) [status, checked, weakened, touched] = ["fail", originals, touched, []]
  }
  if (hard && status === "pass") {
    // The whole diff is reviewed when this pass could finish the work: a plan's last open step, or no plan
    const open = plan ? plan.steps.filter((_, i) => verdict(readProgress(check.root, sessionId)).steps.find((s) => s.step === stepLabel(plan, i + 1))?.status !== "pass" && stepLabel(plan, i + 1) !== label) : []
    const late = await strictAfter(cwd, sessionId, plan, work, check, run, strict.defensive, !open.length)
    if (late) [status, checked, touched] = ["fail", late, []]
  }
  // A refusal's words are its whole output; a rung's error is cut like any other
  const classified = () => (checked.own ? { kind: checked.kind, excerpt: checked.output } : weakened ? { kind: "tests changed", excerpt: classify(checked).excerpt } : { ...classify(checked), ...(checked.kind && { kind: checked.kind }) })
  const failure = (v2 || guard) && status === "fail" ? classified() : undefined
  const sig = guard && failure ? createHash("sha256").update(signature(check.command, failure)).digest("hex").slice(0, 16) : undefined
  const progress = recordRun(check.root, sessionId, {
    at: started.toISOString(),
    step: label,
    command: checked.command ?? check.command,
    status,
    exitCode: checked.exitCode,
    timedOut: checked.timedOut,
    durationMs: Math.max(0, now().getTime() - started.getTime()),
    ...(work && { tree: work.fingerprint }),
    ...(touched.length && { touched }),
    ...(failure && { kind: failure.kind }),
    ...(weakened && { weakened }),
    ...(sig && { sig, excerpt: failure.excerpt.slice(0, KEPT_OUTPUT) }),
    ...(checked.level && { level: checked.level }),
  })
  const proposed = (v2 || strict) && failure && noteFailure(check.root, check.command, failure, now)
  const after = verdict(progress)
  const mine = after.steps.find((s) => s.step === label)
  return {
    status: mine.status,
    step: label,
    attempts: mine.attempts,
    attemptsLeft: mine.status === "fail" ? MAX_ATTEMPTS - mine.failures : 0,
    command: checked.command ?? check.command,
    exitCode: checked.exitCode,
    timedOut: checked.timedOut,
    output: status === "pass" ? "" : failure ? failure.excerpt : trimOutput(result.output),
    verdict: after.status,
    ...(touched.length && { touched }),
    ...(failure && { failure: failure.kind }),
    ...(weakened && { weakened }),
    ...(proposed && { proposed: proposed.text }),
    ...(sig && { signature: sig }),
  }
}

/**
 * Loop guard: the last failed run stopped the step early, so the step is
 * blocked though it has attempts left. Marked on the run, so the verdict and
 * every later read agree; the reason says why more builders can't help.
 */
export function markStalled(root, sessionId, reason) {
  const progress = readProgress(root, sessionId)
  const run = progress.runs.at(-1)
  if (run) run.stalled = reason
  return verdict(writeProgress(root, sessionId, progress))
}

/** What a session's records say happened, in numbers: the bench's and KRHE's view of a run */
export function trajectory(progress) {
  const { steps } = verdict(progress)
  const failedRuns = progress.runs.filter((r) => r.status !== "pass")
  const classes = {}
  for (const run of failedRuns) if (run.kind) classes[run.kind] = (classes[run.kind] ?? 0) + 1
  const planned = progress.plan?.steps.length ?? 0
  const passed = steps.filter((s) => s.status === "pass").length
  return {
    plans: (progress.earlier?.length ?? 0) + (progress.plan ? 1 : 0),
    planned,
    // Plan steps with no pass and no block: work the session left undone
    open: progress.plan ? progress.plan.steps.filter((_, i) => !["pass", "blocked"].includes(steps.find((s) => s.step === stepLabel(progress.plan, i + 1))?.status)).length : 0,
    passed,
    blocked: steps.filter((s) => s.status === "blocked").length,
    // Steps that failed at least once and then passed
    recovered: steps.filter((s) => s.status === "pass" && s.failures > 0).length,
    checkRuns: progress.runs.length,
    failedRuns: failedRuns.length,
    stalled: failedRuns.filter((r) => r.stalled).length,
    builders: progress.builders?.length ?? 0,
    builderSteps: (progress.builders ?? []).reduce((n, b) => n + (b.steps ?? 0), 0),
    interrupted: Object.values(progress.interrupted ?? {}).reduce((n, c) => n + c, 0),
    rollbacks: progress.rollbacks ?? 0,
    // Failures the fast rungs caught before the full check ran
    earlyFailures: failedRuns.filter((r) => r.level).length,
    peakTokens: Math.max(0, ...(progress.builders ?? []).map((b) => b.tokens ?? 0)),
    classes,
  }
}

/** This project's newest session with a record (the one `kriya verify status` reports), or `sessionId`'s */
export function latestSession(cwd, sessionId) {
  if (sessionId) return sessionId
  const root = confirmedCheck(cwd)?.root ?? projectRoot(cwd)
  const dir = dirname(progressFiles(root, "x").json)
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : []
  // The parent's record, not a builder's: a plan first, then the newest
  const rows = names.map((f) => ({ id: f.slice(0, -5), at: statSync(join(dir, f)).mtimeMs, plan: Boolean(readProgress(root, f.slice(0, -5)).plan) }))
  return rows.sort((a, b) => Number(b.plan) - Number(a.plan) || b.at - a.at)[0]?.id
}

/** Where a session stands, with its evidence: the verdict on the files as they are now, each step, each run */
export async function sessionReport(cwd, sessionId) {
  const id = latestSession(cwd, sessionId)
  if (!id) return { status: "not checked", steps: [], runs: [], trajectory: null }
  const root = confirmedCheck(cwd)?.root ?? projectRoot(cwd)
  const progress = readProgress(root, id)
  const now = await currentVerdict(cwd, id)
  return {
    session: id,
    status: now.status,
    ...(now.stale && { stale: true }),
    ...(now.touched && { touched: now.touched }),
    goal: progress.plan?.goal ?? null,
    steps: now.steps,
    runs: progress.runs.map((r) => ({ at: r.at, step: r.step, status: r.status, exitCode: r.exitCode ?? null, command: r.command, ...(r.kind && { kind: r.kind }), ...(r.stalled && { stalled: r.stalled }) })),
    trajectory: trajectory(progress),
  }
}

/**
 * The session's verdict against the files as they are now (U8): what the
 * loop checks before a turn ends, and what `kriya verify` reports.
 */
export async function currentVerdict(cwd, sessionId, tree = workTree) {
  const check = confirmedCheck(cwd)
  const root = check?.root ?? projectRoot(cwd)
  const progress = readProgress(root, sessionId)
  if (!progress.runs.length) return { status: "not checked", steps: [] }
  return verdict(progress, (await tree(cwd))?.fingerprint)
}
