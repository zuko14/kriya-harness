import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { browserTarget } from "../src/browser.js"
import { useStack } from "../src/stack.js"
import { confirmCheck } from "../src/verify.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// Harness 2.0 W4 end to end on the real, pinned DSH, scripted model, real
// Chrome: a frontend step (the fake Kriya serves the frontend cartridge) whose page scrolls sideways at 360 px passes the
// project's check but fails G-UI; the next builder is told where and fixes
// the page; the step passes. The app is a local server serving the project's
// own index.html, confirmed with kriya stack use. Nothing leaves this machine.

function kriya(args, cwd) {
  return new Promise((done) => {
    const off = { KRIYA_LOOP_GUARD: "off", KRIYA_STRICT_LOOP: "off", KRIYA_DEFENSIVE: "off", KRIYA_RECON: "off", KRIYA_JIT_TOOLS: "off", KRIYA_ROUTER: "off", KRIYA_LOOP: "off", KRIYA_LOOP_V2: "off", KRIYA_BUDGET: "off", KRIYA_ANCHOR: "off", KRIYA_BROWSER: "off", KRIYA_CARTRIDGES: "off", KRIYA_ORCHESTRA: "off", KRIYA_GATES: "off" }
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd, env: { ...process.env, ...off } })
    let stderr = ""
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGKILL"), 200_000)
    child.on("exit", (code) => {
      clearTimeout(timer)
      done({ code, stderr })
    })
  })
}

const FRONTEND = {
  id: "kriya-role-frontend",
  name: "Frontend engineer",
  version: "1.0.0",
  description: "Role cartridge for frontend steps.",
  activation: { always: false, keywords: ["frontend"] },
  cartridge: { role: "frontend", owns: [], reads: [], gates: ["G-UI", "G-A11Y", "G-DETECT"], detectors: [], judgement: [], maxPromptChars: 4000, globs: ["**/*.html"] },
  invocation: { modelInvocable: false },
}
const textOf = (content) => (typeof content === "string" ? content : (content ?? []).map((p) => p?.text ?? "").join("\n"))
const WIDE = '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>Orders</h1><div style="width:1200px">table</div></body></html>'
const FIXED = '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>Orders</h1><div style="max-width:100%;overflow-x:auto">table</div></body></html>'

test("WT-GATE-UI-RUN-01: a page that scrolls sideways at 360 px fails G-UI; the next builder fixes it (real DSH, real Chrome)", { timeout: 400_000, skip: !browserTarget() && "no Chrome on this computer" }, async () => {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-ui-run-")))
  const git = (...a) => execFileSync("git", a, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "P", GIT_AUTHOR_EMAIL: "p@x", GIT_COMMITTER_NAME: "P", GIT_COMMITTER_EMAIL: "p@x" } })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node -e 0" } }))
  git("init", "-q", "-b", "main")
  git("add", "-A")
  git("commit", "-q", "-m", "base")
  confirmCheck(dir, "npm test")
  const app = createServer((req, res) => {
    const file = join(dir, "index.html")
    if (req.url !== "/" || !existsSync(file)) return res.writeHead(404).end()
    res.writeHead(200, { "content-type": "text/html" }).end(readFileSync(file))
  })
  await new Promise((done) => app.listen(0, "127.0.0.1", done))
  useStack(dir, { app: `http://127.0.0.1:${app.address().port}` })
  const pages = mkdtempSync(join(tmpdir(), "kriya-ui-run-pages-"))
  writeFileSync(join(pages, "wide.html"), WIDE)
  writeFileSync(join(pages, "fixed.html"), FIXED)
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
        const source = join(pages, builders.length > 1 ? "fixed.html" : "wide.html")
        return { toolCall: { name: "bash", args: { command: `cp '${source}' index.html`, description: "Write the page" } } }
      }
      if (done === 0) return { toolCall: { name: "kriya_plan", args: { goal: "Orders page", steps: [{ title: "Orders page", done_when: "index.html shows the orders", files: ["index.html"], role: "frontend" }] } } }
      if (done === 1) return { toolCall: { name: "kriya_step", args: { step: 1 } } }
      return { content: "Done." }
    },
  })
  fake.state.skills = [FRONTEND]
  fake.state.skillBodies = new Map([["kriya-role-frontend", "# Frontend\n\nEvery screen holds at 360 px."]])
  try {
    assert.equal((await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)).code, 0)
    const run = await kriya(["run", "--loop", "--cartridges", "--gates", "Make the orders page"], dir)
    const report = `exit ${run.code}\nbuilders ${builders.length}\nstderr ${run.stderr.slice(-1200)}\nsecond ${String(builders[1]).slice(-1200)}`
    assert.equal(run.code, 0, report)
    assert.equal(builders.length, 2, report)
    assert.match(builders[1], /G-UI/, report)
    assert.match(builders[1], /\/ at 360px (light|dark): the page scrolls sideways/, report)
    assert.match(readFileSync(join(dir, "index.html"), "utf8"), /max-width:100%/)
  } finally {
    await fake.close()
    app.close()
  }
})
