// The Edit Loop's Compose search (EDIT_LOOP §3): one valid best-so-far version at
// every moment (the anytime guarantee), attempts ranked lexicographically by
// ρ = (blocking failures, brief misses, notes, −quality), and a new attempt accepted
// only if it ranks strictly better. A worse attempt is set aside and kept in history.
// Shares nothing with src/loop.js (EDIT_LOOP §1); only its rule is borrowed.

/** ρ(a) from a verdict: lower is better, compared left to right. */
export const rankOf = ({ blocking = 0, briefMisses = 0, notes = 0, quality = 0 }) => [blocking, briefMisses, notes, -quality]

export function compare(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

export const STOPS = { satisfied: "S1", budget: "S2", stalled: "S3", interrupted: "S4", fast: "S5", exhausted: "rounds" }

/**
 * @param {{
 *   start: object,
 *   propose: (best: object, round: number) => Promise<object[]>,
 *   evaluate: (candidate: object, signal?: AbortSignal) => Promise<{ blocking: number, briefMisses: number, notes: number, quality: number }>,
 *   signal?: AbortSignal,
 *   rounds?: number, patience?: number, floor?: number, effort?: "fast" | "best",
 *   budget?: { left: () => number },
 *   onBest?: (best: object) => void,
 * }} options
 * @returns {Promise<{ best: { candidate: object, verdict: object, rank: number[] }, history: object[], stop: string }>}
 */
export async function search({ start, propose, evaluate, signal, rounds = 3, patience = 2, floor = 0, effort = "best", budget = { left: () => Infinity }, onBest = () => {} }) {
  // The start is a version that already plays: the floor the loop can never go below
  const first = await evaluate(start, signal).catch(() => ({ blocking: Infinity, briefMisses: Infinity, notes: 0, quality: 0, error: true }))
  let best = { candidate: start, verdict: first, rank: rankOf(first) }
  const history = [{ ...best, accepted: true, round: 0 }]
  onBest(best)

  const satisfied = () => best.verdict.blocking === 0 && best.verdict.briefMisses === 0 && best.verdict.quality >= floor
  const stop = (reason) => ({ best, history, stop: reason })
  let stale = 0
  for (let round = 1; round <= rounds; round++) {
    if (signal?.aborted) return stop(STOPS.interrupted)
    if (satisfied()) return stop(STOPS.satisfied)
    if (effort === "fast" && best.verdict.blocking === 0 && best.verdict.briefMisses === 0) return stop(STOPS.fast)
    if (budget.left() <= 0) return stop(STOPS.budget)
    let improved = false
    for (const candidate of await propose(best, round)) {
      if (signal?.aborted) return stop(STOPS.interrupted)
      if (budget.left() <= 0) return stop(STOPS.budget)
      let verdict
      try {
        verdict = await evaluate(candidate, signal)
      } catch (error) {
        if (signal?.aborted) return stop(STOPS.interrupted)
        history.push({ candidate, verdict: { error: error.message }, rank: null, accepted: false, round })
        continue
      }
      const rank = rankOf(verdict)
      const accepted = compare(rank, best.rank) < 0
      history.push({ candidate, verdict, rank, accepted, round })
      if (accepted) {
        best = { candidate, verdict, rank }
        improved = true
        onBest(best)
      }
    }
    stale = improved ? 0 : stale + 1
    if (stale >= patience) return stop(STOPS.stalled)
  }
  return stop(satisfied() ? STOPS.satisfied : STOPS.exhausted)
}
