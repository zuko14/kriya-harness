import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, beforeEach, test } from "node:test"

import { Context } from "@deepseek-ai/cordis"

import { stepTool } from "../plugins/loop/index.js"
import * as mirror from "../plugins/mirror/index.js"
import { BASE_PATH } from "../src/api.js"
import { savePlan } from "../src/loop.js"
import { recordOutcome, returnOutcomes, setShare, shareStatus, takeOutcomes } from "../src/outcomes.js"
import { confirmCheck, verifyStep } from "../src/verify.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome } from "./helpers.js"

// Harness 2.0 W11 client part (Kriya-Tavi upgrade_2.0/SELF_EVOLUTION.md §6;
// HD-24, WD-15): `kriya share` (off by default), outcome counts per
// cartridge version only with it on, and the mirror sending them only when
// Kriya advertises it takes them. No model call.

const DB = "kriya-role-database@1.0.1"

test("WT-OV-C1: sharing is off by default; off, nothing is counted, and turning it off drops what waits", () => {
  const home = freshHome()
  assert.deepEqual(shareStatus(), { on: false })
  assert.equal(recordOutcome(DB, "pass"), false)
  assert.equal(existsSync(join(home, "outcomes-pending.json")), false)
  setShare(true, () => "2026-11-23T10:00:00.000Z")
  assert.deepEqual(shareStatus(), { on: true, changedAt: "2026-11-23T10:00:00.000Z" })
  assert.equal(recordOutcome(DB, "pass"), true)
  setShare(false)
  assert.deepEqual(JSON.parse(readFileSync(join(home, "outcomes-pending.json"), "utf8")), {})
  assert.deepEqual(takeOutcomes(), [])
})

test("WT-OV-C2: counts per version, counts only; the loop records a step's outcome for the cartridge that built it", async () => {
  freshHome()
  setShare(true)
  for (const s of ["pass", "pass", "blocked", "not checked", "fail", "interrupted"]) recordOutcome(DB, s)
  // Not a cartridge version: ignored
  assert.equal(recordOutcome("kriya-verify@1.0.0", "pass"), false)
  assert.equal(recordOutcome(undefined, "pass"), false)
  const taken = takeOutcomes()
  assert.deepEqual(taken, [{ cartridgeId: "kriya-role-database", version: "1.0.1", verified: 2, blocked: 1, notChecked: 1, undone: 0 }])
  assert.deepEqual(takeOutcomes(), [])
  returnOutcomes(taken)
  assert.deepEqual(takeOutcomes(), taken)
  // A real step through kriya_step with a cartridge
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-ov-")))
  mkdirSync(join(dir, ".git"))
  writeFileSync(join(dir, "package.json"), "{}")
  confirmCheck(dir, "npm test")
  savePlan(dir, "head", { goal: "Add the orders table", steps: [{ title: "Migration", done_when: "It applies" }] })
  const host = {
    cwd: async () => dir,
    isBuilder: () => false,
    spawn: async () => ({ output: [{ type: "text", text: "built" }], stopReason: "completed" }),
    verify: (exec, cwd, label) => verifyStep({ cwd, sessionId: "head", step: label, tree: async () => undefined, run: async () => ({ exitCode: 0, timedOut: false, output: "ok" }) }),
    cartridge: async () => ({ id: "kriya-role-database", version: "1.0.1", name: "Database engineer", body: "# Database" }),
  }
  const signal = new AbortController().signal
  assert.equal((await stepTool(host).execute({ step: 1 }, { agent: { id: "head" }, signal })).status, "pass")
  assert.deepEqual(takeOutcomes(), [{ cartridgeId: "kriya-role-database", version: "1.0.1", verified: 1, blocked: 0, notChecked: 0, undone: 0 }])
  // Already passed: not counted twice
  await stepTool(host).execute({ step: 1 }, { agent: { id: "head" }, signal })
  assert.deepEqual(takeOutcomes(), [])
})

/* ───────────────────────────── the mirror ───────────────────────────── */

let fake
before(async () => {
  fake = await startFakeKriya()
})
after(() => fake.close())
beforeEach(() => {
  freshHome()
  process.env.KRIYA_DEVICE_TOKEN = fake.issueToken()
  process.env.KRIYA_GATEWAY_URL = `${fake.url}${BASE_PATH}`
  fake.state.mirror = "summary"
  fake.state.sessions.clear()
  fake.state.requests.length = 0
  fake.state.workforce = false
})

async function mirrorTurn(sessionId) {
  const ctx = new Context()
  const fiber = ctx.plugin(mirror, { retryMs: 50 })
  await fiber
  const session = { id: sessionId }
  let seq = 0
  const emit = (type, data) => ctx.emit({}, "session/event", session, { type, seq: ++seq, time: 1_800_000_000_000, data })
  emit("user/message", { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "Add the orders table" }] })
  emit("turn/start", { turn: 1 })
  emit("assistant/message", { message: { content: [{ type: "text", text: "Done." }] } })
  emit("turn/end", { turn: 1 })
  for (let i = 0; i < 100; i++) {
    const s = [...fake.state.sessions.values()].find((x) => x.body.deviceSessionId === sessionId)
    if (s?.turns.size) {
      fiber.dispose?.()
      return s.turns.get(1)
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error("the turn never arrived")
}
const modelsAsked = () => fake.state.requests.filter((r) => r.path === "/models").length

test("WT-OV-C3: the mirror sends counts only with the opt-in and Kriya's advert; otherwise turns are as before", async () => {
  // Off: no counts, and Kriya isn't even asked
  setShare(false)
  fake.state.workforce = true
  const plain = await mirrorTurn("s-off")
  assert.equal("cartridgeOutcomes" in plain, false)
  assert.equal(modelsAsked(), 0)
  // On, but this Kriya doesn't take them: none sent, and they wait
  setShare(true)
  recordOutcome(DB, "pass")
  fake.state.workforce = false
  const old = await mirrorTurn("s-old")
  assert.equal("cartridgeOutcomes" in old, false)
  assert.ok(modelsAsked() >= 1)
  // On, and advertised: the counts go with the turn and leave the pending file
  fake.state.workforce = true
  const sent = await mirrorTurn("s-on")
  assert.deepEqual(sent.cartridgeOutcomes, [{ cartridgeId: "kriya-role-database", version: "1.0.1", verified: 1, blocked: 0, notChecked: 0, undone: 0 }])
  assert.deepEqual(takeOutcomes(), [])
})
