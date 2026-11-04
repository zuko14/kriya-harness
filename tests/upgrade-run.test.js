import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"

import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// Harness upgrade, end to end on the real pinned DSH (headless `kriya run`)
// with a scripted model: each scenario runs twice, as today ("before") and
// with the upgrade ("after"), so the difference is the harness's alone (same
// model script, task, folder and limits). These are KriyaBench-M, the
// mechanics half of the benchmark (BENCHMARK_PLAN.md in the Kriya
// repository): with KRIYA_MECHANICS_REPORT=<file> the measured numbers are
// written there. Nothing leaves this machine.

const results = []
after(() => {
  if (process.env.KRIYA_MECHANICS_REPORT)
    writeFileSync(process.env.KRIYA_MECHANICS_REPORT, `${JSON.stringify({ suite: "KriyaBench-M", dsh: "0.2.1-rc.5", results }, null, 2)}\n`)
})

function kriya(args, cwd, env = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], {
      cwd,
      env: { ...process.env, KRIYA_LOOP: "off", KRIYA_BUDGET: "off", KRIYA_MAX_STEPS: "", KRIYA_MAX_REPEATS: "", KRIYA_MINIMAL: "", ...env },
    })
    let stderr = ""
    child.stderr.on("data", (d) => (stderr += d))
    child.stdout.resume()
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000)
    child.on("exit", (code) => {
      clearTimeout(timer)
      done({ code, stderr })
    })
  })
}

/** One arm: a fresh home, folder and fake; returns the exit code and the agent's model requests (those offering tools). */
async function arm(script, args, env) {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-upgrade-")))
  mkdirSync(join(dir, ".git"))
  const fake = await startFakeKriya({ approveAfter: 0, models: ["budget"], ...script })
  const login = await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)
  assert.equal(login.code, 0, login.stderr)
  const started = Date.now()
  const run = await kriya(["run", "--mode", "auto", ...args, "Do the task"], dir, env)
  const ms = Date.now() - started
  const chats = fake.state.requests.filter((r) => r.path === "/chat/completions")
  await fake.close()
  return { code: run.code, stderr: run.stderr, ms, agent: chats.filter((r) => r.body?.tools?.length), all: chats }
}

const toolResults = (body) => body.messages.filter((m) => m.role === "tool").length
// DSH's compaction asks the routed model for a checkpoint in its own last message
const compacting = (body) => JSON.stringify(body.messages.at(-1) ?? "").includes("acting as a compaction engine")
const CHECKPOINT = ["Primary Request and Intent", "Key Technical Concepts", "Files and Code", "Errors and Fixes", "Pending Jobs", "Current Work", "Next Step", "Critical Context"]
  .map((h) => `## ${h}\n- ${h === "Current Work" ? "three echo commands ran" : "(none)"}`)
  .join("\n\n")
const bash = (command) => ({ toolCall: { name: "bash", args: { command, description: "Run it" } } })
const record = (scenario, name, r, extra = {}) => {
  results.push({ scenario, arm: name, exitCode: r.code, agentRequests: r.agent.length, modelRequests: r.all.length, ms: r.ms, ...extra })
  return r
}

test("HU-M-01 runaway: a model that never stops is stopped by the turn budget, and the turn isn't 'completed'", { timeout: 600_000 }, async () => {
  // A different command every step, so only a step limit can stop it; the
  // script itself gives up after 30 (the "before" arm's whole run)
  const chat = (body) => (!body.tools?.length ? { content: "Title" } : toolResults(body) < 30 ? bash(`echo step-${toolResults(body)}`) : { content: "Finished." })
  const before = record("runaway", "before", await arm({ chat }, [], {}))
  const afterRun = record("runaway", "after", await arm({ chat }, ["--budget"], { KRIYA_MAX_STEPS: "8" }))
  const report = JSON.stringify({ before: [before.code, before.agent.length], after: [afterRun.code, afterRun.agent.length], stderr: afterRun.stderr.slice(-600) })
  assert.equal(before.code, 0, report)
  assert.equal(before.agent.length, 31, report)
  // 8 steps, then the 9th is refused: the turn ends blocked, kriya run exits 1
  assert.equal(afterRun.code, 1, report)
  assert.equal(afterRun.agent.length, 8, report)
  // Told once, 5 steps before the end, to wrap up
  const warned = afterRun.agent.map((r) => JSON.stringify(r.body.messages).includes("Kriya's turn budget"))
  assert.deepEqual(warned.map((w, i) => (w ? i : -1)).filter((i) => i >= 0)[0], 3, report)
})

test("HU-M-02 stagnation: the same call over and over stops at the repeat limit", { timeout: 600_000 }, async () => {
  const chat = (body) => (!body.tools?.length ? { content: "Title" } : toolResults(body) < 30 ? bash("echo same") : { content: "Finished." })
  const before = record("stagnation", "before", await arm({ chat }, [], {}))
  const afterRun = record("stagnation", "after", await arm({ chat }, ["--budget"], { KRIYA_MAX_REPEATS: "4" }))
  const report = JSON.stringify({ before: [before.code, before.agent.length], after: [afterRun.code, afterRun.agent.length] })
  // DSH alone only reminds (at 3, 5, 8): the loop runs on
  assert.equal(before.agent.length, 31, report)
  assert.equal(afterRun.code, 1, report)
  assert.equal(afterRun.agent.length, 4, report)
})

test("HU-M-03 overflow: a refusal DSH recognises is compacted and retried; the generic one ends the run", { timeout: 600_000 }, async () => {
  // Both arms declare a 32,768-token window (U3), so a real overflow leaves
  // older steps to condense; only the gateway's error code differs
  const big = "x".repeat(3000)
  const script = (code) => {
    let refused = false
    return {
      modelLimits: { budget: { contextWindow: 32768, maxOutputTokens: 16384 } },
      chat(body) {
        if (compacting(body)) return { content: CHECKPOINT }
        if (!body.tools?.length) return { content: "Title" }
        if (toolResults(body) < 3) return bash(`echo ${big}-part-${toolResults(body)}`)
        if (!refused) {
          refused = true
          return { error: { status: 400, error: code, message: "The conversation is longer than the model's context window." } }
        }
        return { content: "Finished after compaction." }
      },
    }
  }
  // Today's gateway sends every provider 400 as bad_request
  const before = record("overflow", "before", await arm(script("bad_request"), [], {}))
  const afterRun = record("overflow", "after", await arm(script("context_length_exceeded"), [], {}))
  const summaries = (r) => r.all.filter((c) => compacting(c.body)).length
  const report = JSON.stringify({ before: [before.code, before.all.length], after: [afterRun.code, afterRun.all.length, summaries(afterRun)], stderr: afterRun.stderr.slice(-800) })
  results.at(-1).summaryRequests = summaries(afterRun)
  assert.equal(before.code, 1, report)
  assert.equal(afterRun.code, 0, report)
  assert.ok(summaries(afterRun) >= 1, report)
  // The retried request is the condensed conversation: DSH's checkpoint stands in for the older steps
  const retried = afterRun.agent.filter((r) => !compacting(r.body)).at(-1)
  assert.match(JSON.stringify(retried.body.messages), /automatically generated checkpoint/, report)
})

test("HU-M-04 limits: a tier's real window and output cap reach the model request", { timeout: 600_000 }, async () => {
  const chat = (body) => (!body.tools?.length ? { content: "Title" } : { content: "Done." })
  const before = record("limits", "before", await arm({ chat }, [], {}))
  const afterRun = record("limits", "after", await arm({ chat, modelLimits: { budget: { contextWindow: 32768, maxOutputTokens: 16384 } } }, [], {}))
  // DSH sends its output cap as max_completion_tokens (the gateway then
  // applies its own cap, KU-ADR-09)
  const cap = (r) => r.agent[0]?.body.max_completion_tokens
  results.at(-2).maxCompletionTokens = cap(before)
  results.at(-1).maxCompletionTokens = cap(afterRun)
  const report = JSON.stringify({ before: cap(before), after: cap(afterRun), stderr: afterRun.stderr.slice(-600) })
  assert.equal(before.code, 0, report)
  assert.equal(afterRun.code, 0, report)
  // A quarter of the 32,768 window, not DSH's 32,768 default
  assert.equal(cap(before), 32768, report)
  assert.equal(cap(afterRun), 8192, report)
})

test("HU-M-09 control arm: KRIYA_MINIMAL=on offers only the shell and the file and search tools", { timeout: 600_000 }, async () => {
  const chat = (body) => (!body.tools?.length ? { content: "Title" } : { content: "Done." })
  const tools = (r) => r.agent[0].body.tools.map((t) => t.function?.name ?? t.name).sort()
  const before = record("minimal", "before", await arm({ chat }, [], {}))
  const afterRun = record("minimal", "after", await arm({ chat }, [], { KRIYA_MINIMAL: "on" }))
  results.at(-2).tools = tools(before).length
  results.at(-2).toolSchemaChars = JSON.stringify(before.agent[0].body.tools).length
  results.at(-1).tools = tools(afterRun).length
  results.at(-1).toolSchemaChars = JSON.stringify(afterRun.agent[0].body.tools).length
  const report = JSON.stringify({ before: tools(before), after: tools(afterRun), stderr: afterRun.stderr.slice(-400) })
  assert.equal(afterRun.code, 0, report)
  assert.deepEqual(tools(afterRun), ["bash", "edit", "glob", "grep", "read", "read_image", "working_directory", "write"], report)
  // Off: the full list, as before
  assert.ok(tools(before).length > 20 && tools(before).includes("subagent") && tools(before).includes("workflow"), report)
})


// Arm B5 (BENCHMARK_PLAN.md): the minimal tool list with the Kriya loop and
// the turn budget. The loop's own tools stay (they're Kriya rows, not DSH's),
// and the verify step still decides from the exit code
test("HU-M-10 arm B5: minimal tools with --loop --budget keep the loop's tools, and a fail → fix → pass cycle works", { timeout: 600_000 }, async () => {
  const { confirmCheck } = await import("../src/verify.js")
  const steps = [
    { name: "kriya_verify", args: { step: "1 the marker" } },
    { name: "bash", args: { command: "echo fixed > fixed.txt", description: "Write the marker" } },
    { name: "kriya_verify", args: { step: "1 the marker" } },
  ]
  const chat = (body) => (!body.tools?.length ? { content: "Title" } : toolResults(body) < steps.length ? { toolCall: steps[toolResults(body)] } : { content: "Checked." })
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-b5-")))
  mkdirSync(join(dir, ".git"))
  writeFileSync(join(dir, "check.js"), 'if (!require("node:fs").existsSync("fixed.txt")) process.exit(1)\n')
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs", scripts: { test: "node check.js" } }))
  confirmCheck(dir, "npm test")
  const fake = await startFakeKriya({ approveAfter: 0, models: ["budget"], chat })
  const login = await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)
  assert.equal(login.code, 0, login.stderr)
  const run = await kriya(["run", "--mode", "auto", "--loop", "--budget", "Make the check pass"], dir, { KRIYA_MINIMAL: "on" })
  const agent = fake.state.requests.filter((r) => r.path === "/chat/completions" && r.body?.tools?.length)
  await fake.close()
  const tools = agent[0].body.tools.map((t) => t.function?.name ?? t.name).sort()
  const results = agent.at(-1).body.messages.filter((m) => m.role === "tool").map((m) => JSON.stringify(m.content))
  const report = JSON.stringify({ exit: run.code, tools, results: results.map((r) => r.slice(0, 120)), stderr: run.stderr.slice(-400) })
  assert.equal(run.code, 0, report)
  assert.deepEqual(tools, ["bash", "edit", "glob", "grep", "kriya_plan", "kriya_step", "kriya_verify", "read", "read_image", "working_directory", "write"], report)
  assert.match(results[0], /fails: `npm test` exited 1/, report)
  assert.match(results[2], /passes: `npm test` exited 0/, report)
})
