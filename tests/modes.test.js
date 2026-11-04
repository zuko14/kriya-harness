import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { launchEnv } from "../src/launch.js"
import { APP_MODES, modeEnv, MODES, ModeError, parseMode, planJob } from "../src/modes.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// Kriya modes, end to end on the real, pinned DSH (headless `kriya run`):
// the scripted model writes one file inside the folder and one outside it,
// then asks bash for unsandboxed access. What exists afterwards, and which
// approval requests reached the fake Kriya, is what each mode allows.
// Everything stays in temporary folders on this machine.

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

async function runMode(mode, { answer = "declined" } = {}) {
  freshHome()
  const workspace = mkdtempSync(join(tmpdir(), "kriya-ws-"))
  // Not under the temporary folder: DSH's folder sandbox leaves the
  // platform's temporary areas writable on purpose
  const elsewhere = mkdtempSync(join(homedir(), ".kriya-modes-test-"))
  const marker = join(elsewhere, "bash-was-here.txt")
  const steps = [
    { name: "write", args: { file_path: join(workspace, "inside.txt"), content: "inside\n" } },
    { name: "write", args: { file_path: join(elsewhere, "outside.txt"), content: "outside\n" } },
    {
      name: "bash",
      args: {
        description: "Leave a marker outside the folder",
        command: `echo bash > ${JSON.stringify(marker)}`,
        sandbox_permissions: "danger-full-access",
        justification: "The test checks whether this mode allows it.",
      },
    },
  ]
  let fake
  let firstJob = null
  fake = await startFakeKriya({
    approveAfter: 0,
    onApproval: ({ id }) => setTimeout(() => fake.answer(id, answer), 200),
    // DSH also asks for a session title (no tools offered); the step is the
    // number of tool results so far
    chat: (body) => {
      if (!body.tools?.length) return { content: "Modes check" }
      firstJob ??= JSON.stringify(body.messages.filter((m) => m.role === "user"))
      const done = body.messages.filter((m) => m.role === "tool").length
      return done < steps.length ? { toolCall: steps[done] } : { content: "Finished the modes check." }
    },
  })
  const login = await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)
  assert.equal(login.code, 0, login.stderr)
  const run = await kriya(["run", "--mode", mode, "Check the modes"], workspace)
  await fake.close()
  const result = {
    run,
    inside: existsSync(join(workspace, "inside.txt")),
    outside: existsSync(join(elsewhere, "outside.txt")),
    bash: existsSync(marker) && readFileSync(marker, "utf8").trim() === "bash",
    approvals: [...fake.state.approvals.values()].map((a) => a.body.tool),
    firstJob,
  }
  rmSync(elsewhere, { recursive: true, force: true })
  result.report = JSON.stringify({ ...result, run: { code: run.code, stderr: run.stderr.slice(-600) } }, null, 1)
  return result
}

test("modes: names, defaults and the launch variables", () => {
  assert.equal(parseMode(undefined), "ask")
  assert.equal(parseMode("auto"), "auto")
  assert.throws(() => parseMode("sideways"), ModeError)
  assert.throws(() => parseMode("plan", APP_MODES), ModeError)
  assert.deepEqual(modeEnv("read"), { KRIYA_SANDBOX: "read-only", KRIYA_APPROVAL: "never", KRIYA_PRESET: "read-only" })
  assert.deepEqual(modeEnv("unknown"), modeEnv("ask"))
  // Only full leaves the sandbox; nothing but ask ever asks
  for (const [name, mode] of Object.entries(MODES)) {
    assert.equal(mode.sandbox === "danger-full-access", name === "full", name)
    assert.equal(mode.approval === "ask", name === "ask", name)
  }
  assert.match(planJob("fix it"), /^Plan only\.[\s\S]*Task: fix it$/)
})

test("modes: the shell can't choose the mode, only --mode can", () => {
  const env = launchEnv(null, { KRIYA_SANDBOX: "danger-full-access", KRIYA_APPROVAL: "never", KRIYA_PRESET: "full-access" })
  assert.equal(env.KRIYA_SANDBOX, "workspace-write")
  assert.equal(env.KRIYA_APPROVAL, "ask")
  assert.equal(env.KRIYA_PRESET, "ask")
  assert.equal(launchEnv(null, {}, "auto").KRIYA_APPROVAL, "never")
})

// DSH refuses a `write` outside the folder outright; unsandboxed bash is
// what asks, and the answer here is no
test("ask (default): writes in the folder; unsandboxed bash asks Kriya, declined → nothing beyond it", { timeout: 300_000 }, async () => {
  const r = await runMode("ask", { answer: "declined" })
  assert.equal(r.run.code, 0, r.report)
  assert.ok(r.inside, r.report)
  assert.ok(!r.outside && !r.bash, r.report)
  assert.deepEqual(r.approvals, ["bash"], r.report)
})

test("ask: approved on the phone, the unsandboxed bash runs once", { timeout: 300_000 }, async () => {
  const r = await runMode("ask", { answer: "approved" })
  assert.equal(r.run.code, 0, r.report)
  assert.ok(r.inside && r.bash && !r.outside, r.report)
  assert.deepEqual(r.approvals, ["bash"], r.report)
})

test("auto: writes in the folder without asking; anything beyond it is refused, not asked", { timeout: 300_000 }, async () => {
  const r = await runMode("auto")
  assert.equal(r.run.code, 0, r.report)
  assert.ok(r.inside, r.report)
  assert.ok(!r.outside && !r.bash, r.report)
  assert.deepEqual(r.approvals, [], r.report)
})

test("read: changes nothing and asks nothing", { timeout: 300_000 }, async () => {
  const r = await runMode("read")
  assert.equal(r.run.code, 0, r.report)
  assert.ok(!r.inside && !r.outside && !r.bash, r.report)
  assert.deepEqual(r.approvals, [], r.report)
})

test("plan: the job is asked as a plan; changes nothing and asks nothing", { timeout: 300_000 }, async () => {
  const r = await runMode("plan")
  assert.equal(r.run.code, 0, r.report)
  assert.match(r.firstJob, /Plan only\./, r.report)
  assert.match(r.firstJob, /Task: Check the modes/, r.report)
  assert.ok(!r.inside && !r.outside && !r.bash, r.report)
  assert.deepEqual(r.approvals, [], r.report)
})

test("full: everything runs without asking, after the warning", { timeout: 300_000 }, async () => {
  const r = await runMode("full")
  assert.equal(r.run.code, 0, r.report)
  assert.ok(r.inside && r.outside && r.bash, r.report)
  assert.deepEqual(r.approvals, [], r.report)
  assert.match(r.run.stderr, /Full access: the agent runs commands and changes files anywhere/)
})

// Harness upgrade U10 (HU-SW-01): B4 is the default; flags beat the
// environment, which beats the default; the anchor stays opt-in
test("HU-SW-01: the loop and the budget are on unless turned off; --anchor is opt-in", async () => {
  const { switchEnv } = await import("../src/modes.js")
  const run = (args, env = {}) => {
    const a = [...args]
    switchEnv(a, env)
    return { args: a, loop: env.KRIYA_LOOP, budget: env.KRIYA_BUDGET, anchor: env.KRIYA_ANCHOR }
  }
  assert.deepEqual(run(["job"]), { args: ["job"], loop: "on", budget: "on", anchor: "off" })
  assert.deepEqual(run(["--no-loop", "--no-budget", "--anchor", "job"]), { args: ["job"], loop: "off", budget: "off", anchor: "on" })
  assert.deepEqual(run(["job"], { KRIYA_LOOP: "off", KRIYA_BUDGET: "off" }), { args: ["job"], loop: "off", budget: "off", anchor: "off" })
  // A flag beats the environment; anything but on/off is the default
  assert.deepEqual(run(["--loop"], { KRIYA_LOOP: "off", KRIYA_BUDGET: "maybe" }), { args: [], loop: "on", budget: "on", anchor: "off" })
})

