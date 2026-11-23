import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { planTiers } from "../src/launch.js"
import { applyWorkforce, SET_BY_PERSON, switchEnv, SWITCHES, WORKFORCE_SWITCHES } from "../src/modes.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// Harness 2.0: the owner's Kriya settings reach the device. With harness.workforce
// on, GET /models says `workforce: 1` (and `orchestra` with the head and worker),
// and a plain `kriya` turns the Harness 2.0 switches on, the person's own flags
// winning. Without it, nothing changes. WT-WF-*.

const name = (flag) => SWITCHES.find(([f]) => f === flag)[1]

test("WT-WF-01: with Kriya's advert, the owner's switches turn on unless the person set them; without it, nothing changes", () => {
  const env = {}
  switchEnv(["--no-gates", "--critic"], env)
  assert.deepEqual(env[SET_BY_PERSON].split(",").sort(), ["critic", "gates"])
  const turned = applyWorkforce(env, true)
  assert.deepEqual(turned.sort(), WORKFORCE_SWITCHES.filter((f) => f !== "gates" && f !== "critic").sort())
  assert.equal(env[name("gates")], "off", "the person's --no-gates wins")
  assert.equal(env[name("critic")], "on")
  for (const flag of ["repo-tools", "deploy", "edit", "loop-v2", "anchor"]) assert.equal(env[name(flag)], "off", `${flag} stays the person's to turn on`)
  // A variable in the person's shell counts as their choice too
  const shell = { KRIYA_ORCHESTRA: "off" }
  switchEnv([], shell)
  applyWorkforce(shell, true)
  assert.equal(shell.KRIYA_ORCHESTRA, "off")
  assert.equal(shell.KRIYA_CARTRIDGES, "on")
  // No advert (harness.workforce off, or an older Kriya): exactly as before
  const plain = {}
  switchEnv([], plain)
  const before = { ...plain }
  assert.deepEqual(applyWorkforce(plain, false), [])
  assert.deepEqual(plain, before)
  for (const flag of WORKFORCE_SWITCHES) assert.equal(plain[name(flag)], "off")
})

test("WT-WF-02: planTiers carries the advert only when Kriya sends workforce: 1", async () => {
  const device = { url: "http://127.0.0.1:9", token: "t" }
  const answer = (extra) => async () => ({ data: [{ id: "budget" }, { id: "escalation" }], ...extra })
  assert.equal((await planTiers(device, answer({ workforce: 1 }))).workforce, true)
  assert.equal("workforce" in (await planTiers(device, answer({}))), false)
  assert.equal("workforce" in (await planTiers(device, answer({ workforce: "yes" }))), false)
})

function kriya(args, cwd, env = {}) {
  return new Promise((done) => {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("KRIYA_") || k === "KRIYA_HOME"))
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd, env: { ...base, ...env } })
    let stderr = ""
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000)
    child.on("exit", (code) => {
      clearTimeout(timer)
      done({ code, stderr })
    })
  })
}

async function launch({ workforce, flags = [] }) {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-wf-")))
  writeFileSync(join(dir, "README.md"), "x\n")
  const seen = []
  const fake = await startFakeKriya({
    models: ["budget", "balanced", "escalation"],
    orchestra: { head: "escalation", worker: "budget" },
    chat: (body) => {
      if (body.tools?.length) seen.push({ model: body.model, tools: body.tools.map((t) => t.function?.name ?? t.name) })
      return { content: "Hello." }
    },
  })
  fake.state.workforce = workforce
  try {
    assert.equal((await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)).code, 0)
    const run = await kriya(["run", ...flags, "Say hello"], dir)
    return { run, first: seen[0] }
  } finally {
    await fake.close()
  }
}

test("WT-WF-03: plain `kriya run` with the owner's workforce on runs on the head level with the 2.0 tools (real DSH)", { timeout: 300_000 }, async () => {
  const on = await launch({ workforce: true })
  const report = JSON.stringify({ code: on.run.code, stderr: on.run.stderr.slice(-1500), first: on.first }).slice(0, 3000)
  assert.equal(on.run.code, 0, report)
  assert.match(on.run.stderr, /Harness 2\.0 is on from your Kriya owner settings: [^\n]*orchestra/, report)
  assert.equal(on.first.model, "escalation", report)
  for (const tool of ["kriya_plan", "kriya_milestones", "api_lookup"]) assert.ok(on.first.tools.includes(tool), `${tool}: ${report}`)
  // The person's own --no-orchestra wins: the session starts on the plan's first level
  const off = await launch({ workforce: true, flags: ["--no-orchestra"] })
  assert.equal(off.run.code, 0, off.run.stderr.slice(-800))
  assert.notEqual(off.first.model, "escalation")
  assert.doesNotMatch(off.run.stderr, /Harness 2\.0 is on[^\n]*orchestra/)
})

test("WT-WF-04: without the owner's workforce, plain `kriya run` is exactly as before (real DSH)", { timeout: 300_000 }, async () => {
  const plain = await launch({ workforce: false })
  const report = JSON.stringify({ code: plain.run.code, stderr: plain.run.stderr.slice(-1500), first: plain.first }).slice(0, 3000)
  assert.equal(plain.run.code, 0, report)
  assert.doesNotMatch(plain.run.stderr, /Harness 2\.0 is on/, report)
  assert.notEqual(plain.first.model, "escalation", report)
  for (const tool of ["kriya_milestones", "api_lookup"]) assert.ok(!plain.first.tools.includes(tool), `${tool}: ${report}`)
})
