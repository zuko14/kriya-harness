import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { kriyaHome } from "./paths.js"
import { projectRoot } from "./skill-switches.js"

// Harness 2.0 W6: the commands the command-running gates use (Kriya-Tavi
// docs/kriya-harness/upgrade_2.0/GATES.md §3: G-DATA, G-EVAL, G-SAN, G-IAC,
// G-SIM, G-SIM-HEADLESS). A model never writes a gate's command (WD-04): the
// person confirms each one per project with `kriya gates use`, the same trust
// as `kriya verify use`. Kept in ~/.kriya/gates.json, outside the project; the
// G-EVAL baseline beside it, in ~/.kriya/evidence, so a builder can't move it.

export class GateCommandError extends Error {}

export const COMMAND_GATES = {
  data: { id: "G-DATA", what: "runs the data pipeline on its dirty fixture", options: ["output"] },
  eval: { id: "G-EVAL", what: "runs the evaluation and writes a metrics JSON file", options: ["metrics", "metric", "direction", "margin"] },
  san: { id: "G-SAN", what: "builds and tests with warnings as errors and sanitizers on", options: [] },
  iac: { id: "G-IAC", what: "validates and policy-checks the infrastructure offline (no apply)", options: [] },
  sim: { id: "G-SIM", what: "builds and launches the app on a simulator or emulator", options: [] },
  "sim-headless": { id: "G-SIM-HEADLESS", what: "runs the game's seeded headless simulation and prints STATE-HASH:", options: ["frameBudgetMs"] },
}
const LIMIT = 500

export const gatesFile = () => join(kriyaHome(), "gates.json")

function read() {
  try {
    const v = JSON.parse(readFileSync(gatesFile(), "utf8"))
    return v && typeof v.projects === "object" ? v.projects : {}
  } catch {
    return {}
  }
}

function write(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

const relative = (value) => {
  const v = String(value ?? "").trim()
  if (!v || v.startsWith("/") || v.split(/[\\/]/).includes("..")) throw new GateCommandError("Paths are relative to the project and stay inside it.")
  return v
}

/** Confirms one gate's command (and its options) for this project. */
export function useGateCommand(cwd, gate, command, options = {}, now = () => new Date()) {
  const spec = COMMAND_GATES[gate]
  if (!spec) throw new GateCommandError(`The gates that run a command are: ${Object.keys(COMMAND_GATES).join(", ")}.`)
  const text = typeof command === "string" ? command.trim() : ""
  if (!text || text.length > LIMIT || /[\r\n]/.test(text)) throw new GateCommandError(`A gate command is one line of at most ${LIMIT} characters.`)
  const entry = { command: text, confirmedAt: now().toISOString() }
  if (gate === "data") {
    if (!options.output) throw new GateCommandError("G-DATA needs --output <file or folder the pipeline writes>, to compare two runs.")
    entry.output = relative(options.output)
  }
  if (gate === "eval") {
    if (!options.metrics || !options.metric) throw new GateCommandError("G-EVAL needs --metrics <file.json> and --metric <name>, e.g. --metrics eval/metrics.json --metric f1.")
    entry.metrics = relative(options.metrics)
    entry.metric = String(options.metric).slice(0, 80)
    entry.direction = options.direction === "lower" ? "lower" : "higher"
    const margin = Number(options.margin ?? 0)
    if (!Number.isFinite(margin) || margin < 0) throw new GateCommandError("--margin is a number ≥ 0.")
    entry.margin = margin
  }
  if (gate === "sim-headless" && options.frameBudgetMs !== undefined) {
    const ms = Number(options.frameBudgetMs)
    if (!Number.isFinite(ms) || ms <= 0) throw new GateCommandError("--frame-budget-ms is a number above 0.")
    entry.frameBudgetMs = ms
  }
  const root = projectRoot(cwd)
  const projects = read()
  projects[root] = { ...(projects[root] ?? {}), [gate]: entry }
  write(gatesFile(), { version: 1, projects })
  return { root, gate, ...entry }
}

export function forgetGateCommand(cwd, gate) {
  const root = projectRoot(cwd)
  const projects = read()
  const had = Boolean(projects[root]?.[gate])
  if (projects[root]) delete projects[root][gate]
  write(gatesFile(), { version: 1, projects })
  return had
}

/** This project's confirmed gate commands: { data?: {...}, eval?: {...}, … } */
export const gateCommands = (cwd) => read()[projectRoot(cwd)] ?? {}

const baselineFile = (root) => join(kriyaHome(), "evidence", createHash("sha256").update(root).digest("hex").slice(0, 16), "eval-baseline.json")
const candidateFile = (root) => baselineFile(root).replace(/baseline\.json$/, "candidate.json")

export function readBaseline(root) {
  try {
    return JSON.parse(readFileSync(baselineFile(root), "utf8"))
  } catch {
    return null
  }
}
export const writeCandidate = (root, value) => write(candidateFile(root), value)

/** `kriya eval baseline confirm`: the last recorded first run becomes the baseline; only the person does this. */
export function confirmBaseline(cwd) {
  const root = projectRoot(cwd)
  if (!existsSync(candidateFile(root))) throw new GateCommandError("There's no recorded run to confirm yet: run the work with --gates once, then confirm.")
  const candidate = JSON.parse(readFileSync(candidateFile(root), "utf8"))
  write(baselineFile(root), { ...candidate, confirmedAt: new Date().toISOString() })
  return candidate
}
