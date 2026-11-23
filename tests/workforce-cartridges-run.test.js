import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { confirmCheck } from "../src/verify.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// Harness 2.0 W1 end to end on the real, pinned DSH (headless `kriya run
// --loop`), scripted model, fake Kriya serving one cartridge: with
// --cartridges the plan tool offers `role`, and the step's builder gets the
// database cartridge first in its prompt; without it, the plan tool and the
// builder's prompt are as before. Nothing leaves this machine.

function kriya(args, cwd) {
  return new Promise((done) => {
    const off = { KRIYA_LOOP_GUARD: "off", KRIYA_STRICT_LOOP: "off", KRIYA_DEFENSIVE: "off", KRIYA_RECON: "off", KRIYA_JIT_TOOLS: "off", KRIYA_ROUTER: "off", KRIYA_LOOP: "off", KRIYA_LOOP_V2: "off", KRIYA_BUDGET: "off", KRIYA_ANCHOR: "off", KRIYA_BROWSER: "off", KRIYA_CARTRIDGES: "off" }
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd, env: { ...process.env, ...off } })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000)
    child.on("exit", (code) => {
      clearTimeout(timer)
      done({ code, stdout, stderr })
    })
  })
}

const CARTRIDGE = {
  id: "kriya-role-database",
  name: "Database engineer",
  version: "1.0.0",
  description: "Role cartridge for schema and migration steps.",
  activation: { always: false, keywords: ["database"] },
  cartridge: { role: "database", owns: ["schema"], reads: [], gates: ["G-STACK"], detectors: [], judgement: [], maxPromptChars: 4000, globs: ["**/*.sql"] },
  invocation: { modelInvocable: false },
}
// A positive control: an ordinary Kriya skill, which the model's catalogue does list
const PLAIN = { id: "kriya-verify", name: "Verify", version: "1.0.0", description: "Verify before claiming done.", activation: { always: false, keywords: ["verify"] } }
const BODY = "# Database: constraints in the database\n\nRLS-MARKER on every tenant table."

const textOf = (content) => (typeof content === "string" ? content : (content ?? []).map((p) => p?.text ?? "").join("\n"))

async function runOnce(flags) {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-cart-run-")))
  mkdirSync(join(dir, ".git"))
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node -e 0" } }))
  confirmCheck(dir, "npm test")
  const seen = { planTool: null, builderPrompt: null, headRequest: "" }
  const fake = await startFakeKriya({
    approveAfter: 0,
    chat: (body) => {
      if (!body.tools?.length) return { content: "Title" }
      const first = textOf(body.messages.find((m) => m.role === "user")?.content)
      // A step's builder: its prompt is the builder prompt
      if (/Do only this step, then stop\./.test(first)) {
        seen.builderPrompt ??= first
        return { content: "Built the step." }
      }
      seen.planTool ??= body.tools.find((t) => (t.function?.name ?? t.name) === "kriya_plan")
      seen.headRequest ||= JSON.stringify({ messages: body.messages, tools: body.tools })
      const done = body.messages.filter((m) => m.role === "tool").length
      if (done === 0) return { toolCall: { name: "kriya_plan", args: { goal: "Add the orders table", steps: [{ title: "Orders table", done_when: "the check passes", files: ["db/001_orders.sql"], ...(flags.includes("--cartridges") && { role: "database" }) }] } } }
      if (done === 1) return { toolCall: { name: "kriya_step", args: { step: 1 } } }
      return { content: "Done." }
    },
  })
  fake.state.skills = [CARTRIDGE, PLAIN]
  fake.state.skillBodies = new Map([["kriya-role-database", BODY], ["kriya-verify", "# Verify\n\nCheck first."]])
  const login = await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)
  assert.equal(login.code, 0, login.stderr)
  const run = await kriya(["run", "--loop", ...flags, "Add the orders table"], dir)
  await fake.close()
  return { run, ...seen }
}

test("WT-CAR-RUN-01: --cartridges offers role in kriya_plan and mounts the cartridge first in the builder's prompt (real DSH)", { timeout: 300_000 }, async () => {
  const { run, planTool, builderPrompt } = await runOnce(["--cartridges"])
  const report = `exit ${run.code}\nstderr: ${run.stderr.slice(-1200)}\nprompt: ${String(builderPrompt).slice(0, 400)}`
  assert.equal(run.code, 0, report)
  const step = (planTool?.function?.parameters ?? planTool?.parameters)?.properties?.steps?.items
  assert.ok(step?.properties?.role?.enum?.includes("database"), JSON.stringify(step).slice(0, 600))
  assert.ok(builderPrompt?.startsWith("Your role for this step: Database engineer."), report)
  assert.match(builderPrompt, /RLS-MARKER/)
})

test("WT-CAR-RUN-03: a cartridge never appears in the model's own skill catalogue; an ordinary Kriya skill does (real DSH)", { timeout: 300_000 }, async () => {
  const { run, headRequest } = await runOnce(["--cartridges"])
  assert.equal(run.code, 0, run.stderr.slice(-1200))
  assert.match(headRequest, /kriya-verify/)
  assert.doesNotMatch(headRequest, /kriya-role-database/)
})

test("WT-CAR-RUN-02: without --cartridges the plan tool has no role and the builder's prompt is as before (real DSH)", { timeout: 300_000 }, async () => {
  const { run, planTool, builderPrompt } = await runOnce([])
  const report = `exit ${run.code}\nstderr: ${run.stderr.slice(-1200)}`
  assert.equal(run.code, 0, report)
  const step = (planTool?.function?.parameters ?? planTool?.parameters)?.properties?.steps?.items
  assert.equal(step?.properties?.role, undefined, JSON.stringify(step).slice(0, 600))
  assert.ok(builderPrompt?.startsWith("You are building one step of a larger task."), report)
  assert.doesNotMatch(builderPrompt, /RLS-MARKER/)
})
