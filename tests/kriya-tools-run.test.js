import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// H7 end to end on the real, pinned DSH (headless `kriya run`): the fake
// model saves a note with kriya_memory_save, searches with
// kriya_memory_search, then loads a Kriya skill through DSH's own `skill`
// tool. Proves DSH accepts the tools and the skill source and routes them
// to the fake Kriya. Nothing leaves this machine.

function kriya(args, cwd) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd, env: process.env })
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

const STEPS = [
  { name: "kriya_memory_save", args: { content: "This project uses pnpm, not npm." } },
  { name: "kriya_memory_search", args: { query: "pnpm" } },
  { name: "skill", args: { name: "task-planning" } },
]

test("DSH runs Kriya's memory tools and loads a Kriya skill from the skill source", { timeout: 300_000 }, async () => {
  freshHome()
  let seen = []
  const fake = await startFakeKriya({
    approveAfter: 0,
    // DSH also asks the model for a session title (no tools offered); the
    // step is the number of tool results so far, not the request count
    chat: (body) => {
      if (!body.tools?.length) return { content: "Skills check" }
      seen = body.messages
      const done = body.messages.filter((m) => m.role === "tool").length
      return done < STEPS.length ? { toolCall: STEPS[done] } : { content: "Finished the skills check." }
    },
  })
  fake.state.skills = [
    {
      id: "task-planning",
      name: "Task planning",
      version: "1.0.0",
      description: "Break a request into steps before acting.",
      activation: { always: false, keywords: ["plan"] },
    },
  ]
  fake.state.skillBodies = new Map([["task-planning", "KRIYA-SKILL-BODY: list the steps first."]])
  fake.state.notes = [{ id: "n1", content: "pnpm is the package manager", kind: "fact", confirmed: true, shared: false }]

  const login = await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)
  assert.equal(login.code, 0, login.stderr)
  const run = await kriya(["run", "Check the skills"], mkdtempSync(join(tmpdir(), "kriya-ws-")))
  await fake.close()
  const results = JSON.stringify(seen.filter((m) => m.role === "tool"))
  const report = `exit ${run.code}\ntool results: ${results.slice(0, 1500)}\nstderr: ${run.stderr.slice(-800)}`

  assert.equal(run.code, 0, report)
  assert.deepEqual(fake.state.saved.map((s) => s.content), ["This project uses pnpm, not npm."], report)
  assert.match(results, /pnpm is the package manager/, report)
  assert.match(results, /KRIYA-SKILL-BODY/, report)
  assert.equal(fake.state.requests.filter((r) => r.path === "/skills/task-planning/1.0.0").length, 1)
  assert.match(run.stdout, /Finished the skills check\./)
})
