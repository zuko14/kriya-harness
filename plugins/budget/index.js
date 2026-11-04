import { createUserMessage } from "@deepseek-ai/dsh-llm"

// The turn budget (harness upgrade U2, KU-ADR-04 in the Kriya repository's
// docs/kriya-harness/harness_upgradation). DSH's loop has no turn budget of
// its own (dsh-agent-loop README, "No built-in turn budget"): a model that
// never stops calling tools runs until the plan's monthly cap. This bounds
// one turn by code, never by the model: at most `maxSteps` steps, at most
// `maxMinutes` of wall time, and at most `maxRepeats` identical tool calls
// in a row (same tool, same arguments; DSH's own reminder only nudges at
// 3, 5 and 8). Near the step or time limit the agent is told once to wrap
// up; at a limit the next step is refused, so the turn ends "blocked" and
// `kriya run` exits 1, never "completed". Per agent, so a step's builder
// (kriya_step) has its own budget. Off unless kriya was started with
// --budget (the bundle row's switch).

export const name = "kriya-budget"

const whole = (value, fallback) => {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : fallback
}

/** The limits, from the launch environment; defaults when unset or unusable. */
export function budgetLimits(env = process.env) {
  return {
    maxSteps: whole(env.KRIYA_MAX_STEPS, 150),
    maxMinutes: whole(env.KRIYA_TURN_MINUTES, 60),
    maxRepeats: whole(env.KRIYA_MAX_REPEATS, 10),
  }
}

// The steps left when the agent is told to wrap up
export const WARN_STEPS = 5

// Same tool, same arguments, whatever the key order
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object")
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]))
  return value
}

export const warning = (left) =>
  `Kriya's turn budget: about ${left} step${left === 1 ? "" : "s"} left in this turn. Finish the current change, ` +
  "run the check if there is one, and reply with what is done and what isn't. The turn is stopped at the limit."

/**
 * The guard's two hooks, free of DSH so they can be tested alone.
 * @param {{ maxSteps: number, maxMinutes: number, maxRepeats: number }} limits
 * @param {{ now?: () => number, message?: (text: string) => any, stopped?: (reason: string) => void }} [host]
 */
export function budgetGuard(limits, host = {}) {
  const now = host.now ?? Date.now
  const message =
    host.message ??
    ((text) => createUserMessage({ content: [{ type: "text", text }], source: { kind: "kriya-budget", form: "notice", summary: "turn budget" } }))
  /** @type {WeakMap<object, { turn: number, started: number, steps: number, last: string | null, repeats: number, warned: boolean }>} */
  const turns = new WeakMap()

  return {
    /** agent/pre-step (waterfall): counts steps, warns once, refuses at a limit */
    async preStep({ agent, turn }, next) {
      let s = turns.get(agent)
      if (!s || s.turn !== turn) {
        s = { turn, started: now(), steps: 0, last: null, repeats: 0, warned: false }
        turns.set(agent, s)
      }
      s.steps += 1
      const elapsed = now() - s.started
      const reason =
        s.steps > limits.maxSteps
          ? `${limits.maxSteps} steps`
          : elapsed > limits.maxMinutes * 60_000
            ? `${limits.maxMinutes} minutes`
            : s.repeats >= limits.maxRepeats
              ? `${s.repeats} identical calls in a row`
              : null
      if (reason) {
        host.stopped?.(reason)
        return { kind: "reject" }
      }
      const decision = await next()
      const left = limits.maxSteps - s.steps + 1
      const late = left <= WARN_STEPS || elapsed > limits.maxMinutes * 54_000
      if (s.warned || !late || decision.kind !== "enter") return decision
      s.warned = true
      return { ...decision, messages: [...decision.messages, message(warning(Math.max(1, left)))] }
    },
    /** tools/post-execute (waterfall): counts identical calls in a row */
    async postExecute(exec, _result, next) {
      const s = exec.agent && turns.get(exec.agent)
      if (s) {
        const key = JSON.stringify([exec.name, canonical(exec.arguments ?? null)])
        s.repeats = key === s.last ? s.repeats + 1 : 1
        s.last = key
      }
      return next()
    },
  }
}

export function apply(ctx) {
  const limits = budgetLimits()
  const log = ctx.logger("kriya-budget")
  const guard = budgetGuard(limits, { stopped: (reason) => log.warn(`turn stopped by its budget: ${reason}`) })
  ctx.on("agent/pre-step", guard.preStep)
  ctx.on("tools/post-execute", guard.postExecute)
}
