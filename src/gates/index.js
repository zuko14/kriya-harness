import { execFile } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"

import { contractProblems, CONTRACT_NAMES, CONTRACTS_DIR, drifted, ownedHashes } from "../contracts.js"
import { DETECTORS, findSecrets } from "./detectors.js"
import { apiGate } from "./api.js"
import { commandGate, dataGate, evalGate, simHeadlessGate } from "./commands.js"
import { sastGate } from "./sast.js"
import { stackGate } from "./stack.js"
import { tenantGate } from "./tenant.js"
import { threeGate } from "./three.js"
import { judgeA11y, judgeUi, uiReports } from "./ui.js"

// Harness 2.0 W3: the gate catalogue's runner (Kriya-Tavi docs/kriya-harness/
// upgrade_2.0/GATES.md). A gate is code with fixed logic; its configuration
// is typed data (the step's cartridge, the contracts), never a command, a
// pattern or a pass condition a model wrote. Gates run only after the
// person's own check passed; the first failing gate turns the run into a
// failure the builder gets back, like any other. Off unless kriya was started
// with --gates (KRIYA_GATES=on): off, verifyStep never calls this.

/** The gates built so far; a cartridge naming another one reads `not_checked: not built yet`. */
export const BUILT = ["G-CONTRACT", "G-DETECT", "G-SECRETS", "G-SAST", "G-STACK", "G-API", "G-TENANT", "G-UI", "G-A11Y", "G-DATA", "G-EVAL", "G-SAN", "G-IAC", "G-SIM", "G-SIM-HEADLESS", "G-FLAKE", "G-TRACE", "G-3D"]
/** Run for every step with gates on, whatever its role. */
export const ALWAYS = ["G-SECRETS", "G-CONTRACT"]
/**
 * Gates whose `not_checked` makes a step fail instead of passing with a note.
 * Code, never data: a cartridge or a proposal can add gates, never remove one
 * here. A required gate counts only once the person set up what it needs
 * (a gate's `optional` not_checked, e.g. no app confirmed, stays a note).
 */
export const REQUIRED = Object.freeze({ frontend: Object.freeze(["G-UI"]), database: Object.freeze(["G-STACK"]), security: Object.freeze(["G-TENANT"]) })

const LIMIT = 300 * 1024
const git = (cwd, args) =>
  new Promise((done) => execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => done(error ? null : stdout)))

/**
 * The files this work changed (vs HEAD), with their text and the lines it
 * added. Untracked files count as all added. Binary or huge files are listed
 * with no text. `changed` comes from verifyStep's work tree.
 */
export async function changedFiles(root, changed) {
  const files = []
  for (const rel of changed) {
    const abs = join(root, rel)
    if (!existsSync(abs) || !statSync(abs).isFile()) continue
    const size = statSync(abs).size
    const siblings = readdirSync(dirname(abs))
    const tracked = (await git(root, ["ls-files", "--error-unmatch", "--", rel])) !== null
    if (size > LIMIT) {
      files.push({ path: rel, content: "", added: [], isNew: !tracked, siblings })
      continue
    }
    const content = readFileSync(abs, "utf8")
    let added
    if (!tracked) added = content.split("\n").map((text, i) => ({ line: i + 1, text }))
    else {
      added = []
      const diff = (await git(root, ["diff", "--no-color", "--no-ext-diff", "-U0", "HEAD", "--", rel])) ?? ""
      let next = 0
      for (const line of diff.split("\n")) {
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
        if (hunk) next = Number(hunk[1])
        else if (line.startsWith("+") && !line.startsWith("+++")) added.push({ line: next++, text: line.slice(1) })
      }
    }
    files.push({ path: rel, content: content.includes("\u0000") ? "" : content, added: content.includes("\u0000") ? [] : added, isNew: !tracked, siblings })
  }
  return files
}

const result = (id, status, extra = {}) => ({ id, status, ...extra })

/** G-DETECT: the cartridge's detectors on the added lines; `error` findings fail. */
export function detect(files, detectors, context = {}) {
  const findings = []
  for (const { id, severity } of detectors) {
    const d = DETECTORS[id]
    if (!d) continue
    for (const f of files) {
      if (!d.files(f.path)) continue
      for (const hit of d.find({ ...f, others: files, tenantTables: context.tenantTables ?? (() => false), assetLicensed: context.assetLicensed ?? (() => false) })) findings.push({ id, severity, path: f.path, ...hit })
    }
  }
  return findings
}

const where = (f) => `${f.path}:${f.line}`
const listed = (findings, n = 12) => findings.slice(0, n).map((f) => `- ${where(f)} ${f.id ? `${f.id}: ` : ""}${f.why}`).join("\n") + (findings.length > n ? `\n- … and ${findings.length - n} more` : "")

/** FE-ASSET-LICENCE: the asset paths scene_direction.json lists with a licence and a source. */
export function assetLicences(root) {
  let listed = []
  try {
    listed = JSON.parse(readFileSync(join(root, CONTRACTS_DIR, "scene_direction.json"), "utf8")).assets ?? []
  } catch {
    // No direction: no asset is licensed
  }
  const paths = new Set((Array.isArray(listed) ? listed : []).filter((a) => a?.licence && a?.source).map((a) => String(a.path)))
  return (path) => paths.has(path)
}

/**
 * Tables that are tenant data, for DB-NO-RLS: the auth matrix's tenant-scoped
 * resources, or every table in a Supabase project (its tables are exposed
 * through the Data API unless RLS is on).
 */
export function tenantTables(root) {
  let matrix = []
  try {
    matrix = JSON.parse(readFileSync(join(root, CONTRACTS_DIR, "auth_matrix.json"), "utf8"))
  } catch {
    // No matrix
  }
  const scoped = new Set((Array.isArray(matrix) ? matrix : []).filter((r) => r?.tenantScoped).map((r) => String(r.resource).toLowerCase()))
  const supabase = existsSync(join(root, "supabase"))
  return (name) => supabase || scoped.has(name.toLowerCase()) || scoped.has(name.toLowerCase().split(".").at(-1))
}

// Two patterns: a /g one for match(), a plain one for test() (a /g regex keeps state between test calls)
const ACCEPTANCE = /\bAC-\d{1,3}\b/g
const ONE_ACCEPTANCE = /\bAC-\d{1,3}\b/
const PASSED = /(✔|✓|√|\bPASS(ED)?\b|\bok\b|\bpassed\b)/
const FAILED = /(✖|✗|✕|×|\bFAIL(ED)?\b|\bnot ok\b|\bfailed\b)/

/** G-TRACE: every AC-n named in the step's done-when has a passing test with that id in this run's output. */
export function trace(step, output) {
  const ids = [...new Set(String(step?.doneWhen ?? "").match(ACCEPTANCE) ?? [])]
  if (!ids.length) return result("G-TRACE", "not_checked", { reason: "the step's done-when names no acceptance criteria (AC-1, AC-2, …)" })
  const lines = String(output ?? "").split("\n")
  if (!lines.some((l) => ONE_ACCEPTANCE.test(l) && PASSED.test(l))) return result("G-TRACE", "not_checked", { reason: "the check's output doesn't list passing tests by name (use the runner's verbose or spec reporter)" })
  const missing = ids.filter((id) => !lines.some((l) => new RegExp(`\\b${id}\\b`).test(l) && PASSED.test(l) && !FAILED.test(l)))
  return missing.length ? result("G-TRACE", "fail", { kind: "gate", excerpt: `G-TRACE: no passing test is named for ${missing.join(", ")}. Name one test per criterion with its id, e.g. "${missing[0]}: …".` }) : result("G-TRACE", "pass")
}

/**
 * Runs the step's gates after a passing check, in catalogue order; stops at the first failure.
 * @param {{ root: string, step?: { title: string, doneWhen: string }, cartridge?: { role: string, gates: string[], detectors: Array<{ id: string, severity: string }>, owns: string[] }, changed: string[], output: string, rerun: () => Promise<{ exitCode: number|null, timedOut: boolean, output: string }>, recorded?: Record<string, { sha: string }>, label: string }} input
 * @returns {Promise<{ results: Array<{ id: string, status: string, reason?: string, kind?: string, excerpt?: string }>, failure?: { id: string, kind: string, excerpt: string }, contracts: Record<string, { sha: string, step: string }> }>}
 */
export async function runGates({ root, step, cartridge, changed, output, rerun, command, recorded = {}, label, launch, psql, request, exec }) {
  const wanted = [...new Set([...ALWAYS, ...(cartridge?.gates ?? [])])]
  const order = [...BUILT, ...wanted.filter((g) => !BUILT.includes(g))].filter((g) => wanted.includes(g))
  const required = new Set(cartridge ? (REQUIRED[cartridge.role] ?? []) : [])
  const results = []
  let files
  const load = async () => (files ??= await changedFiles(root, changed))
  // One visit per route × viewport × scheme, shared by G-UI and G-A11Y
  let ui
  const pages = async () => (ui ??= await uiReports({ root, label, launch }))
  for (const id of order) {
    let r
    if (id === "G-SECRETS") {
      const found = (await load()).flatMap((f) => findSecrets(f).map((hit) => ({ path: f.path, ...hit })))
      r = found.length ? result(id, "fail", { kind: "gate", excerpt: `G-SECRETS: secrets in the changes (values not shown):\n${listed(found)}\nMove them to the environment or a secret store.` }) : result(id, "pass")
    } else if (id === "G-CONTRACT") {
      const problems = CONTRACT_NAMES.flatMap((name) => contractProblems(root, name, { gates: BUILT }))
      const moved = drifted(root, recorded, cartridge?.owns ?? [])
      if (moved.length)
        r = result(id, "fail", { kind: "contract changed", excerpt: `G-CONTRACT: ${moved.map((m) => `${m.file} ${m.removed ? "was removed" : "changed"}`).join("; ")}, but this step's role doesn't own ${moved.length === 1 ? "it" : "them"}. Build to the contract as written; if it is wrong, say so and stop instead of changing it.` })
      else if (problems.length) r = result(id, "fail", { kind: "gate", excerpt: `G-CONTRACT:\n${problems.map((p) => `- ${p}`).join("\n")}` })
      else r = result(id, "pass")
    } else if (id === "G-DETECT") {
      const found = detect(await load(), cartridge?.detectors ?? [], { tenantTables: tenantTables(root), assetLicensed: assetLicences(root) })
      const errors = found.filter((f) => f.severity === "error")
      const warnings = found.filter((f) => f.severity !== "error")
      r = errors.length ? result(id, "fail", { kind: "gate", excerpt: `G-DETECT:\n${listed(errors)}${warnings.length ? `\nAlso worth fixing:\n${listed(warnings, 6)}` : ""}` }) : result(id, "pass", warnings.length ? { warnings: warnings.length, note: listed(warnings, 6) } : {})
    } else if (id === "G-FLAKE") {
      const runs = []
      for (let i = 0; i < 2; i++) runs.push(await rerun())
      const bad = runs.findIndex((x) => x.exitCode !== 0 || x.timedOut)
      r = bad === -1 ? result(id, "pass") : result(id, "fail", { kind: "flaky", excerpt: `G-FLAKE: the check passed, then ${runs[bad].timedOut ? "timed out" : `exited ${runs[bad].exitCode}`} on run ${bad + 2} of 3 with no change. A flaky test is a bug: find the shared state, clock or race.\n${String(runs[bad].output ?? "").slice(-1500)}` })
    } else if (id === "G-TRACE") r = trace(step, output)
    else if (id === "G-UI") r = judgeUi(await pages())
    else if (id === "G-A11Y") r = judgeA11y(await pages())
    else if (id === "G-3D") r = await threeGate({ root, label, launch })
    else if (id === "G-STACK") r = await stackGate({ root, changed, tenantTables: tenantTables(root), ...(psql && { run: psql }) })
    else if (id === "G-API") r = await apiGate({ root, ...(request && { request }) })
    else if (id === "G-TENANT") r = await tenantGate({ root, ...(request && { request }) })
    else if (id === "G-SAST") r = await sastGate({ root, changed, ...(exec && { run: exec }) })
    else if (["G-DATA", "G-EVAL", "G-SAN", "G-IAC", "G-SIM", "G-SIM-HEADLESS"].includes(id) && !command) r = result(id, "not_checked", { reason: "this check runs no command here" })
    else if (id === "G-DATA") r = await dataGate({ root, command })
    else if (id === "G-EVAL") r = await evalGate({ root, command, changed })
    else if (id === "G-SAN") r = await commandGate({ root, command, gate: "san", id })
    else if (id === "G-IAC") r = await commandGate({ root, command, gate: "iac", id })
    else if (id === "G-SIM") r = await commandGate({ root, command, gate: "sim", id })
    else if (id === "G-SIM-HEADLESS") r = await simHeadlessGate({ root, command })
    else r = result(id, "not_checked", { reason: "not built yet" })
    if (r.status === "not_checked" && !r.optional && required.has(id)) r = { ...r, status: "fail", kind: "not checked", excerpt: `${id} couldn't run (${r.reason}), and a ${cartridge.role} step needs it.` }
    results.push(r)
    if (r.status === "fail") return { results, failure: { id, kind: r.kind, excerpt: r.excerpt }, contracts: {} }
  }
  return { results, contracts: ownedHashes(root, cartridge?.owns ?? [], label) }
}
