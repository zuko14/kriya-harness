import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { readState, remote } from "../plugins/remote/index.js"

const device = { url: "https://kriya.example", token: "t" }

function setup(over = {}) {
  const file = join(mkdtempSync(join(tmpdir(), "kriya-remote-")), "remote.json")
  const sent = []
  const daemons = []
  const r = remote({
    device: () => device,
    file,
    flushMs: 5,
    heartbeatMs: 1_000_000,
    external: () => false,
    sender: async () => async (_m, _p, body) => {
      if (over.fail) throw over.fail
      sent.push(body)
    },
    daemon: (options) => {
      daemons.push(options)
      return new Promise((done) => options.signal.addEventListener("abort", done))
    },
    ...over.host,
  })
  return { r, file, sent, daemons }
}
const settle = () => new Promise((done) => setTimeout(done, 40))
const session = { folder: tmpdir(), title: "t" }

test("RC-03: the switch starts listening and streaming; off ends both and says so", async () => {
  const { r, sent, daemons } = setup()
  await r.set("s1", { on: true }, session)
  assert.equal(daemons.length, 1)
  assert.equal(daemons[0].allowFullAccess, false)
  assert.equal(daemons[0].allowServe, false)
  r.onEvent("s1", { type: "turn/start", time: 1, data: {} })
  r.onEvent("s1", { type: "tool/call", time: 2, data: { callId: "c", name: "edit", arguments: '{"path":"a"}' } })
  await settle()
  const last = sent.at(-1)
  assert.equal(last.state, "running")
  assert.deepEqual(sent.flatMap((b) => b.events).map((e) => e.seq), [0])
  await r.set("s1", { on: false })
  await settle()
  assert.deepEqual([sent.at(-1).remote, sent.at(-1).state], [false, "ended"])
  assert.equal(r.status("s1").daemon, "off")
  await r.close()
})

test("RC-04: only switched-on sessions stream", async () => {
  const { r, sent } = setup()
  await r.set("s1", { on: true }, session)
  r.onEvent("other", { type: "user/message", time: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "private" }] } })
  await settle()
  assert.doesNotMatch(JSON.stringify(sent), /private/)
  await r.close()
})

test("RC-05: allowances reach the running daemon, never outlive Remote Control, and persist 0600-side state only", async () => {
  const { r, file, daemons } = setup()
  await r.set("s1", { on: true }, session)
  let update
  daemons[0].control.update = (next) => (update = next)
  await r.set("s1", { fullAccess: true })
  assert.equal(update.allowFullAccess, true)
  assert.equal(daemons.length, 1, "no restart: running tasks keep going")
  await r.set("s1", { on: false })
  assert.equal(readState(file).fullAccess, false)
  assert.doesNotMatch(readFileSync(file, "utf8"), /"token"/)
  await r.close()
})

test("RC-06: a Kriya with the switch off is reported, not retried as a failure", async () => {
  const { r } = setup({ fail: Object.assign(new Error("no"), { status: 404 }) })
  await r.set("s1", { on: true }, session)
  await settle()
  assert.equal(r.status("s1").unavailable, true)
  await r.close()
})

test("RC-09: refused by the server, it asks rarely, keeps events, and delivers once on", async () => {
  const state = { off: true, asked: 0 }
  const sent = []
  const { r } = setup({
    host: {
      refusedMs: 60,
      sender: async () => async (_m, _p, body) => {
        state.asked++
        if (state.off) throw Object.assign(new Error("no"), { status: 404 })
        sent.push(body)
      },
    },
  })
  await r.set("s1", { on: true }, session)
  r.onEvent("s1", { type: "user/message", time: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "kept" }] } })
  await settle()
  assert.ok(state.asked <= 2, `asked ${state.asked} times in 40 ms`)
  state.off = false
  await new Promise((done) => setTimeout(done, 120))
  assert.deepEqual(sent.flatMap((b) => b.events).map((e) => e.text), ["kept"])
  assert.equal(r.status("s1").unavailable, false)
  await r.close()
})

test("RC-10: after a restart new events never reuse a seq, so Kriya doesn't drop them", async () => {
  const first = setup()
  await first.r.set("s1", { on: true }, session)
  first.r.onEvent("s1", { type: "user/message", time: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "one" }] } })
  await settle()
  const before = first.sent.flatMap((b) => b.events)[0].seq
  await first.r.close()
  const sent = []
  const again = remote({ device: () => device, file: first.file, flushMs: 5, heartbeatMs: 1_000_000, external: () => false, sender: async () => async (_m, _p, body) => sent.push(body), daemon: (o) => new Promise((d) => o.signal.addEventListener("abort", d)) })
  await again.start()
  again.onEvent("s1", { type: "user/message", time: 2, data: { source: { kind: "user" }, content: [{ type: "text", text: "two" }] } })
  await settle()
  assert.ok(sent.flatMap((b) => b.events)[0].seq > before)
  await again.close()
})

test("RC-07: an outage keeps events in order for later", async () => {
  const state = { down: true }
  const sent = []
  const { r } = setup({
    host: {
      sender: async () => async (_m, _p, body) => {
        if (state.down) throw Object.assign(new Error("down"), { status: 0 })
        sent.push(body)
      },
    },
  })
  await r.set("s1", { on: true }, session)
  r.onEvent("s1", { type: "user/message", time: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "one" }] } })
  await settle()
  state.down = false
  await new Promise((done) => setTimeout(done, 120))
  assert.deepEqual(sent.flatMap((b) => b.events).map((e) => e.text), ["one"])
  await r.close()
})

test("RC-08: a kriya daemon already listening is left alone", async () => {
  const { r, daemons } = setup({ host: { external: () => true } })
  await r.set("s1", { on: true }, session)
  assert.equal(daemons.length, 0)
  assert.equal(r.status("s1").daemon, "external")
  await r.close()
})

test("RC-D1: Allow editing sits beside Allow serving, by the same rules, and only with editing on", async () => {
  const before = process.env.KRIYA_EDIT
  try {
    delete process.env.KRIYA_EDIT
    const off = setup()
    await off.r.set("s1", { on: true }, session)
    assert.equal("edit" in off.r.status("s1"), false, "off: the same answer as ever")

    process.env.KRIYA_EDIT = "on"
    const { r, daemons } = setup()
    await r.set("s1", { on: true }, session)
    assert.equal(r.status("s1").edit, false, "never on by default")
    assert.equal(daemons[0].allowEdit, false)
    await r.set("s1", { edit: true }, session)
    assert.equal(r.status("s1").edit, true)
    // Nothing left on: no allowance stays behind for the next time
    await r.set("s1", { on: false }, session)
    assert.equal(r.status("s1").edit, false)
  } finally {
    if (before === undefined) delete process.env.KRIYA_EDIT
    else process.env.KRIYA_EDIT = before
  }
})
