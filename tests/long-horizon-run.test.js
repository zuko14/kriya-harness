import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { confirmCheck } from "../src/verify.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// HU-M-11 long horizon on a small window, on the real pinned DSH with a
// scripted model (KriyaBench-M): a four-step plan run with kriya_step on a
// 32k-token window, a context overflow in the middle, and a compaction
// whose summary forgets the plan. With --loop-v2 the agent's next request
// still says where the task stands (goal, each step, the next step); without
// it, only the summary does. The task finishes either way here, because the
// scripted model doesn't need memory: what this measures is what a real
// model would be shown. Nothing leaves this machine.

function kriya(args, cwd) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd, env: { ...process.env, KRIYA_LOOP: "on", KRIYA_LOOP_V2: "off", KRIYA_BUDGET: "off", KRIYA_ANCHOR: "off" } })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000)
    child.on("exit", (code) => {
      clearTimeout(timer)
      done({ code, stdout, stderr })
    })
  })
}

const text = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))
const compacting = (body) => JSON.stringify(body.messages.at(-1) ?? "").includes("acting as a compaction engine")
const has = (body, needle) => JSON.stringify(body.messages).includes(needle)
const FILES = ["a", "b", "c", "d"]
const BIG = "x".repeat(3000)

async function arm(flags) {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-long-")))
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs", scripts: { test: "node check.js" } }))
  // Every part file there is says ok, and there is at least one
  writeFileSync(join(dir, "check.js"), 'const fs=require("node:fs");const f=fs.readdirSync(".").filter(n=>/^part-[a-d]\\.txt$/.test(n));if(!f.length||f.some(n=>fs.readFileSync(n,"utf8").trim()!=="ok")){console.error("AssertionError: parts not ok");process.exit(1)}\n')
  git("add", ".")
  git("commit", "-qm", "base")
  confirmCheck(dir, "npm test")

  const plan = { goal: "Write the four part files, each checked by npm test", steps: FILES.map((f, i) => ({ title: `Write part ${f}`, done_when: `part-${f}.txt says ok`, files: [`part-${f}.txt`], ...(flags.includes("--loop-v2") && { after: i ? [i] : [] }) })) }
  const actions = [{ toolCall: { name: "kriya_plan", args: plan } }, ...FILES.map((_, i) => ({ toolCall: { name: "kriya_step", args: { step: i + 1 } } })), { content: "All four steps pass." }]
  let issued = 0
  let overflowed = false
  const seen = { compactions: 0, afterCompaction: null }
  const fake = await startFakeKriya({
    approveAfter: 0,
    models: ["budget"],
    modelLimits: { budget: { contextWindow: 32768, maxOutputTokens: 8192 } },
    chat: (body) => {
      // A weak summary: the plan and its progress are left out
      if (compacting(body)) {
        seen.compactions++
        return { content: "## Primary Request and Intent\n- write some files\n\n## Current Work\n- some steps ran" }
      }
      if (!body.tools?.length) return { content: "Long task" }
      const builder = body.messages.filter((m) => m.role === "user").map(text).find((t) => t.includes("You are building one step"))
      if (builder) {
        const n = Number(/Your step: (\d)/.exec(builder)[1])
        const done = body.messages.filter((m) => m.role === "tool").length
        if (done === 0) return { toolCall: { name: "bash", args: { command: `printf ok > part-${FILES[n - 1]}.txt && echo ${BIG}`, description: `Write part ${FILES[n - 1]}` } } }
        return { content: `Wrote part ${FILES[n - 1]}.` }
      }
      if (issued === 3 && !overflowed) {
        overflowed = true
        return { error: { status: 400, error: "context_length_exceeded", message: "The conversation is longer than the model's context window." } }
      }
      if (overflowed && !seen.afterCompaction) seen.afterCompaction = body
      return actions[issued++] ?? { content: "Done." }
    },
  })
  const login = await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)
  assert.equal(login.code, 0, login.stderr)
  const run = await kriya(["run", "--mode", "auto", ...flags, "Write the four part files."], dir)
  await fake.close()
  const after = seen.afterCompaction
  return {
    exit: run.code,
    compactions: seen.compactions,
    files: FILES.filter((f) => {
      try {
        return readFileSync(join(dir, `part-${f}.txt`), "utf8") === "ok"
      } catch {
        return false
      }
    }).length,
    stateShown: Boolean(after) && has(after, "Where this task stands"),
    stepsShown: Boolean(after) && has(after, "1. Write part a: passed") && has(after, "2. Write part b: passed"),
    nextShown: Boolean(after) && has(after, "Next: kriya_step with step 3."),
    stderr: run.stderr.slice(-800),
  }
}

test("HU-M-11 long horizon on a 32k window: after a compaction that forgets the plan, the loop (v1 and v2) still shows where the task stands", { timeout: 600_000 }, async () => {
  const v1 = await arm([])
  const v2 = await arm(["--loop-v2"])
  const report = JSON.stringify({ v1, v2 })
  console.log(`HU-M-11 ${report}`)
  for (const r of [v1, v2]) {
    assert.equal(r.exit, 0, report)
    assert.ok(r.compactions >= 1, report)
    assert.equal(r.files, 4, report)
  }
  // v1 too since 2026-11-04 (a real run lost its plan after compaction; the Progress tab never moved)
  for (const r of [v1, v2]) assert.deepEqual([r.stateShown, r.stepsShown, r.nextShown], [true, true, true], report)
})
