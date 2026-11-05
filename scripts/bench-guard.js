#!/usr/bin/env node
// KriyaBench-M for the loop guard: node scripts/bench-guard.js --client <checkout> [--guard] --runs 3 --out-prefix <path>
// Runs tests/guard-scenarios.js and writes one report per run, in the shape
// KriyaBench and KRHE read (lib/harness/bench in the Kriya repository).
// Scripted model, no spend. It measures mechanics, not a model's ability.
import { writeFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { DEFENSIVE_SCENARIOS, runScenario, SCENARIOS, STRICT_SCENARIOS } from "../tests/guard-scenarios.js"

const { values } = parseArgs({ options: { client: { type: "string" }, guard: { type: "boolean", default: false }, strict: { type: "boolean", default: false }, defensive: { type: "boolean", default: false }, set: { type: "string", default: "guard" }, runs: { type: "string", default: "1" }, "out-prefix": { type: "string" } } })
if (!values["out-prefix"]) {
  console.error("Usage: --out-prefix <path> [--client <checkout>] [--guard] [--runs <n>]")
  process.exit(2)
}

for (let run = 1; run <= Number(values.runs); run++) {
  const results = []
  for (const name of Object.keys({ guard: SCENARIOS, strict: STRICT_SCENARIOS, defensive: DEFENSIVE_SCENARIOS }[values.set])) {
    const r = await runScenario(name, { ...(values.client && { client: values.client }), guard: values.guard, flags: [...(values.strict ? ["--strict-loop"] : []), ...(values.defensive ? ["--defensive"] : [])] })
    results.push({
      id: name,
      kind: "coding",
      level: "multi",
      status: r.passed ? "passed" : "failed",
      verifyExit: r.passed ? 0 : 1,
      escaped: false,
      leaked: false,
      tampered: false,
      constraintBroken: false,
      agentExit: r.exit,
      agentTimedOut: false,
      durationMs: r.durationMs,
      inputTokens: null,
      outputTokens: null,
      costMicroUsd: null,
      costMicroInr: null,
      agentOutputTail: "",
      trajectory: { status: r.verdict ?? (r.trajectory?.blocked ? "blocked" : "not checked"), ...(r.trajectory ?? {}), builders: r.builders },
      syntaxBroken: r.syntaxBroken,
      modelRequests: r.requests,
      promptChars: r.promptChars,
    })
    console.error(`${name}: ${r.passed ? "passed" : "failed"}, verdict ${r.verdict}, ${r.builders} builders, ${r.requests} requests, ${r.promptChars} prompt chars, ${r.durationMs} ms`)
  }
  const out = `${values["out-prefix"]}-${run}.json`
  writeFileSync(out, `${JSON.stringify({ seedVersion: `${values.set}-m1`, agent: `kriya run --loop${values.guard ? " --loop-guard" : ""}${values.strict ? " --strict-loop" : ""}${values.defensive ? " --defensive" : ""}`, client: values.client ?? "this checkout", results }, null, 2)}\n`)
}
