import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { ensureProfile } from "../../src/profiles.js"
import { startFakeKriya } from "../fake-kriya.js"
import { freshHome, ROOT } from "../helpers.js"

// Harness 2.0 W0 spikes S1 and S2 on the real, pinned DSH with a scripted
// model (Kriya-Tavi docs/kriya-harness/upgrade_2.0/IMPLEMENTATION_PLAN.md W0).
// A test-only plugin (./spike-plugin) is loaded through the test profile's own
// cordis.patch.yml, the person's layer DSH applies after the bundles; Kriya's
// bundle is untouched. Nothing leaves this machine. Not in `npm test`'s glob:
// run with `node --test tests/workforce/spike-w0.test.js`.

function kriya(args, cwd) {
  return new Promise((done) => {
    const off = { KRIYA_LOOP: "off", KRIYA_BUDGET: "off", KRIYA_LOOP_GUARD: "off", KRIYA_STRICT_LOOP: "off", KRIYA_DEFENSIVE: "off", KRIYA_RECON: "off", KRIYA_JIT_TOOLS: "off", KRIYA_ROUTER: "off", KRIYA_BROWSER: "off" }
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd, env: { ...process.env, ...off } })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000)
    child.on("exit", (code) => {
      clearTimeout(timer)
      done({ code, stdout, stderr })
    })
  })
}

const textOf = (content) => (typeof content === "string" ? content : (content ?? []).map((p) => p?.text ?? "").join("\n"))
const firstUser = (body) => textOf(body.messages?.find((m) => m.role === "user")?.content)
const who = (body) => (firstUser(body).match(/SPIKE-[A-Z0-9-]+/) ?? ["?"])[0]

const SCRIPTS = {
  "SPIKE-HEAD": [
    { name: "spike_delegate", args: { prompt: "SPIKE-S1-CHILD answer in one word", model: "budget" } },
    { name: "spike_delegate", args: { prompt: "SPIKE-S2-MASK answer in one word", deny: "bash" } },
    { name: "spike_delegate", args: { prompt: "SPIKE-S2-NEST delegate twice" } },
  ],
  "SPIKE-S2-NEST": [
    { name: "spike_delegate", args: { prompt: "SPIKE-GRAND-SELF answer", parent: "self" } },
    { name: "spike_delegate", args: { prompt: "SPIKE-GRAND-HEAD answer", parent: "head", model: "budget" } },
  ],
}

test("W0 S1/S2: child tiers, nested spawns and tool masks on the pinned DSH", { timeout: 300_000 }, async () => {
  const home = freshHome()
  const profile = ensureProfile("kriya-run")
  const target = join(profile, "node_modules", "@kriya-ai", "harness-spike-w0")
  mkdirSync(join(profile, "node_modules", "@kriya-ai"), { recursive: true })
  symlinkSync(join(ROOT, "tests", "workforce", "spike-plugin"), target, "dir")
  writeFileSync(join(profile, "cordis.patch.yml"), "- insert:\n    - id: kriya-spike-w0\n      name: '@kriya-ai/harness-spike-w0'\n")

  const calls = []
  const results = {}
  const fake = await startFakeKriya({
    approveAfter: 0,
    chat: (body) => {
      if (!body.tools?.length) return { content: "Spike" }
      const id = who(body)
      const tools = body.tools.map((t) => t.function?.name ?? t.name)
      const toolMessages = body.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content))
      calls.push({ who: id, model: body.model, tools })
      results[id] = toolMessages
      const script = SCRIPTS[id] ?? []
      return toolMessages.length < script.length ? { toolCall: script[toolMessages.length] } : { content: `${id} done` }
    },
  })
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-spike-")))
  mkdirSync(join(dir, ".git"))
  const login = await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)
  assert.equal(login.code, 0, login.stderr)
  const run = await kriya(["run", "--mode", "auto", "SPIKE-HEAD run the spike"], dir)
  await fake.close()

  const report = JSON.stringify({ exit: run.code, home, calls: calls.map((c) => ({ ...c, tools: c.tools.length })), results, stderr: run.stderr.slice(-1500) }, null, 1)
  console.log(report)
  const tiersOf = (id) => [...new Set(calls.filter((c) => c.who === id).map((c) => c.model))]
  const toolsOf = (id) => calls.find((c) => c.who === id)?.tools ?? []

  assert.equal(run.code, 0, report)
  // S1: the head stays on its start tier; the child runs on the alias it was given
  assert.deepEqual(tiersOf("SPIKE-HEAD"), ["balanced"], report)
  assert.deepEqual(tiersOf("SPIKE-S1-CHILD"), ["budget"], report)
  // Without agentOptions a child inherits the parent's tier
  assert.deepEqual(tiersOf("SPIKE-S2-MASK"), ["balanced"], report)
  // S2 mask: the denied tool is gone for the masked child, present for the head
  assert.ok(toolsOf("SPIKE-HEAD").includes("bash"), report)
  assert.ok(!toolsOf("SPIKE-S2-MASK").includes("bash"), report)
  // S2 nesting (found 2026-11-23): a child can't spawn its own child (depth 2 > maxDepth 1),
  // but from inside its tool call it can start one parented to the head, on another tier
  const [self, viaHead] = (results["SPIKE-S2-NEST"] ?? []).map((r) => JSON.parse(r))
  assert.equal(self?.ok, false, report)
  assert.match(self?.error ?? "", /depth 2 exceeds maxDepth 1/, report)
  assert.equal(viaHead?.ok, true, report)
  assert.deepEqual(tiersOf("SPIKE-GRAND-HEAD"), ["budget"], report)
  assert.ok(!calls.some((c) => c.who === "SPIKE-GRAND-SELF"), report)
})
