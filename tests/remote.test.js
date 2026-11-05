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
