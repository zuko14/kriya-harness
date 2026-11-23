import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { confirmCheck } from "../src/verify.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// Harness 2.0 W2 end to end on the real, pinned DSH (headless `kriya run
// --loop --orchestra`), scripted model, fake Kriya offering head escalation
// and worker budget. The project's check fails twice, then passes: attempts 1
// and 2 are built on the worker, attempt 3 on the head; the first builder asks
// kriya_advise, answered by a head-level child that can only read. Without
// --orchestra: one level for everyone and no advice tool. Nothing leaves this machine.

function kriya(args, cwd) {
  return new Promise((done) => {
    const off = { KRIYA_LOOP_GUARD: "off", KRIYA_STRICT_LOOP: "off", KRIYA_DEFENSIVE: "off", KRIYA_RECON: "off", KRIYA_JIT_TOOLS: "off", KRIYA_ROUTER: "off", KRIYA_LOOP: "off", KRIYA_LOOP_V2: "off", KRIYA_BUDGET: "off", KRIYA_ANCHOR: "off", KRIYA_BROWSER: "off", KRIYA_CARTRIDGES: "off", KRIYA_ORCHESTRA: "off" }
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd, env: { ...process.env, ...off } })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGKILL"), 150_000)
    child.on("exit", (code) => {
      clearTimeout(timer)
      done({ code, stdout, stderr })
    })
  })
}

const textOf = (content) => (typeof content === "string" ? content : (content ?? []).map((p) => p?.text ?? "").join("\n"))
const names = (body) => body.tools.map((t) => t.function?.name ?? t.name)

async function runOnce(flags) {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-orc-run-")))
  mkdirSync(join(dir, ".git"))
  // Fails on its first two runs, then passes (a counter outside the agent's view of the task)
  writeFileSync(join(dir, "check.js"), 'const fs = require("node:fs")\nconst n = Number(fs.existsSync(".runs") ? fs.readFileSync(".runs", "utf8") : 0) + 1\nfs.writeFileSync(".runs", String(n))\nif (n < 3) { console.error("ORC-CHECK: not yet, run " + n); process.exit(1) }\nconsole.log("ORC-CHECK: ok")\n')
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs", scripts: { test: "node check.js" } }))
  confirmCheck(dir, "npm test")
  const seen = { head: [], builders: [], advisor: [], advice: [] }
  const fake = await startFakeKriya({
    approveAfter: 0,
    orchestra: { head: "escalation", worker: "budget" },
    chat: (body) => {
      if (!body.tools?.length) return { content: "Title" }
      const first = textOf(body.messages.find((m) => m.role === "user")?.content)
      const results = body.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content))
      if (first.startsWith("You are advising the builder")) {
        seen.advisor.push({ model: body.model, tools: names(body) })
        return { content: "ADVICE-MARKER: look at check.js" }
      }
      if (/Do only this step, then stop\./.test(first)) {
        if (!results.length) seen.builders.push({ model: body.model, tools: names(body) })
        // The first builder asks for advice once, then finishes
        if (seen.builders.length === 1 && !results.length && names(body).includes("kriya_advise")) return { toolCall: { name: "kriya_advise", args: { question: "Why does the check fail?" } } }
        if (results.length) seen.advice.push(results.at(-1))
        return { content: "Built the step." }
      }
      seen.head.push({ model: body.model, tools: names(body) })
      if (results.length === 0) return { toolCall: { name: "kriya_plan", args: { goal: "Make the check pass", steps: [{ title: "Pass the check", done_when: "npm test exits 0" }] } } }
      if (results.length === 1) return { toolCall: { name: "kriya_step", args: { step: 1 } } }
      return { content: "Done." }
    },
  })
  const login = await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)
  assert.equal(login.code, 0, login.stderr)
  const run = await kriya(["run", "--loop", ...flags, "Make the check pass"], dir)
  await fake.close()
  return { run, seen }
}

test("WT-ORC-RUN-01: with --orchestra the session runs on the head, builders on the worker until attempt 3, advice from a read-only head (real DSH)", { timeout: 300_000 }, async () => {
  const { run, seen } = await runOnce(["--orchestra"])
  const report = JSON.stringify({ exit: run.code, head: seen.head.map((h) => h.model), builders: seen.builders.map((b) => b.model), advisor: seen.advisor, advice: seen.advice, stderr: run.stderr.slice(-1000) }, null, 1)
  assert.equal(run.code, 0, report)
  assert.ok(seen.head.length > 0 && seen.head.every((h) => h.model === "escalation"), report)
  assert.deepEqual(seen.builders.map((b) => b.model), ["budget", "budget", "escalation"], report)
  assert.ok(seen.builders[0].tools.includes("kriya_advise"), report)
  assert.equal(seen.advisor.length, 1, report)
  assert.equal(seen.advisor[0].model, "escalation", report)
  for (const writer of ["bash", "write", "edit", "kriya_step", "kriya_plan", "kriya_advise"]) assert.ok(!seen.advisor[0].tools.includes(writer), `${writer}: ${report}`)
  assert.ok(seen.advisor[0].tools.includes("read"), report)
  assert.match(seen.advice[0] ?? "", /ADVICE-MARKER/, report)
})

test("WT-ORC-RUN-02: without --orchestra everyone runs on the session's level and there is no advice tool (real DSH)", { timeout: 300_000 }, async () => {
  const { run, seen } = await runOnce([])
  const report = JSON.stringify({ exit: run.code, head: seen.head.map((h) => h.model), builders: seen.builders.map((b) => b.model), stderr: run.stderr.slice(-1000) }, null, 1)
  assert.equal(run.code, 0, report)
  const levels = new Set([...seen.head, ...seen.builders].map((x) => x.model))
  assert.deepEqual([...levels], ["balanced"], report)
  assert.equal(seen.builders.length, 3, report)
  assert.ok(seen.head.every((h) => !h.tools.includes("kriya_advise")), report)
  assert.equal(seen.advisor.length, 0)
})
