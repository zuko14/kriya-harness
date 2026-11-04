import assert from "node:assert/strict"
import { test } from "node:test"

import { budgetGuard, budgetLimits, WARN_STEPS } from "../plugins/budget/index.js"

// Harness upgrade U2 (HU-BG-01…03): the turn budget's rules, without DSH. The
// end-to-end runs on the real DSH are tests/upgrade-run.test.js.

const enter = async () => ({ kind: "enter", messages: [] })
const setup = (limits, start = 0) => {
  let clock = start
  const guard = budgetGuard({ maxSteps: 150, maxMinutes: 60, maxRepeats: 10, ...limits }, { now: () => clock, message: (text) => ({ text }) })
  return { guard, tick: (ms) => (clock += ms) }
}

test("HU-BG-01: limits come from the launch environment, defaults otherwise", () => {
  assert.deepEqual(budgetLimits({}), { maxSteps: 150, maxMinutes: 60, maxRepeats: 10 })
  assert.deepEqual(budgetLimits({ KRIYA_MAX_STEPS: "8", KRIYA_TURN_MINUTES: "5", KRIYA_MAX_REPEATS: "3" }), { maxSteps: 8, maxMinutes: 5, maxRepeats: 3 })
  // Unusable values never lift or remove a limit
  assert.deepEqual(budgetLimits({ KRIYA_MAX_STEPS: "0", KRIYA_TURN_MINUTES: "-1", KRIYA_MAX_REPEATS: "lots" }), { maxSteps: 150, maxMinutes: 60, maxRepeats: 10 })
})

test("HU-BG-02: steps and time: one warning near the end, then the step is refused; a new turn starts fresh", async () => {
  const { guard, tick } = setup({ maxSteps: 7 })
  const agent = {}
  const seen = []
  for (let step = 1; step <= 8; step++) seen.push(await guard.preStep({ agent, turn: 1, step }, enter))
  const warnedAt = seen.map((d, i) => (d.messages?.length ? i + 1 : 0)).filter(Boolean)
  assert.deepEqual(warnedAt, [7 - WARN_STEPS + 1])
  assert.match(seen[warnedAt[0] - 1].messages[0].text, /5 steps left/)
  assert.deepEqual(seen[7], { kind: "reject" })
  // The next turn has its own budget
  assert.equal((await guard.preStep({ agent, turn: 2, step: 1 }, enter)).kind, "enter")

  const timed = setup({ maxMinutes: 10 })
  assert.equal((await timed.guard.preStep({ agent, turn: 1, step: 1 }, enter)).messages.length, 0)
  timed.tick(9.5 * 60_000)
  assert.match((await timed.guard.preStep({ agent, turn: 1, step: 2 }, enter)).messages[0].text, /turn budget/)
  timed.tick(60_000)
  assert.deepEqual(await timed.guard.preStep({ agent, turn: 1, step: 3 }, enter), { kind: "reject" })
  // A refusal from an earlier listener stays a refusal, and nothing is added to it
  const other = setup({ maxSteps: 2 })
  assert.deepEqual(await other.guard.preStep({ agent, turn: 1, step: 1 }, async () => ({ kind: "reject" })), { kind: "reject" })
})

test("HU-BG-03: identical calls in a row, whatever the key order, stop the turn; a different call resets the count", async () => {
  const { guard } = setup({ maxRepeats: 3 })
  const agent = {}
  const post = (args) => guard.postExecute({ agent, name: "bash", arguments: args }, {}, async () => "next")
  await guard.preStep({ agent, turn: 1, step: 1 }, enter)
  assert.equal(await post({ command: "ls", description: "a" }), "next")
  await post({ description: "a", command: "ls" })
  await post({ command: "pwd" })
  await post({ command: "pwd" })
  assert.equal((await guard.preStep({ agent, turn: 1, step: 2 }, enter)).kind, "enter")
  await post({ command: "pwd" })
  assert.deepEqual(await guard.preStep({ agent, turn: 1, step: 3 }, enter), { kind: "reject" })
  // Another agent (a step's builder) isn't counted with it
  assert.equal((await guard.preStep({ agent: {}, turn: 1, step: 1 }, enter)).kind, "enter")
})
