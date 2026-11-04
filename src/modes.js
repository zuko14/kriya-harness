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
  // The agent's localhost browser (plugins/browser): opt-in, needs Google Chrome
  ["browser-tools", "KRIYA_BROWSER", false],
]

/** Takes the switch flags out of `args` and sets each switch to "on" or "off" in `env`. */
export function switchEnv(args, env = process.env) {
  for (const [flag, name, byDefault] of SWITCHES) {
    let value = env[name] === "on" ? true : env[name] === "off" ? false : byDefault
    for (const [form, on] of [[`--${flag}`, true], [`--no-${flag}`, false]]) {
      const at = args.indexOf(form)
      if (at === -1) continue
      args.splice(at, 1)
      value = on
    }
    env[name] = value ? "on" : "off"
  }
}

