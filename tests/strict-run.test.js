import assert from "node:assert/strict"
import { test } from "node:test"

import { runScenario, STRICT_SCENARIOS } from "./guard-scenarios.js"

// The strict loop, recon and JIT tools on the real pinned DSH, scripted
// model. scripts/bench-guard.js --set strict records the same scenarios.

const pair = async (name) => {
  const guard = await runScenario(name, { flags: ["--loop-guard"] })
  const strict = await runScenario(name, { flags: ["--strict-loop"] })
  return { guard, strict, report: JSON.stringify({ guard: { ...guard, prompts: 0 }, strict: { ...strict, prompts: 0 } }).slice(0, 2000) }
}

test("ST-RUN-01: two attempts break two files: undone together, the third starts clean and passes", { timeout: 200_000 }, async () => {
  const { guard, strict, report } = await pair("multi-file-rollback")
  assert.equal(strict.passed, true, report)
  assert.equal(strict.verdict, "verified", report)
  assert.equal(strict.trajectory.rollbacks, 1, report)
  assert.equal(strict.trajectory.earlyFailures, 2, report)
  assert.deepEqual(strict.syntaxBroken, [], report)
  assert.equal(guard.trajectory.rollbacks, 0, report)
})

test("ST-RUN-02: a step that stays broken leaves no broken file behind", { timeout: 200_000 }, async () => {
  const { guard, strict, report } = await pair("blocked-rollback")
  assert.deepEqual(guard.syntaxBroken, ["a.js", "b.js"], report)
  assert.deepEqual(strict.syntaxBroken, [], report)
})

test("ST-RUN-03: a weakened test and an empty catch can't pass; off they read verified", { timeout: 300_000 }, async () => {
  for (const name of ["weakened-test", "silenced-error"]) {
    const { guard, strict, report } = await pair(name)
    assert.equal(guard.passed, false, report)
    assert.equal(guard.verdict, "verified", report)
    assert.equal(strict.passed, true, report)
    assert.equal(strict.verdict, "verified", report)
  }
})

test("ST-RUN-04: a fix with no red phase isn't verified", { timeout: 200_000 }, async () => {
  const { guard, strict, report } = await pair("no-reproduction")
  assert.equal(guard.verdict, "verified", report)
  assert.notEqual(strict.verdict, "verified", report)
  assert.equal(strict.trajectory.classes["no reproduction"], 4, report)
})

test("ST-RUN-05: every strict scenario has a fixture", () => assert.equal(Object.keys(STRICT_SCENARIOS).length, 5))

test("ST-RUN-06: recon and the syntax hook on a builder's real calls; JIT takes heavy tools from that builder only", { timeout: 200_000 }, async () => {
  const on = await runScenario("builder-tools", { flags: ["--strict-loop", "--recon", "--jit-tools"] })
  const off = await runScenario("builder-tools", { flags: ["--strict-loop", "--recon"] })
  const report = JSON.stringify({ tools: on.builderTools, results: on.builderResults, off: off.builderToolChars, on: on.builderToolChars, stderr: on.stderr }).slice(0, 2500)
  const [read, outline, impact, broken, fixed] = on.builderResults
  assert.match(read, /at most 400/, report)
  assert.match(outline, /451: function late/, report)
  assert.match(impact, /Nothing in this project imports it/, report)
  assert.match(broken, /no longer parses/, report)
  assert.doesNotMatch(fixed, /no longer parses/, report)
  assert.ok(on.builderTools.includes("code_outline"), report)
  assert.ok(!on.builderTools.some((t) => t.startsWith("browser_") || t.startsWith("rea_")), report)
  assert.ok(off.builderTools.some((t) => t.startsWith("browser_") || t.startsWith("rea_")), report)
  assert.ok(on.parentTools.some((t) => t.startsWith("browser_") || t.startsWith("rea_")), report)
  assert.ok(on.builderToolChars < off.builderToolChars, report)
  console.log(`ST-RUN-06 builder tool schema chars: ${off.builderToolChars} → ${on.builderToolChars}`)
})
