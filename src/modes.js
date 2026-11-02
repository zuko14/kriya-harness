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
