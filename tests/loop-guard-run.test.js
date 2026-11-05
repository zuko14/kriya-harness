import assert from "node:assert/strict"
import { test } from "node:test"

import { runScenario } from "./guard-scenarios.js"

// The loop guard end to end on the real pinned DSH (KriyaBench-M): each
// scenario with the switch off and on. Scripted model, nothing leaves this
// machine. scripts/bench-guard.js runs the same scenarios to record numbers.

const pair = async (name) => {
  const off = await runScenario(name)
  const on = await runScenario(name, { guard: true })
  const report = JSON.stringify({ off: { ...off, prompts: off.prompts.length }, on: { ...on, prompts: on.prompts.length } }).slice(0, 2500)
  return { off, on, report }
}

test("LG-RUN-01: a model that stops after step 1 of 3 is sent back and finishes; off, the session says partial, not verified", { timeout: 300_000 }, async () => {
  const { off, on, report } = await pair("premature-stop")
  assert.equal(off.passed, false, report)
  assert.equal(off.verdict, "partial", report)
  assert.equal(off.builders, 1, report)
  assert.equal(on.passed, true, report)
  assert.equal(on.verdict, "verified", report)
  assert.equal(on.builders, 3, report)
})

test("LG-RUN-02: a builder that changes nothing costs two builders, not four", { timeout: 300_000 }, async () => {
  const { off, on, report } = await pair("no-change")
  assert.equal(off.builders, 4, report)
  assert.equal(on.builders, 2, report)
  assert.equal(on.trajectory.stalled, 1, report)
  assert.match(on.last, /stopped early/, report)
})

test("LG-RUN-03: a check that can't run costs two builders, not four", { timeout: 300_000 }, async () => {
  const { off, on, report } = await pair("env-missing")
  assert.equal(off.builders, 4, report)
  assert.equal(on.builders, 2, report)
})

test("LG-RUN-04: an outage of four builders blocks the step off; on, the attempts survive and it passes", { timeout: 300_000 }, async () => {
  const { off, on, report } = await pair("provider-error")
  assert.equal(off.passed, false, report)
  assert.equal(on.passed, true, report)
  assert.equal(on.trajectory.interrupted, 2, report)
})

test("LG-RUN-05: crash and resume: the resumed builder has the failure's text; off it starts blind", { timeout: 300_000 }, async () => {
  const { off, on, report } = await pair("crash-resume")
  assert.equal(on.passed, true, report)
  assert.equal(off.passed, true, report)
  assert.ok(on.builders < off.builders, report)
})
