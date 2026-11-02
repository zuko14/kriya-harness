import assert from "node:assert/strict"
import { test } from "node:test"

import { CASES, grade } from "../scripts/skill-eval.js"

// scripts/skill-eval.js grading, on recorded event shapes (no model call)

const call = (tool, input = {}) => ({ type: "tool_call", tool, input })
const debug = CASES.find((c) => c.id === "debug")
const trivial = CASES.find((c) => c.id === "trivial")

test("a fitting skill loaded before acting passes; a wrong one, none, or one loaded late doesn't count as before", () => {
  assert.deepEqual(grade(debug, [call("skill", { name: "systematic-debugging" }), call("bash")]), {
    id: "debug",
    pass: true,
    loaded: ["systematic-debugging"],
    fitting: ["systematic-debugging"],
    beforeActing: true,
  })
  assert.equal(grade(debug, [call("skill", { name: "brainstorming" })]).pass, false)
  assert.equal(grade(debug, [call("bash")]).pass, false)
  const late = grade(debug, [call("bash"), call("skill", { name: "systematic-debugging" })])
  assert.equal(late.pass, true)
  assert.equal(late.beforeActing, false)
})

test("the control passes only when nothing is loaded; every case is well formed", () => {
  assert.equal(grade(trivial, []).pass, true)
  assert.equal(grade(trivial, [call("skill", { name: "brainstorming" })]).pass, false)
  assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length)
  for (const c of CASES) assert.ok(c.job.length > 10 && Array.isArray(c.good), c.id)
})
