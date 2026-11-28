import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// Kriya Harness modes: how much the agent may do on its own. Each mode is one
// sandbox mode and one approval policy of DeepSeek Harness, set through the
// kriya bundle's rows (bundle/cordis.patch.yml) from the launch variables
// below; DSH itself isn't edited. In DSH, approval `never` refuses anything
// that would need approval (it never allows it), so only `full` leaves the
// folder sandbox, and only when the person asks for it by name.

export const MODES = {
  ask: {
    sandbox: "workspace-write",
    approval: "ask",
    preset: "ask",
    label: "Ask",
    what: "Works in this folder and asks before anything beyond it, here or in Kriya on your phone.",
  },
  auto: {
    sandbox: "workspace-write",
    approval: "never",
    preset: "folder-auto",
    label: "Auto",
    what: "Works in this folder without asking; anything that would need your OK is refused instead.",
  },
  read: {
    sandbox: "read-only",
    approval: "never",
    preset: "read-only",
    label: "Read only",
    what: "Reads and answers; changes no file.",
  },
  plan: {
    sandbox: "read-only",
    approval: "never",
    preset: "read-only",
    label: "Plan",
    what: "Explores and writes a step-by-step plan; changes no file.",
  },
  full: {
    sandbox: "danger-full-access",
    approval: "never",
    preset: "full-access",
    label: "Full access",
    what: "No sandbox and no questions: it can change anything you can.",
  },
}

export const DEFAULT_MODE = "ask"

// The Web UI starts in one of these; it plans with DSH's own /plan instead
export const APP_MODES = ["ask", "auto", "read", "full"]

export const FULL_ACCESS_WARNING = `Full access: the agent runs commands and changes files anywhere you can,
with no sandbox and without asking. Use it only on a machine you can afford
to change.`

// `kriya run --mode plan`: the job, asked as a plan. The read-only sandbox
// and the `never` policy enforce it; these words only say what's wanted
export function planJob(job) {
  return `Plan only. Explore this folder as much as you need, then reply with a numbered, step-by-step plan for the task below: what you'd change, where, and how you'd check it. Don't change any file.

Task: ${job}`
}

export class ModeError extends Error {}

/** The mode named by `--mode`, else the default; throws ModeError for an unknown name. */
export function parseMode(value, allowed = Object.keys(MODES)) {
  if (value === undefined) return DEFAULT_MODE
  if (!allowed.includes(value))
    throw new ModeError(`--mode takes one of: ${allowed.join(", ")}.`)
  return value
}

/** The launch variables the kriya bundle's sandbox, approval and preset rows read. */
export function modeEnv(name) {
  const mode = MODES[name] ?? MODES[DEFAULT_MODE]
  return {
    KRIYA_SANDBOX: mode.sandbox,
    KRIYA_APPROVAL: mode.approval,
    KRIYA_PRESET: mode.preset,
  }
}

// The Kriya loop's verify step (the bundle's kriya-loop row reads
// KRIYA_LOOP), the turn budget (KRIYA_BUDGET) and the kept request
// (KRIYA_ANCHOR). Harness upgrade U10 (owner, 2026-11-04: "B4 is our
// winner"): the loop and the budget are on unless --no-loop / --no-budget
// or KRIYA_LOOP=off / KRIYA_BUDGET=off; --anchor stays opt-in (unmeasured).
// A flag beats the environment, which beats the default
export const SWITCHES = [
  ["loop", "KRIYA_LOOP", true],
  ["budget", "KRIYA_BUDGET", true],
  ["anchor", "KRIYA_ANCHOR", false],
  // Kriya loop v2 (KRIYA_LOOP_V2.md): opt-in until measured; needs the loop
  ["loop-v2", "KRIYA_LOOP_V2", false],
  // The loop guard (KRIYA_LOOP.md): on (owner, 2026-11-05); needs the loop
  ["loop-guard", "KRIYA_LOOP_GUARD", true],
  // The strict coding loop, reconnaissance and just-in-time tools
  // (KRIYA_CODING_HARNESS_REPORT.md): on (owner, 2026-11-05, unmeasured on a real model); they need the loop
  ["strict-loop", "KRIYA_STRICT_LOOP", true],
  // The defensive engine (KRIYA_DEFENSIVE_ENGINE_REPORT.md): turns the strict loop on too
  ["defensive", "KRIYA_DEFENSIVE", true],
  ["recon", "KRIYA_RECON", true],
  ["jit-tools", "KRIYA_JIT_TOOLS", true],
  // The agent's localhost browser (plugins/browser): on (owner, 2026-11-04:
  // the agent must use the browser we built, shown live in Preview, not its
  // own scripts); offered only where Google Chrome is installed
  ["browser-tools", "KRIYA_BROWSER", true],
  // The intent router (plugins/router): on (owner, 2026-11-05, unmeasured)
  ["router", "KRIYA_ROUTER", true],
  // Harness 2.0 role cartridges (Kriya-Tavi docs/kriya-harness/upgrade_2.0, W1):
  // one discipline's guidance per builder; opt-in until measured; needs the loop
  ["cartridges", "KRIYA_CARTRIDGES", false],
  // Harness 2.0 orchestra (W2): the session on the owner's head level, builders on the
  // worker level, the head taking over when the worker is stuck; opt-in until measured; needs the loop
  ["orchestra", "KRIYA_ORCHESTRA", false],
  // Harness 2.0 gates (W3): deterministic checks after the person's check passes
  // (secrets, contracts, the cartridge's detectors, flake and trace); opt-in until measured; needs the loop
  ["gates", "KRIYA_GATES", false],
  // Harness 2.0 critic (W6, WD-13): after a pass, a read-only head-level reviewer may earn one
  // polish attempt, kept only if every check still passes; opt-in until measured; needs the loop
  ["critic", "KRIYA_CRITIC", false],
  // Harness 2.0 milestones (W10, WD-12): long work as a ledger of at most 12 bounded plans,
  // each done only when its plan's every step passed; opt-in until measured; needs the loop
  ["milestones", "KRIYA_MILESTONES", false],
  // Harness 2.0 grounding (W15, WD-20): api_lookup, api_changes and api_version answer facts
  // about installed packages from their own files; nothing imported or run; opt-in until measured
  ["grounding", "KRIYA_GROUNDING", false],
  // Harness 2.0 repository tools (W16, WD-19): typed git and gh tools through the person's own login;
  // branch, commit, push and draft PR only with their approval, never in Auto; opt-in until measured
  ["repo-tools", "KRIYA_REPO_TOOLS", false],
  // Harness 2.0 MCP P3a (W16): the owner's registry servers that need no sign-in, tools pinned by hash; opt-in
  ["mcp", "KRIYA_MCP", false],
  // Harness 2.0 deploy (W17, WD-21, WD-22): G-RELEASE, preview and production deploys with approval,
  // G-DEPLOYED, and the person's own commands refused in the shell; opt-in
  ["deploy", "KRIYA_DEPLOY", false],
  // Harness 2.0 Explore (W14, WD-18): 2–3 gated takes of a creative step (frontend, designer, graphics) in one
  // folder, the person (or the critic, headless) keeping one; inside MAX_ATTEMPTS; needs the loop and cartridges; opt-in
  ["explore", "KRIYA_EXPLORE", false],
  // Harness 2.0 interface (W18, WD-23): the Run strip, gate chips, Mission Control and the
  // Live/Proof/Changes/Project tracks (old tab ids kept); off, the Web UI is as before; opt-in
  ["runstrip", "KRIYA_RUNSTRIP", false],
  // The Editing Studio (track E): off until the owner turns it on; off, nothing
  // under src/edit/ loads
  ["edit", "KRIYA_EDIT", false],
  // The Developer tab (plugins/cockpit, Kriya-Tavi docs/kriya-harness/DEVELOPER_COCKPIT.md):
  // GitHub, connections, running servers, project health; on from the owner's harness.cockpit
  ["cockpit", "KRIYA_COCKPIT", false],
  // Supabase and Render tools through the person's own CLIs (plugins/providers): reads free,
  // writes approved; the person's per computer, like repo-tools
  ["provider-tools", "KRIYA_PROVIDER_TOOLS", false],
]

/** Switches the person may turn on or off from the Developer tab, kept per computer in ~/.kriya/switches.json */
export const SAVED_SWITCHES = Object.freeze(["repo-tools", "provider-tools"])

const savedFile = () => join(process.env.KRIYA_HOME || join(homedir(), ".kriya"), "switches.json")

/** The person's saved switches ({ "repo-tools": true }); none when the file is missing or broken */
export function savedSwitches(file = savedFile()) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"))
    return Object.fromEntries(Object.entries(value ?? {}).filter(([k, v]) => SAVED_SWITCHES.includes(k) && typeof v === "boolean"))
  } catch {
    return {}
  }
}

/** Saves one of the person's switches for the next start of Kriya Harness */
export function saveSwitch(flag, on, file = savedFile()) {
  if (!SAVED_SWITCHES.includes(flag) || typeof on !== "boolean") throw new Error(`${flag} can't be saved.`)
  const next = { ...savedSwitches(file), [flag]: on }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  return next
}

/** The launch variable naming the switches the person set themself (a flag, or the variable in their shell) */
export const SET_BY_PERSON = "KRIYA_SWITCHES_SET"

/** Takes the switch flags out of `args` and sets each switch to "on" or "off" in `env`. */
export function switchEnv(args, env = process.env, saved = savedSwitches()) {
  const chosen = new Set((env[SET_BY_PERSON] ?? "").split(",").filter(Boolean))
  for (const [flag, name, byDefault] of SWITCHES) {
    // The person's choice from the Developer tab, under any flag or variable of theirs
    if (env[name] !== "on" && env[name] !== "off" && SAVED_SWITCHES.includes(flag) && typeof saved[flag] === "boolean") env[name] = saved[flag] ? "on" : "off"
    if (env[name] === "on" || env[name] === "off") chosen.add(flag)
    let value = env[name] === "on" ? true : env[name] === "off" ? false : byDefault
    for (const [form, on] of [[`--${flag}`, true], [`--no-${flag}`, false]]) {
      const at = args.indexOf(form)
      if (at === -1) continue
      args.splice(at, 1)
      value = on
      chosen.add(flag)
    }
    env[name] = value ? "on" : "off"
  }
  // Recorded once, from the first call: later calls see the defaults written above, not the person's choice
  env[SET_BY_PERSON] ??= [...chosen].join(",")
}

/**
 * Harness 2.0 switches the owner turns on for every device with Kriya's
 * harness.workforce (GET /models `workforce: 1`). Each still yields to the
 * person's own flag or variable (`kriya --no-gates`). Repository tools and
 * deploys act on the person's own GitHub and hosting logins, so they stay the
 * person's to turn on per device (`kriya --repo-tools --deploy`); the Editing
 * Studio has its own owner switch.
 */
export const WORKFORCE_SWITCHES = Object.freeze(["cartridges", "orchestra", "gates", "critic", "milestones", "grounding", "explore", "runstrip", "mcp"])

/**
 * Standalone Mode (no Kriya account, or Kriya unreachable): the Harness 2.0
 * switches that run on this computer alone. MCP reads the owner's registry
 * from Kriya, so it stays off.
 */
export const STANDALONE_SWITCHES = Object.freeze(WORKFORCE_SWITCHES.filter((flag) => flag !== "mcp"))

/**
 * Turns on the owner's Harness 2.0 switches the person didn't set, when Kriya
 * advertises them (or Standalone Mode, with its own list). Without the
 * advertisement nothing changes (HT-REG).
 * @returns {string[]} the switches this turned on
 */
export function applyWorkforce(env = process.env, advertised = false, list = WORKFORCE_SWITCHES) {
  if (!advertised) return []
  const chosen = new Set((env[SET_BY_PERSON] ?? "").split(",").filter(Boolean))
  const turned = []
  for (const [flag, name] of SWITCHES) {
    if (!list.includes(flag) || chosen.has(flag) || env[name] === "on") continue
    env[name] = "on"
    turned.push(flag)
  }
  return turned
}

