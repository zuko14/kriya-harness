// The analysis of KriyaEditBench-R (EVALUATION_PLAN §5, §6): pure, seeded, and written before
// any run, so nobody picks a method after seeing the numbers. A win under the interval's
// lower bound is reported as no result.

/** A small seeded generator, so a report can be repeated exactly. */
function prng(seed) {
  let s = seed >>> 0
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296
}

/**
 * @typedef {{ task: string, a: string, b: string, winner: string | null }} Comparison winner null is "about equal"
 */

/** One arm's wins against another, ties split, with the normal approximation's interval. */
export function winRate(comparisons, arm, against) {
  const pairs = comparisons.filter((c) => (c.a === arm && c.b === against) || (c.a === against && c.b === arm))
  const score = pairs.reduce((sum, c) => sum + (c.winner === arm ? 1 : c.winner === null ? 0.5 : 0), 0)
  const n = pairs.length
  if (!n) return { n: 0, rate: null, se: null, lower: null, upper: null, excludesEven: false }
  const rate = score / n
  // At p = 0.5, as §6 sizes it: the question is whether the result excludes even
  const se = Math.sqrt(0.25 / n)
  const lower = rate - 1.96 * se
  return { n, rate, se, lower, upper: rate + 1.96 * se, excludesEven: lower > 0.5 }
}

/** Bradley-Terry strengths by the MM algorithm, ties split. Sums to 1. */
export function bradleyTerry(comparisons, { rounds = 500 } = {}) {
  const arms = [...new Set(comparisons.flatMap((c) => [c.a, c.b]))].sort()
  const wins = new Map(arms.map((arm) => [arm, 0]))
  const games = new Map()
  const gameKey = (x, y) => [x, y].sort().join("\u0000")
  for (const c of comparisons) {
    games.set(gameKey(c.a, c.b), (games.get(gameKey(c.a, c.b)) ?? 0) + 1)
    if (c.winner === null) {
      wins.set(c.a, wins.get(c.a) + 0.5)
      wins.set(c.b, wins.get(c.b) + 0.5)
    } else wins.set(c.winner, wins.get(c.winner) + 1)
  }
  let strength = new Map(arms.map((arm) => [arm, 1 / arms.length]))
  for (let round = 0; round < rounds; round++) {
    const next = new Map()
    for (const arm of arms) {
      let denominator = 0
      for (const other of arms) {
        if (other === arm) continue
        denominator += (games.get(gameKey(arm, other)) ?? 0) / (strength.get(arm) + strength.get(other))
      }
      // A small floor: an arm that never won still has a defined strength
      next.set(arm, Math.max(wins.get(arm), 1e-3) / (denominator || 1))
    }
    const total = [...next.values()].reduce((sum, value) => sum + value, 0)
    strength = new Map([...next].map(([arm, value]) => [arm, value / total]))
  }
  return Object.fromEntries(strength)
}

/** Bootstrap 95 % intervals over comparisons. Seeded. */
export function bootstrap(comparisons, { samples = 1000, seed = 1 } = {}) {
  const random = prng(seed)
  const seen = new Map()
  for (let s = 0; s < samples; s++) {
    const drawn = comparisons.map(() => comparisons[Math.floor(random() * comparisons.length)])
    for (const [arm, value] of Object.entries(bradleyTerry(drawn, { rounds: 100 }))) seen.set(arm, [...(seen.get(arm) ?? []), value])
  }
  return Object.fromEntries(
    [...seen].map(([arm, values]) => {
      values.sort((a, b) => a - b)
      return [arm, { lower: values[Math.floor(values.length * 0.025)], upper: values[Math.floor(values.length * 0.975)] }]
    })
  )
}

/** Paired sign test by task: exact two-sided binomial. Tasks that tie are left out. */
export function signTest(comparisons, arm, against) {
  const byTask = new Map()
  for (const c of comparisons) {
    if (!((c.a === arm && c.b === against) || (c.a === against && c.b === arm))) continue
    const score = c.winner === arm ? 1 : c.winner === against ? -1 : 0
    byTask.set(c.task, (byTask.get(c.task) ?? 0) + score)
  }
  const scores = [...byTask.values()].filter((score) => score !== 0)
  const wins = scores.filter((score) => score > 0).length
  const n = scores.length
  let tail = 0
  let choose = 1
  const k = Math.min(wins, n - wins)
  for (let i = 0; i <= k; i++) {
    tail += choose
    choose = (choose * (n - i)) / (i + 1)
  }
  return { n, wins, p: n ? Math.min(1, (2 * tail) / 2 ** n) : 1 }
}

/** C1: money per accepted video, in integers of micro-USD (invariant 6). Null until one's accepted. */
export function costPerAccepted(runs) {
  const accepted = runs.filter((run) => run.accepted).length
  const spent = runs.reduce((sum, run) => sum + run.costMicroUsd, 0)
  if (!runs.every((run) => Number.isSafeInteger(run.costMicroUsd))) throw new Error("Costs are integers of micro-USD.")
  return { runs: runs.length, accepted, spentMicroUsd: spent, perAcceptedMicroUsd: accepted ? Math.round(spent / accepted) : null }
}

/** F2: the same task, k runs, every one acceptable. */
export function passK(runs) {
  const byTask = new Map()
  for (const run of runs) byTask.set(run.task, [...(byTask.get(run.task) ?? []), run.accepted])
  const tasks = [...byTask.values()]
  return tasks.length ? tasks.filter((list) => list.every(Boolean)).length / tasks.length : null
}
