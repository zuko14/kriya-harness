import assert from "node:assert/strict"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { after, before, beforeEach, test } from "node:test"

import { Context } from "@deepseek-ai/cordis"

import * as mirror from "../plugins/mirror/index.js"
import { BASE_PATH } from "../src/api.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, route, violations } from "./helpers.js"

// H6 client part (HD-09, P-SYNC): the Kriya mirror plugin in a real cordis
// Context from the pinned DSH, fed the committed session events DSH emits
// (`session/event`), against the fake Kriya: one summary per turn, the
// person's first message as the title, `full` only in full mode, an
// offline queue on disk delivered in order, mirror off → nothing kept.

let fake
before(async () => {
  fake = await startFakeKriya()
})
after(() => fake.close())

let home
beforeEach(() => {
  home = freshHome()
  process.env.KRIYA_DEVICE_TOKEN = fake.issueToken()
  process.env.KRIYA_GATEWAY_URL = `${fake.url}${BASE_PATH}`
  fake.state.mirror = "summary"
  fake.state.mirrorDown = false
  fake.state.sessions.clear()
  fake.state.requests.length = 0
})

let fiber
async function compose() {
  const ctx = new Context()
  fiber = ctx.plugin(mirror, { retryMs: 50 })
  await fiber
  return ctx
}

let eventSeq = 0
const at = 1_800_000_000_000
// One committed session event, as dsh-session emits it
const event = (ctx, session, type, data, time = at) =>
  ctx.emit({}, "session/event", session, { type, seq: ++eventSeq, time, data })

const text = (value) => [{ type: "text", text: value }]

// A turn as DSH records it: the person's message, two tool calls, the answer
function turn(ctx, session, n, { answer = `Answer ${n}.`, results = [] } = {}) {
  if (n === 1) event(ctx, session, "user/message", { role: "user", source: { kind: "user" }, content: text("Fix the failing test\nin api.test.ts") })
  event(ctx, session, "turn/start", { turn: n })
  results.forEach((r, i) => {
    const callId = `call-${n}-${i}`
    event(ctx, session, "tool/call", { turn: n, step: 0, callId, name: r.name, arguments: JSON.stringify(r.args ?? {}) }, at + i * 2000)
    event(
      ctx,
      session,
      "tool/result",
      { turn: n, step: 0, message: { role: "tool", toolCallId: callId, isError: r.isError, content: text(r.output ?? "") } },
      at + i * 2000 + (r.ms ?? 0)
    )
  })
  event(ctx, session, "assistant/message", { turn: n, step: 1, message: { role: "assistant", content: text(answer) } })
  event(ctx, session, "turn/end", { turn: n, reason: "completed" })
}

const RESULTS = [
  { name: "bash", args: { command: "npm test" }, output: "2 failed", ms: 1200 },
  { name: "edit", args: { path: "api.test.ts" }, output: "Error: no match", isError: true, ms: 5 },
  { name: "bash", output: 'Error: the user rejected tool "bash"', isError: true },
]

const sessions = () => [...fake.state.sessions.values()]
const turnsOf = (session) => [...session.turns.values()].sort((a, b) => a.seq - b.seq)

async function until(check, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((done) => setTimeout(done, 20))
  }
}

test("each turn becomes one summary: text, tools with status and time, the person's first line as the title", async () => {
  const ctx = await compose()
  const session = { id: "dsh-1" }
  turn(ctx, session, 1, { answer: "Fixed it.", results: RESULTS })
  await until(() => sessions()[0]?.turns.size === 1)
  const [opened] = sessions()
  assert.equal(opened.body.deviceSessionId, "dsh-1")
  assert.equal(opened.body.title, "Fix the failing test")
  assert.ok(opened.body.project.length > 0)
  const [sent] = turnsOf(opened)
  assert.deepEqual(sent, {
    seq: 1,
    text: "Fixed it.",
    tools: [
      { name: "bash", status: "ok", ms: 1200 },
      { name: "edit", status: "error", ms: 5 },
      { name: "bash", status: "declined", ms: 0 },
    ],
  })
  for (const r of fake.state.requests.filter((r) => r.path === "/sessions"))
    assert.deepEqual(violations(route("POST", "/sessions").request, r.body), [])
  for (const r of fake.state.requests.filter((r) => r.path.endsWith("/turns")))
    assert.deepEqual(violations(route("POST", "/sessions/{id}/turns").request, r.body), [])
})

test("summary mode never sends file contents or command output; full mode sends tool details", async () => {
  let ctx = await compose()
  turn(ctx, { id: "dsh-sum" }, 1, { results: RESULTS })
  await until(() => sessions()[0]?.turns.size === 1)
  assert.doesNotMatch(JSON.stringify(fake.state.requests), /2 failed|npm test|api\.test\.ts"/)

  fake.state.mirror = "full"
  fake.state.sessions.clear()
  ctx = await compose()
  turn(ctx, { id: "dsh-full" }, 1, { results: RESULTS })
  await until(() => sessions()[0]?.turns.size === 1)
  const [sent] = turnsOf(sessions()[0])
  assert.deepEqual(sent.full.tools[0], { name: "bash", input: { command: "npm test" }, output: "2 failed" })
})

test("Kriya unreachable: turns wait on disk (0600) and arrive in order once it's back, even after a restart", async () => {
  fake.state.mirrorDown = true
  let ctx = await compose()
  const session = { id: "dsh-off" }
  turn(ctx, session, 1)
  turn(ctx, session, 2)
  const file = join(home, "mirror-queue.json")
  await until(() => existsSync(file) && JSON.parse(readFileSync(file, "utf8")).length === 2)
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(sessions().length, 0)

  // kriya restarted while Kriya was down: a new plugin instance picks the queue up
  await fiber.dispose()
  fake.state.mirrorDown = false
  ctx = await compose()
  await until(() => sessions()[0]?.turns.size === 2)
  assert.deepEqual(turnsOf(sessions()[0]).map((t) => t.text), ["Answer 1.", "Answer 2."])
  await until(() => JSON.parse(readFileSync(file, "utf8")).length === 0)
})

test("mirror off (404): nothing is kept or retried, and later turns aren't sent", async () => {
  fake.state.mirror = "off"
  const ctx = await compose()
  const session = { id: "dsh-404" }
  turn(ctx, session, 1)
  await until(() => fake.state.requests.some((r) => r.path === "/sessions"))
  turn(ctx, session, 2)
  await new Promise((done) => setTimeout(done, 300))
  assert.equal(fake.state.requests.filter((r) => r.path === "/sessions").length, 1)
  const file = join(home, "mirror-queue.json")
  assert.ok(!existsSync(file) || JSON.parse(readFileSync(file, "utf8")).length === 0)
})

test("signed out: nothing is sent or kept", async () => {
  delete process.env.KRIYA_DEVICE_TOKEN
  const ctx = await compose()
  turn(ctx, { id: "dsh-out" }, 1)
  await new Promise((done) => setTimeout(done, 200))
  assert.equal(fake.state.requests.length, 0)
  assert.ok(!existsSync(join(home, "mirror-queue.json")))
})

test("a long answer is cut to the contract's 64 KB", async () => {
  const ctx = await compose()
  turn(ctx, { id: "dsh-long" }, 1, { answer: "y".repeat(70_000) })
  await until(() => sessions()[0]?.turns.size === 1)
  const [sent] = turnsOf(sessions()[0])
  assert.ok(sent.text.length <= 64 * 1024)
  assert.match(sent.text, /…$/)
})
