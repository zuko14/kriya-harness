import assert from "node:assert/strict"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { offeredProjects, runDaemon } from "../src/daemon.js"
import { stepsProof } from "../src/proof.js"
import { readDevice } from "../src/store.js"
import { confirmCheck, stepLabel } from "../src/verify.js"
import { startFakeKriya } from "./fake-kriya.js"
import { contract, freshHome, ROOT, violations } from "./helpers.js"

// S-3 task proof (src/proof.js; Kriya-Tavi docs/kriya-harness/TASK_PROOF.md):
// a task Kriya queues with `proof: true` runs through the real daemon and
// the real, pinned DSH with the owner's orchestra on, and reports live steps,
// the code-computed verdict, who built each attempt, the gates and the changed
// files as names and line counts. No file content leaves. Without `proof`,
// the report is as before.

const textOf = (content) => (typeof content === "string" ? content : (content ?? []).map((p) => p?.text ?? "").join("\n"))

function login(url) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", url, "--no-browser"], { cwd: ROOT })
    child.on("exit", (code) => done(code))
  })
}

async function runTask(payloadExtra) {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-proof-run-")))
  // Fails on its first run, then passes; each run writes .runs (an untracked file the task "changed")
  writeFileSync(join(dir, "check.js"), 'const fs = require("node:fs")\nconst n = Number(fs.existsSync(".runs") ? fs.readFileSync(".runs", "utf8") : 0) + 1\nfs.writeFileSync(".runs", String(n))\nif (n < 2) { console.error("PROOF-CHECK: not yet"); process.exit(1) }\nconsole.log("PROOF-CHECK: ok")\n')
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs", scripts: { test: "node check.js" } }))
  writeFileSync(join(dir, "SECRET-CONTENT.txt"), "do-not-upload-this-line\n")
  let builders = 0
  confirmCheck(dir, "npm test")
  const fake = await startFakeKriya({
    approveAfter: 0,
    orchestra: { head: "escalation", worker: "budget" },
    modelNames: { escalation: "Head model (fake)", budget: "Worker model (fake)" },
    chat: (body) => {
      if (!body.tools?.length) return { content: "Title" }
      const first = textOf(body.messages.find((m) => m.role === "user")?.content)
      const results = body.messages.filter((m) => m.role === "tool")
      // The first builder takes longer than one daemon beat (3 s), so a live report lands mid-run
      if (/Do only this step, then stop\./.test(first)) return { content: "Built the step.", ...(!builders++ && { delayMs: 3500 }) }
      if (results.length === 0) return { toolCall: { name: "kriya_plan", args: { goal: "Make the check pass", steps: [{ title: "Pass the check", done_when: "npm test exits 0" }] } } }
      if (results.length === 1) return { toolCall: { name: "kriya_step", args: { step: 1 } } }
      return { content: "Done." }
    },
  })
  fake.state.workforce = true
  assert.equal(await login(fake.url), 0)
  const [project] = offeredProjects([dir])
  const id = fake.queue("run", { project: project.id, prompt: "Make the check pass", mode: "auto", switches: { loopV2: false, budget: true, anchor: false, browser: false }, ...payloadExtra })
  // The daemon's child is a real `kriya run`, with this process's switches
  const saved = { ...process.env }
  Object.assign(process.env, { KRIYA_LOOP_GUARD: "off", KRIYA_STRICT_LOOP: "off", KRIYA_DEFENSIVE: "off", KRIYA_RECON: "off", KRIYA_JIT_TOOLS: "off", KRIYA_ROUTER: "off", KRIYA_BROWSER: "off", KRIYA_GATES: "off", KRIYA_CRITIC: "off", KRIYA_MILESTONES: "off", KRIYA_EXPLORE: "off", KRIYA_CARTRIDGES: "off", KRIYA_MCP: "off", KRIYA_GROUNDING: "off", KRIYA_RUNSTRIP: "off" })
  try {
    await runDaemon({ device: readDevice(), folders: [dir], once: true, log: () => {} })
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  }
  await fake.close()
  return fake.state.reports.filter((r) => r.id === id)
}

test("PR-RUN-01: with proof asked, the report carries the code's verdict, who built each attempt, and changed files without content (real DSH)", { timeout: 300_000 }, async () => {
  const reports = await runTask({ proof: true })
  const last = reports.at(-1)
  const report = JSON.stringify(reports, null, 1).slice(0, 4000)
  assert.equal(last.status, "done", report)
  const { proof } = last.result
  // Exactly what Kriya accepts (contract runProof, lib/harness/contract.ts RunProof)
  assert.deepEqual(violations(contract.runProof, proof), [], report)
  assert.equal(proof.verdict, "verified", report)
  assert.equal(proof.steps.length, 1, report)
  const [step] = proof.steps
  assert.equal(step.title, "Pass the check")
  assert.equal(step.verdict, "pass")
  assert.equal(step.attempts, 2)
  assert.deepEqual(step.builtBy.map((b) => [b.level, b.name]), [["worker", "Worker model (fake)"], ["worker", "Worker model (fake)"]], report)
  // .runs was written by the check; the existing files didn't change
  assert.deepEqual(proof.changes.files.map((f) => [f.path, f.status]), [[".runs", "added"]], report)
  assert.equal(proof.changes.count, 1)
  assert.ok(!JSON.stringify(reports).includes("do-not-upload-this-line"), "no file content leaves")
  // While it ran, Kriya saw the plan as it went
  const live = reports.find((r) => r.status === "running" && r.result?.plan?.length)
  assert.ok(live, report)
  assert.equal(live.result.plan[0].building?.attempt ?? live.result.plan[0].attempts + 1, 1, report)
})

test("PR-RUN-02: without proof, the report is as before: no proof, no changes", { timeout: 300_000 }, async () => {
  const reports = await runTask({})
  const last = reports.at(-1)
  assert.equal(last.status, "done", JSON.stringify(reports).slice(0, 2000))
  assert.equal(last.result.proof, undefined)
  assert.equal(last.result.plan, undefined)
  assert.ok(reports.every((r) => r.status !== "running" || r.result === undefined))
})

test("PR-01: stepsProof: single level without the orchestra; a local worker is marked; nothing without a plan", () => {
  const plan = { goal: "g", steps: [{ title: "One", doneWhen: "x" }] }
  const label = stepLabel(plan, 1)
  const progress = { plan, runs: [{ step: label, status: "pass", gates: [{ id: "G-SECRETS", status: "pass" }, { id: "not a gate", status: "x" }] }], builders: [{ step: label, tier: "local" }] }
  const env = { KRIYA_ORCHESTRA: "on", KRIYA_ORCHESTRA_HEAD: "escalation", KRIYA_MODEL_NAMES: JSON.stringify({ local: "Local · qwen" }) }
  const p = stepsProof(progress, env)
  assert.equal(p.verdict, "verified")
  assert.deepEqual(p.steps[0].builtBy, [{ level: "worker", name: "Local · qwen", local: true }])
  assert.deepEqual(p.steps[0].gates, [{ id: "G-SECRETS", status: "pass" }])
  assert.equal(stepsProof(progress, {}).steps[0].builtBy[0].level, "single")
  assert.equal(stepsProof({ runs: [] }, env), undefined)
})
