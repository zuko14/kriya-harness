import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { listCheckpoints } from "../src/checkpoints.js"
import { listRules } from "../src/rules.js"
import { confirmCheck } from "../src/verify.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// Kriya loop v2 end to end on the real, pinned DSH (headless `kriya run
// --loop-v2`), with a scripted model and a real git repository: the plan
// tool offers `after`; a builder's assertion failure is followed by a worse
// one (a syntax error), which is set aside (the files go back to attempt
// 1's) before a third builder passes; every verdict comes from exit codes.
// Without --loop-v2 the plan tool offers no `after`. Nothing leaves this machine.

function kriya(args, cwd) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd, env: { ...process.env, KRIYA_LOOP: "off", KRIYA_LOOP_V2: "off" } })
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

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-v2-run-")))
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "T")
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs", scripts: { test: "node check.js" } }))
  writeFileSync(join(dir, "check.js"), 'const v = require("./value.js")\nrequire("node:assert").strictEqual(v, "right")\n')
  writeFileSync(join(dir, "value.js"), 'module.exports = "missing"\n')
  git("add", ".")
  git("commit", "-qm", "base")
  return dir
}

// What each builder attempt writes: wrong (assertion), broken (syntax), right
const ATTEMPT = ["module.exports = \\\"wrong\\\"", "module.exports = = 1", "module.exports = \\\"right\\\""]

function script(record) {
  const text = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))
  return (body) => {
    if (!body.tools?.length) return { content: "Plan check" }
    const done = body.messages.filter((m) => m.role === "tool").length
    const prompt = body.messages.filter((m) => m.role === "user").map(text).find((t) => t.includes("You are building one step"))
    if (prompt) {
      const n = Number(/This is attempt (\d)/.exec(prompt)?.[1] ?? 1)
      if (done === 0) record.builders.push({ n, prompt })
      return done === 0 ? { toolCall: { name: "bash", args: { command: `printf '%s\\n' "${ATTEMPT[n - 1]}" > value.js`, description: `Attempt ${n}` } } } : { content: `Attempt ${n} written.` }
    }
    record.planTool = body.tools.find((t) => (t.function?.name ?? t.name) === "kriya_plan")
    record.results = body.messages.filter((m) => m.role === "tool").map(text)
    if (done === 0)
      return { toolCall: { name: "kriya_plan", args: { goal: "Make the value right", steps: [{ title: "Write the value", done_when: "check.js passes", files: ["value.js"], after: [] }] } } }
    if (done === 1) return { toolCall: { name: "kriya_step", args: { step: 1 } } }
    return { content: "Finished." }
  }
}

test("KV2-RUN-01: kriya run --loop-v2 sets a worse attempt aside and passes from the best files", { timeout: 300_000 }, async () => {
  freshHome()
  const dir = fixture()
  confirmCheck(dir, "npm test")
  const record = { builders: [], results: [] }
  const fake = await startFakeKriya({ approveAfter: 0, chat: script(record) })
  const login = await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)
  assert.equal(login.code, 0, login.stderr)
  const run = await kriya(["run", "--loop", "--loop-v2", "Make the value right"], dir)
  await fake.close()
  const report = `exit ${run.code}\nresults: ${JSON.stringify(record.results).slice(0, 3000)}\nbuilders: ${record.builders.map((b) => b.n)}\nstderr: ${run.stderr.slice(-1500)}`
  assert.equal(run.code, 0, report)
  assert.match(JSON.stringify(record.planTool), /"after"/, report)
  assert.match(record.results[1], /Step 1 \(Write the value\): pass after 3 runs\./, report)
  assert.match(record.results[1], /1 attempt was set aside/, report)
  assert.deepEqual(
    record.builders.map((b) => b.n),
    [1, 2, 3],
    report
  )
  assert.match(record.builders[1].prompt, /failure class: assertion/, report)
  assert.match(record.builders[2].prompt, /failed further from passing \(syntax\) than attempt 1/, report)
  assert.match(record.builders[2].prompt, /AssertionError/, report)
  assert.equal(readFileSync(join(dir, "value.js"), "utf8"), 'module.exports = "right"\n')
  // The set-aside attempt is kept, not lost
  assert.ok((await listCheckpoints(dir)).some((c) => c.kind === "undone" && /back to attempt 1 of step 1/.test(c.label)), report)
  // Two different failures: nothing seen twice, nothing proposed
  assert.deepEqual(listRules(dir).proposed, [])
})

test("KV2-RUN-02: without --loop-v2 the plan tool is v1's (no after)", { timeout: 300_000 }, async () => {
  freshHome()
  const dir = fixture()
  confirmCheck(dir, "npm test")
  const record = { builders: [], results: [] }
  const chat = script(record)
  const fake = await startFakeKriya({ approveAfter: 0, chat: (body) => (body.tools?.length ? ((record.planTool = body.tools.find((t) => (t.function?.name ?? t.name) === "kriya_plan")), { content: "Done." }) : chat(body)) })
  const login = await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)
  assert.equal(login.code, 0, login.stderr)
  const run = await kriya(["run", "--loop", "Say done"], dir)
  await fake.close()
  assert.equal(run.code, 0, run.stderr.slice(-1500))
  assert.ok(record.planTool, "the loop's plan tool is offered")
  assert.doesNotMatch(JSON.stringify(record.planTool), /"after"/)
})
