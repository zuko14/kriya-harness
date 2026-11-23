import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { confirmCheck } from "../src/verify.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// Harness 2.0 W3 end to end on the real, pinned DSH, scripted model: with
// --gates, a builder that leaves a key in the code passes the project's check
// but fails G-SECRETS; the next builder gets the gate's finding (never the
// key) and fixes it. A direct kriya_verify gets the same gates, so no path
// marks work passed without them. Off: the same work passes, as before.

function kriya(args, cwd) {
  return new Promise((done) => {
    const off = { KRIYA_LOOP_GUARD: "off", KRIYA_STRICT_LOOP: "off", KRIYA_DEFENSIVE: "off", KRIYA_RECON: "off", KRIYA_JIT_TOOLS: "off", KRIYA_ROUTER: "off", KRIYA_LOOP: "off", KRIYA_LOOP_V2: "off", KRIYA_BUDGET: "off", KRIYA_ANCHOR: "off", KRIYA_BROWSER: "off", KRIYA_CARTRIDGES: "off", KRIYA_ORCHESTRA: "off", KRIYA_GATES: "off" }
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

const KEY = "AKIA" + "LKJHGFDSAPOIUYTR"
const textOf = (content) => (typeof content === "string" ? content : (content ?? []).map((p) => p?.text ?? "").join("\n"))

function project() {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-gates-run-")))
  const git = (...a) => execFileSync("git", a, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "P", GIT_AUTHOR_EMAIL: "p@x", GIT_COMMITTER_NAME: "P", GIT_COMMITTER_EMAIL: "p@x" } })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node -e 0" } }))
  git("init", "-q", "-b", "main")
  git("add", "-A")
  git("commit", "-q", "-m", "base")
  confirmCheck(dir, "npm test")
  return dir
}

test("WT-GATE-RUN-01: with --gates a key left in the code fails G-SECRETS; the next builder is told where and fixes it (real DSH)", { timeout: 300_000 }, async () => {
  const dir = project()
  const builders = []
  const fake = await startFakeKriya({
    approveAfter: 0,
    chat: (body) => {
      if (!body.tools?.length) return { content: "Title" }
      const first = textOf(body.messages.find((m) => m.role === "user")?.content)
      const done = body.messages.filter((m) => m.role === "tool").length
      if (/Do only this step, then stop\./.test(first)) {
        if (!done) builders.push(first)
        if (done) return { content: "Built." }
        const fix = builders.length > 1
        return { toolCall: { name: "bash", args: { command: fix ? "echo 'export const key = process.env.AWS_KEY' > config.js" : `echo 'export const key = "${KEY}"' > config.js`, description: "Write the config" } } }
      }
      if (done === 0) return { toolCall: { name: "kriya_plan", args: { goal: "Add the config", steps: [{ title: "Config file", done_when: "config.js exports key" }] } } }
      if (done === 1) return { toolCall: { name: "kriya_step", args: { step: 1 } } }
      return { content: "Done." }
    },
  })
  assert.equal((await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)).code, 0)
  const run = await kriya(["run", "--loop", "--gates", "Add the config"], dir)
  await fake.close()
  const report = `exit ${run.code}\nbuilders ${builders.length}\nstderr ${run.stderr.slice(-1200)}\nsecond ${String(builders[1]).slice(-900)}`
  assert.equal(run.code, 0, report)
  assert.equal(builders.length, 2, report)
  assert.match(builders[1], /G-SECRETS/, report)
  assert.match(builders[1], /config\.js:1/, report)
  assert.ok(!builders[1].includes(KEY), "the key itself never reaches a prompt")
  assert.doesNotMatch(readFileSync(join(dir, "config.js"), "utf8"), /AKIA/)
})

async function directVerify(flags) {
  const dir = project()
  const results = []
  const fake = await startFakeKriya({
    approveAfter: 0,
    chat: (body) => {
      if (!body.tools?.length) return { content: "Title" }
      const tools = body.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content))
      results.splice(0, results.length, ...tools)
      if (tools.length === 0) return { toolCall: { name: "bash", args: { command: `echo 'export const key = "${KEY}"' > config.js`, description: "Write the config" } } }
      if (tools.length === 1) return { toolCall: { name: "kriya_verify", args: { step: "1 config" } } }
      return { content: "Done." }
    },
  })
  assert.equal((await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)).code, 0)
  const run = await kriya(["run", "--loop", ...flags, "Add the config"], dir)
  await fake.close()
  return { run, verify: results[1] ?? "" }
}

test("WT-GATE-RUN-02: a direct kriya_verify runs the gates too; off, the same work passes as before (real DSH)", { timeout: 300_000 }, async () => {
  const on = await directVerify(["--gates"])
  assert.match(on.verify, /fails/, on.verify)
  assert.match(on.verify, /G-SECRETS/, on.verify)
  assert.ok(!on.verify.includes(KEY))
  const off = await directVerify([])
  assert.match(off.verify, /passes/, off.verify)
  assert.doesNotMatch(off.verify, /G-SECRETS/)
})
