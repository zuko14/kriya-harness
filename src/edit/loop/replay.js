// `kriya edit replay <job>` (EDIT_LOOP §10, ED10): the job again from its flight
// recorder. Every Director slot is answered with the answer it got the first time,
// so the run costs no model call and has no randomness; render and gates run for real.

/**
 * An `ask` that answers from recorded slot answers, in order per task. A slot the
 * recording doesn't have is refused, never sent to a model.
 * @param {{ task: string, source: string, value: string }[]} answers the journal's rows, JSON values
 */
export function replayAsk(answers) {
  const queues = new Map()
  for (const row of answers) {
    if (!queues.has(row.task)) queues.set(row.task, [])
    queues.get(row.task).push(row)
  }
  return async function ask({ task }) {
    const row = queues.get(task)?.shift()
    if (!row) throw new Error(`The recording has no answer for "${task}", so the replay stops here.`)
    return { value: JSON.parse(row.value), source: `replay:${row.source}`, calls: 0 }
  }
}

/** What a replay compares with the job it repeats: never model text, only measured outcomes. */
export function compareRuns(original, again) {
  const differences = []
  if (original.verdict !== again.verdict) differences.push(`verdict: ${original.verdict} → ${again.verdict}`)
  if (original.planHash && again.planHash && original.planHash !== again.planHash) differences.push("the plan differs")
  const byId = (gates) => new Map((gates ?? []).map((g) => [g.id, g.status]))
  const [a, b] = [byId(original.gates), byId(again.gates)]
  for (const [id, status] of a) if (b.get(id) !== status) differences.push(`${id}: ${status} → ${b.get(id)}`)
  return { same: differences.length === 0, differences }
}
