import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { RECHECK } from "../plugins/loop/index.js"
import { confirmCheck, currentVerdict } from "../src/verify.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// Harness upgrade U7: long-horizon drills on the real pinned DSH with a
// scripted model (KriyaBench-M, BENCHMARK_PLAN.md): a crash mid-turn and a
// resume, what survives a compaction, and a connection cut in the middle of
// a tool call. They measure what the kernel and Kriya's composition do
// today; nothing leaves this machine.

/** Starts `kriya` in its own process group, so a "crash" kills DSH too. */
function start(args, cwd) {
  const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], {
    cwd,
    detached: true,
    env: { ...process.env, KRIYA_LOOP_GUARD: "off", KRIYA_STRICT_LOOP: "off", KRIYA_DEFENSIVE: "off", KRIYA_RECON: "off", KRIYA_JIT_TOOLS: "off", KRIYA_ROUTER: "off", KRIYA_LOOP: "off", KRIYA_BUDGET: "off", KRIYA_ANCHOR: "off", KRIYA_MINIMAL: "" },
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (d) => (stdout += d))
  child.stderr.on("data", (d) => (stderr += d))
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => process.kill(-child.pid, "SIGKILL"), 240_000)
    child.on("exit", (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
  return { child, done, out: () => stdout }
}

const run = (args, cwd) => start(args, cwd).done
const toolResults = (body) => body.messages.filter((m) => m.role === "tool").length
const bash = (command) => ({ toolCall: { name: "bash", args: { command, description: "Run it" } } })
const compacting = (body) => JSON.stringify(body.messages.at(-1) ?? "").includes("acting as a compaction engine")
const has = (body, text) => JSON.stringify(body.messages).includes(text)
const until = async (ok, ms = 60_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (ok()) return
  throw new Error("timed out waiting")
}

async function project(script) {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-drill-")))
  mkdirSync(join(dir, ".git"))
  const fake = await startFakeKriya({ approveAfter: 0, models: ["budget"], ...script })
  const login = await run(["login", "--url", fake.url, "--no-browser"], ROOT)
  assert.equal(login.code, 0, login.stderr)
  const agent = () => fake.state.requests.filter((r) => r.path === "/chat/completions" && r.body?.tools?.length)
  return { dir, fake, agent }
}

test("HU-M-05 crash and resume: kill the process mid-tool, resume the session, the work so far is there and the turn finishes", { timeout: 600_000 }, async () => {
  const { dir, fake, agent } = await project({
    chat(body) {
      if (!body.tools?.length) return { content: "Title" }
      if (has(body, "RESUME-7731")) return { content: "Resumed and finished." }
      if (toolResults(body) === 0) return bash("echo part-0 done")
      return bash("sleep 30")
    },
  })
  const first = start(["run", "--mode", "auto", "--json", "Do the task in two parts"], dir)
  // The crash: while `sleep 30` runs, the whole process group dies
  await until(() => agent().length >= 2)
  await new Promise((r) => setTimeout(r, 1500))
  process.kill(-first.child.pid, "SIGKILL")
  const crashed = await first.done
  const opening = crashed.stdout
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .find((e) => e?.type === "session")
  const sessionId = opening?.sessionId ?? opening?.id
  assert.ok(sessionId, `no session event: ${crashed.stdout.slice(0, 400)}`)

  const resumed = await run(["run", "--mode", "auto", "--session-id", String(sessionId), "RESUME-7731 carry on"], dir)
  const last = agent().at(-1)
  const report = JSON.stringify({ signal: crashed.signal, sessionId, resumed: resumed.code, stderr: resumed.stderr.slice(-600), roles: last?.body.messages.map((m) => m.role[0]).join("") })
  await fake.close()
  assert.equal(crashed.signal, "SIGKILL", report)
  assert.equal(resumed.code, 0, report)
  // The resumed request carries the first run's finished tool result
  assert.ok(has(last.body, "part-0 done"), report)
  console.log(`HU-M-05 ${report}`)
})

// Before: the person's request survives a compaction only as well as the
// model's summary keeps it. After (--anchor): word for word, whatever the summary says
test("HU-M-06 compaction fidelity: a requirement the checkpoint forgets survives only with --anchor", { timeout: 600_000 }, async () => {
  const arm = async (flags) => {
    const big = "x".repeat(3000)
    let refused = false
    const { dir, fake, agent } = await project({
      modelLimits: { budget: { contextWindow: 32768, maxOutputTokens: 16384 } },
      chat(body) {
        // A weak summariser: the requirement left out
        if (compacting(body)) return { content: "## Primary Request and Intent\n- do the task\n\n## Current Work\n- echo commands ran" }
        if (!body.tools?.length) return { content: "Title" }
        if (toolResults(body) < 3) return bash(`echo ${big}-${toolResults(body)}`)
        if (!refused) {
          refused = true
          return { error: { status: 400, error: "context_length_exceeded", message: "The conversation is longer than the model's context window." } }
        }
        return { content: "Finished." }
      },
    })
    const result = await run(["run", "--mode", "auto", ...flags, "Do the task. REQUIREMENT-7731: the output file must be named out-7731.txt."], dir)
    const summary = fake.state.requests.find((r) => r.path === "/chat/completions" && compacting(r.body))
    const retried = agent().filter((r) => !compacting(r.body)).at(-1)
    await fake.close()
    return { exit: result.code, compacted: !!summary, summarizerSaw: !!summary && has(summary.body, "REQUIREMENT-7731"), keptAfter: !!retried && has(retried.body, "REQUIREMENT-7731") }
  }
  const before = await arm([])
  const after = await arm(["--anchor"])
  const report = JSON.stringify({ before, after })
  console.log(`HU-M-06 ${report}`)
  for (const r of [before, after]) {
    assert.equal(r.exit, 0, report)
    assert.ok(r.compacted && r.summarizerSaw, report)
  }
  assert.equal(before.keptAfter, false, report)
  assert.equal(after.keptAfter, true, report)
})

test("HU-M-07 connection cut mid tool call: retried, and the tool runs exactly once", { timeout: 600_000 }, async () => {
  let cut = false
  const { dir, fake, agent } = await project({
    chat(body) {
      if (!body.tools?.length) return { content: "Title" }
      if (toolResults(body) === 0) {
        if (!cut) {
          cut = true
          return { cut: { name: "bash", args: { command: "echo ran >> count.txt", description: "Count runs" } } }
        }
        return bash("echo ran >> count.txt")
      }
      return { content: "Done." }
    },
  })
  const result = await run(["run", "--mode", "auto", "Count once"], dir)
  const lines = existsSync(join(dir, "count.txt")) ? readFileSync(join(dir, "count.txt"), "utf8").trim().split("\n").length : 0
  const report = JSON.stringify({ exit: result.code, runs: lines, requests: agent().length, stderr: result.stderr.slice(-600) })
  await fake.close()
  assert.equal(result.code, 0, report)
  assert.equal(lines, 1, report)
  console.log(`HU-M-07 ${report}`)
})

// U8 (HU-M-08): the agent passes the check, changes another file, and tries
// to finish. The loop sees the pass no longer covers the files and sends the
// agent back once; it checks again and the session ends verified for the
// files as they are
test("HU-M-08 stale pass: a change after the last passing check is sent back to be checked again", { timeout: 600_000 }, async () => {
  const { dir, fake } = await project({
    chat(body) {
      if (!body.tools?.length) return { content: "Title" }
      const n = toolResults(body)
      if (n === 0) return bash("echo fixed > fixed.txt")
      if (n === 1) return { toolCall: { name: "kriya_verify", args: { step: "1 the fix" } } }
      if (n === 2) return bash("echo later > notes.txt")
      if (n === 3) return has(body, "kriya_verify again before you finish") ? { toolCall: { name: "kriya_verify", args: { step: "1 the fix" } } } : { content: "All done." }
      return { content: "Done, and checked again." }
    },
  })
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" })
  // A real repository this time (the fingerprint needs git)
  execFileSync("rm", ["-rf", join(dir, ".git")])
  git("init", "-q")
  writeFileSync(join(dir, "check.js"), 'if (!require("node:fs").existsSync("fixed.txt")) process.exit(1)\n')
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs", scripts: { test: "node check.js" } }))
  confirmCheck(dir, "npm test")
  const result = await run(["run", "--mode", "auto", "--loop", "--json", "Make the check pass"], dir)
  const sessionId = result.stdout
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .find((e) => e?.type === "session")?.sessionId
  const agentRequests = fake.state.requests.filter((r) => r.path === "/chat/completions" && r.body?.tools?.length)
  const sentBack = agentRequests.some((r) => has(r.body, RECHECK.slice(0, 40)))
  const verifies = agentRequests.at(-1).body.messages.filter((m) => m.role === "tool" && JSON.stringify(m.content).includes("passes")).length
  const session = await currentVerdict(dir, String(sessionId))
  const report = JSON.stringify({ exit: result.code, sessionId, sentBack, verifies, verdict: session, stderr: result.stderr.slice(-500) })
  await fake.close()
  console.log(`HU-M-08 ${report}`)
  assert.equal(result.code, 0, report)
  assert.ok(sentBack, report)
  assert.equal(verifies, 2, report)
  assert.equal(session.status, "verified", report)
})
