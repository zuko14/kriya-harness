// Harness 2.0 W2, the orchestra (Kriya-Tavi docs/kriya-harness/upgrade_2.0/
// ORCHESTRA.md, ARCHITECTURE.md §5): the session runs on the owner's head
// level; a step's builders run on the worker level and the head takes over
// after `escalateAfter` failed attempts, or when the worker is stuck, inside
// the existing 4 attempts. Pure: code decides, from recorded failure classes
// and signatures, never from model text. Off unless kriya was started with
// --orchestra (KRIYA_ORCHESTRA=on) and Kriya offered both levels (GET /models
// `orchestra`); otherwise every builder runs on the session's own level, as before.

export const DEFAULT_ESCALATE_AFTER = 2

/** The head and worker levels for this process, or undefined: only aliases the plan allows, never from the shell alone. */
export function orchestraFromEnv(env = process.env) {
  if (env.KRIYA_ORCHESTRA !== "on" || env.KRIYA_LOOP !== "on") return undefined
  const allowed = String(env.KRIYA_ALLOWED_TIERS ?? "").split(",").filter(Boolean)
  const head = env.KRIYA_ORCHESTRA_HEAD
  const worker = env.KRIYA_ORCHESTRA_WORKER
  if (!head || !worker || head === worker || !allowed.includes(head) || !allowed.includes(worker)) return undefined
  return { head, worker }
}

/**
 * The level for attempt `attempt` (1-based) of a step.
 *   head   when attempt > escalateAfter (architect steps: always),
 *   head   when `force` (the loop guard would stall a worker; ARCHITECTURE §5),
 *   head   when the worker is stuck: the last two failures had the same signature,
 *   worker otherwise, and always after an `environment` failure (a stronger
 *          model can't install a tool or fix a machine).
 * @param {{ orchestra?: { head: string, worker: string }, attempt: number, previous?: { kind?: string, sig?: string }, earlier?: { sig?: string }, force?: boolean, escalateAfter?: number, role?: string }} input
 */
export function tierFor({ orchestra, attempt, previous, earlier, force = false, escalateAfter = DEFAULT_ESCALATE_AFTER, role }) {
  if (!orchestra) return undefined
  if (previous?.kind === "environment") return orchestra.worker
  const after = role === "architect" ? 0 : Number.isInteger(escalateAfter) && escalateAfter >= 0 && escalateAfter <= 4 ? escalateAfter : DEFAULT_ESCALATE_AFTER
  if (force || attempt > after) return orchestra.head
  if (previous?.sig && earlier?.sig === previous.sig) return orchestra.head
  return orchestra.worker
}

/** KRHE's escalateAfter (W10): a profile pins it with KRIYA_ESCALATE_AFTER, 0 to 4; anything else leaves the default. */
export function escalateAfterFromEnv(env = process.env) {
  return /^[0-4]$/.test(env.KRIYA_ESCALATE_AFTER ?? "") ? Number(env.KRIYA_ESCALATE_AFTER) : undefined
}
