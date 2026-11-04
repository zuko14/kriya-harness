import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { GUIDANCE } from "../plugins/loop/index.js"
import { confirmCheck } from "../src/verify.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// H14a end to end on the real, pinned DSH (headless `kriya run --loop`):
// the fake model verifies (the project's check fails), fixes the cause with
// DSH's own bash tool, verifies again (it passes). Proves DSH loads the
// plugin, runs the confirmed check through its sandboxed shell in the
// session's folder, and that the verdict comes from the exit code. Without
// --loop the model is offered neither the tool nor its guidance. Nothing
// leaves this machine.

function kriya(args, cwd, env = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd, env: { ...process.env, KRIYA_LOOP: "off", ...env } })
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

// A project whose check fails until fixed.txt exists
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-loop-")))
  mkdirSync(join(dir, ".git"))
  writeFileSync(
    join(dir, "check.js"),
    'const { existsSync } = require("node:fs")\nif (!existsSync("fixed.txt")) { console.error("LOOP-CHECK: fixed.txt is missing"); process.exit(1) }\nconsole.log("LOOP-CHECK: ok")\n'
  )
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs", scripts: { test: "node check.js" } }))
  return dir
}

const STEPS = [
  { name: "kriya_verify", args: { step: "1 add the marker" } },
  { name: "bash", args: { command: "echo fixed > fixed.txt", description: "Write the marker the check wants" } },
  { name: "kriya_verify", args: { step: "1 add the marker" } },
]

test("kriya run --loop: a failing check, a fix, a passing check, all from exit codes", { timeout: 300_000 }, async () => {
  const home = freshHome()
  const dir = fixture()
  confirmCheck(dir, "npm test")
  let seen = []
  let tools = []
  const fake = await startFakeKriya({
    approveAfter: 0,
    chat: (body) => {
      if (!body.tools?.length) return { content: "Loop check" }
      seen = body.messages
      tools = body.tools.map((t) => t.function?.name ?? t.name)
      const done = body.messages.filter((m) => m.role === "tool").length
      return done < STEPS.length ? { toolCall: STEPS[done] } : { content: "Finished the loop check." }
    },
  })
  const login = await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)
  assert.equal(login.code, 0, login.stderr)
  const run = await kriya(["run", "--loop", "Make the check pass"], dir)
  await fake.close()
  const results = seen.filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
  const report = `exit ${run.code}\ntools: ${tools.join(",")}\nresults: ${JSON.stringify(results).slice(0, 2000)}\nstderr: ${run.stderr.slice(-800)}`

  assert.equal(run.code, 0, report)
  assert.ok(tools.includes("kriya_verify"), report)
  assert.match(JSON.stringify(seen), /never say tests pass/, report)
  assert.match(results[0], /Step "1 add the marker" fails: `npm test` exited 1\. 3 attempts left\./, report)
  assert.match(results[0], /LOOP-CHECK: fixed\.txt is missing/, report)
  assert.match(results[2], /Step "1 add the marker" passes: `npm test` exited 0\. Session verdict: verified\./, report)
  // Progress is recorded in the Kriya home, not the project
  const progressDir = join(home, "progress")
  const [key] = readdirSync(progressDir)
  const md = readdirSync(join(progressDir, key)).find((f) => f.endsWith(".md"))
  assert.match(readFileSync(join(progressDir, key, md), "utf8"), /Verdict: verified/)
  assert.deepEqual(readdirSync(dir).sort(), [".git", "check.js", "fixed.txt", "package.json"])
})

test("without --loop the agent gets neither kriya_verify nor its guidance (the agent as before)", { timeout: 300_000 }, async () => {
  freshHome()
  const dir = fixture()
  confirmCheck(dir, "npm test")
  let tools = []
  let messages = []
  const fake = await startFakeKriya({
    chat: (body) => {
      if (!body.tools?.length) return { content: "Plain check" }
      tools = body.tools.map((t) => t.function?.name ?? t.name)
      messages = body.messages
      return { content: "Nothing to do." }
    },
  })
  const login = await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)
  assert.equal(login.code, 0, login.stderr)
  const run = await kriya(["run", "Say hello"], dir)
  await fake.close()
  assert.equal(run.code, 0, run.stderr.slice(-800))
  assert.ok(tools.includes("bash"), tools.join(","))
  assert.ok(!tools.includes("kriya_verify"), tools.join(","))
  assert.ok(!JSON.stringify(messages).includes(GUIDANCE.slice(0, 60)))
})

test("kriya run --loop saves a checkpoint before the agent's change, and kriya undo takes it back", { timeout: 300_000 }, async () => {
  const { execFileSync } = await import("node:child_process")
  const home = freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-undo-run-")))
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "P", GIT_AUTHOR_EMAIL: "p@x", GIT_COMMITTER_NAME: "P", GIT_COMMITTER_EMAIL: "p@x" } }).trim()
  git("init", "-q", "-b", "main")
  writeFileSync(join(dir, "app.txt"), "the person's version\n")
  git("add", ".")
  git("commit", "-q", "-m", "one")
  const refs = () => git("for-each-ref", "--format=%(refname) %(objectname)").split("\n").filter((l) => !l.startsWith("refs/kriya/"))
  const before = { refs: refs(), head: git("rev-parse", "HEAD"), index: readFileSync(join(dir, ".git", "index")).toString("base64") }

  const fake = await startFakeKriya({
    approveAfter: 0,
    chat: (body) => {
      if (!body.tools?.length) return { content: "Undo check" }
      const done = body.messages.filter((m) => m.role === "tool").length
      return done === 0
        ? { toolCall: { name: "bash", args: { command: "printf 'the agent broke it\\n' > app.txt", description: "Rewrite app.txt" } } }
        : { content: "Changed app.txt." }
    },
  })
  const login = await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)
  assert.equal(login.code, 0, login.stderr)
  const run = await kriya(["run", "--loop", "Change app.txt"], dir)
  await fake.close()
  assert.equal(run.code, 0, run.stderr.slice(-800))
  assert.equal(readFileSync(join(dir, "app.txt"), "utf8"), "the agent broke it\n")
  assert.match(git("for-each-ref", "refs/kriya/checkpoints"), /refs\/kriya\/checkpoints\/.+\/000001/)

  const undone = await kriya(["undo"], dir)
  assert.equal(undone.code, 0, undone.stdout + undone.stderr)
  assert.match(undone.stdout, /Back to "before bash: Rewrite app\.txt" \(1 file changed\)/)
  assert.equal(readFileSync(join(dir, "app.txt"), "utf8"), "the person's version\n")
  assert.deepEqual({ refs: refs(), head: git("rev-parse", "HEAD"), index: readFileSync(join(dir, ".git", "index")).toString("base64") }, before)
  assert.ok(home)
})

test("kriya run --loop: plan, a fresh builder per attempt, the error handed to the next, pass", { timeout: 300_000 }, async () => {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-plan-run-")))
  mkdirSync(join(dir, ".git"))
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs", scripts: { test: "node check.js" } }))
  writeFileSync(
    join(dir, "check.js"),
    'const fs = require("node:fs")\nconst v = fs.existsSync("value.txt") ? fs.readFileSync("value.txt", "utf8").trim() : "missing"\nif (v !== "right") { console.error(`LOOP: value is ${v}, expected right`); process.exit(1) }\n'
  )
  confirmCheck(dir, "npm test")
  const builderPrompts = []
  let parentResults = []
  const text = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))
  const fake = await startFakeKriya({
    approveAfter: 0,
    chat: (body) => {
      if (!body.tools?.length) return { content: "Plan check" }
      const all = body.messages.map(text).join("\n")
      const done = body.messages.filter((m) => m.role === "tool").length
      if (all.includes("You are building one step")) {
        const prompt = body.messages.filter((m) => m.role === "user").map(text).find((t) => t.includes("You are building one step"))
        if (done === 0) builderPrompts.push(prompt)
        const value = /This is attempt 2/.test(prompt) ? "right" : "wrong"
        return done === 0
          ? { toolCall: { name: "bash", args: { command: `printf ${value} > value.txt`, description: `Write ${value}` } } }
          : { content: `Wrote ${value}.` }
      }
      parentResults = body.messages.filter((m) => m.role === "tool").map(text)
      if (done === 0)
        return { toolCall: { name: "kriya_plan", args: { goal: "Make the value right", steps: [{ title: "Write the value", done_when: "value.txt says right", files: ["value.txt"] }] } } }
      if (done === 1) return { toolCall: { name: "kriya_step", args: { step: 1 } } }
      return { content: "Finished the plan check." }
    },
  })
  const login = await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)
  assert.equal(login.code, 0, login.stderr)
  const run = await kriya(["run", "--loop", "Make the value right"], dir)
  await fake.close()
  const report = `exit ${run.code}\nparent results: ${JSON.stringify(parentResults).slice(0, 2500)}\nbuilders: ${builderPrompts.length}\nstderr: ${run.stderr.slice(-1200)}`
  assert.equal(run.code, 0, report)
  assert.match(parentResults[0], /Plan recorded \(1 step\)/, report)
  assert.match(parentResults[1], /Step 1 \(Write the value\): pass after 2 runs\./, report)
  assert.equal(builderPrompts.length, 2, report)
  assert.doesNotMatch(builderPrompts[0], /previous attempt/)
  assert.match(builderPrompts[1], /LOOP: value is wrong, expected right/, report)
  assert.equal(readFileSync(join(dir, "value.txt"), "utf8"), "right")
})

// The stuck-step fix (2026-11-04): a builder that never stops (here it
// calls bash forever, each time with new arguments) is refused at its step
// limit, the step returns to the parent, and the harness's check still runs
// on the files it left. Before, it ran to the 150-step turn budget, 4 times.
test("kriya run --loop: a builder that never stops is cut off at its limit and still checked", { timeout: 300_000 }, async () => {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-builder-limit-")))
  mkdirSync(join(dir, ".git"))
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs", scripts: { test: "node check.js" } }))
  writeFileSync(join(dir, "check.js"), 'if (!require("node:fs").existsSync("value.txt")) { console.error("LOOP: no value"); process.exit(1) }\n')
  confirmCheck(dir, "npm test")
  let builderCalls = 0
  let parentResults = []
  const text = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))
  const fake = await startFakeKriya({
    approveAfter: 0,
    chat: (body) => {
      if (!body.tools?.length) return { content: "Limit check" }
      const done = body.messages.filter((m) => m.role === "tool").length
      if (body.messages.map(text).join("\n").includes("You are building one step")) {
        builderCalls += 1
        return { toolCall: { name: "bash", args: { command: `printf right > value.txt; echo ${done}`, description: `Polish ${done}` } } }
      }
      parentResults = body.messages.filter((m) => m.role === "tool").map(text)
      if (done === 0) return { toolCall: { name: "kriya_plan", args: { goal: "Write the value", steps: [{ title: "Write the value", done_when: "value.txt exists", files: ["value.txt"] }] } } }
      if (done === 1) return { toolCall: { name: "kriya_step", args: { step: 1 } } }
      return { content: "Reported the step." }
    },
  })
  const login = await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)
  assert.equal(login.code, 0, login.stderr)
  const run = await kriya(["run", "--loop", "Write the value"], dir, { KRIYA_BUILDER_STEPS: "3" })
  await fake.close()
  const report = `exit ${run.code}\nparent results: ${JSON.stringify(parentResults).slice(0, 2500)}\nbuilder calls: ${builderCalls}\nstderr: ${run.stderr.slice(-1200)}`
  assert.equal(run.code, 0, report)
  assert.match(parentResults[1] ?? "", /Step 1 \(Write the value\): pass after 1 run\./, report)
  assert.match(parentResults[1] ?? "", /Builder 1 was stopped at its limit \(3 steps\)/, report)
  assert.ok(builderCalls >= 3 && builderCalls <= 4, report)
})
