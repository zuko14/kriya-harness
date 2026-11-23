import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { confirmCheck } from "../src/verify.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// Harness 2.0 W6 end to end on the real, pinned DSH, scripted model: with
// --critic, after a step passes, a real read-only child reviews it and
// answers one major defect as JSON; one polish builder follows. A polish that
// keeps the check green is kept; one that breaks it is put back to the
// passing files (the repository's checkpoint code), checked again, and the
// step still passes. Nothing leaves this machine.

function kriya(args, cwd) {
  return new Promise((done) => {
    const off = { KRIYA_LOOP_GUARD: "off", KRIYA_STRICT_LOOP: "off", KRIYA_DEFENSIVE: "off", KRIYA_RECON: "off", KRIYA_JIT_TOOLS: "off", KRIYA_ROUTER: "off", KRIYA_LOOP: "off", KRIYA_LOOP_V2: "off", KRIYA_BUDGET: "off", KRIYA_ANCHOR: "off", KRIYA_BROWSER: "off", KRIYA_CARTRIDGES: "off", KRIYA_ORCHESTRA: "off", KRIYA_GATES: "off", KRIYA_CRITIC: "off" }
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd, env: { ...process.env, ...off } })
    let stderr = ""
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGKILL"), 150_000)
    child.on("exit", (code) => {
      clearTimeout(timer)
      done({ code, stderr })
    })
  })
}
const textOf = (content) => (typeof content === "string" ? content : (content ?? []).map((p) => p?.text ?? "").join("\n"))
const names = (body) => body.tools.map((t) => t.function?.name ?? t.name)

async function runOnce(polishBreaks) {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-cri-run-")))
  writeFileSync(join(dir, "check.js"), 'const fs = require("node:fs")\nif (fs.existsSync("broken.txt")) { console.error("CRI-CHECK: broken"); process.exit(1) }\nconsole.log("CRI-CHECK: ok")\n')
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs", scripts: { test: "node check.js" } }))
  const git = (...a) => execFileSync("git", a, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "P", GIT_AUTHOR_EMAIL: "p@x", GIT_COMMITTER_NAME: "P", GIT_COMMITTER_EMAIL: "p@x" } })
  git("init", "-q", "-b", "main")
  git("add", "-A")
  git("commit", "-q", "-m", "base")
  confirmCheck(dir, "npm test")
  const seen = { critic: [], polish: [], builders: 0 }
  const fake = await startFakeKriya({
    approveAfter: 0,
    chat: (body) => {
      if (!body.tools?.length) return { content: "Title" }
      const first = textOf(body.messages.find((m) => m.role === "user")?.content)
      const done = body.messages.filter((m) => m.role === "tool").length
      if (first.startsWith("You are reviewing one finished step")) {
        seen.critic.push({ tools: names(body), prompt: first })
        return { content: JSON.stringify({ defects: [{ id: "next-step", severity: "major", where: "page.txt", fix: "Say what to do next on the empty page" }] }) }
      }
      if (/Do only this step, then stop\./.test(first)) {
        const polishing = /found these major defects/.test(first)
        if (!done) {
          seen.builders++
          if (polishing) seen.polish.push(first)
        }
        if (done) return { content: "Built." }
        const command = !polishing ? "echo 'Orders' > page.txt" : polishBreaks ? "echo 'Orders, polished' > page.txt && echo x > broken.txt" : "echo 'Orders. Nothing yet: add your first order.' > page.txt"
        return { toolCall: { name: "bash", args: { command, description: "Write the page" } } }
      }
      if (done === 0) return { toolCall: { name: "kriya_plan", args: { goal: "Orders page", steps: [{ title: "Orders page", done_when: "page.txt exists" }] } } }
      if (done === 1) return { toolCall: { name: "kriya_step", args: { step: 1 } } }
      return { content: "Done." }
    },
  })
  try {
    assert.equal((await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)).code, 0)
    const run = await kriya(["run", "--loop", "--critic", "Make the orders page"], dir)
    return { run, seen, dir }
  } finally {
    await fake.close()
  }
}

test("WT-CRI-RUN-01: a real reviewer's major defect earns one polish, kept when the check stays green (real DSH)", { timeout: 300_000 }, async () => {
  const { run, seen, dir } = await runOnce(false)
  const report = `exit ${run.code}\n${JSON.stringify({ builders: seen.builders, critic: seen.critic.map((c) => c.tools.length) })}\n${run.stderr.slice(-1000)}`
  assert.equal(run.code, 0, report)
  assert.equal(seen.critic.length, 1, report)
  for (const writer of ["bash", "write", "edit", "kriya_step", "kriya_plan"]) assert.ok(!seen.critic[0].tools.includes(writer), `${writer} ${report}`)
  assert.equal(seen.builders, 2, report)
  assert.match(seen.polish[0], /- page\.txt: Say what to do next on the empty page/)
  assert.match(readFileSync(join(dir, "page.txt"), "utf8"), /add your first order/)
})

test("WT-CRI-RUN-02: a polish that breaks the check is put back to the passing files and the step still passes (real DSH)", { timeout: 300_000 }, async () => {
  const { run, seen, dir } = await runOnce(true)
  const report = `exit ${run.code}\nbuilders ${seen.builders}\n${run.stderr.slice(-1000)}`
  assert.equal(run.code, 0, report)
  assert.equal(seen.builders, 2, report)
  assert.equal(readFileSync(join(dir, "page.txt"), "utf8").trim(), "Orders", "the passing version is back")
  assert.ok(!existsSync(join(dir, "broken.txt")), "the polish's breaking file is gone")
})
