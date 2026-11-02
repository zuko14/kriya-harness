import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import { createWorld, serve, servedFolder, ServeError } from "../src/world.js"
import { startFakeKriya } from "./fake-kriya.js"
import { route, violations } from "./helpers.js"

// `kriya serve` (H10, HD-12): the frame handler over track C's real runner
// (src/runner.bundle.js) in temporary folders, and the connection loop with a
// fake WebSocket and the fake Kriya. No relay, no network: the Kriya-side
// relay and the provider are tested in the Kriya repository
// (tests/harness/device-world.test.ts) end to end.

const DEVICE = "11111111-2222-4333-8444-555555555555"
const temp = () => mkdtempSync(join(tmpdir(), "kriya-world-"))
const token = () => randomBytes(32).toString("base64url")

/** One request through the frame handler; the answer's status, headers and body */
async function request(world, { method = "POST", path, headers = {}, body }) {
  const id = Math.floor(Math.random() * 1e9)
  const frames = []
  const done = new Promise((resolve) => {
    const send = (frame) => {
      frames.push(frame)
      if (frame.t === "end" || frame.t === "error") resolve()
    }
    world.onFrame({ t: "req", id, method, path, headers }, send)
    if (body !== undefined) {
      const bytes = Buffer.from(typeof body === "string" ? body : JSON.stringify(body))
      world.onFrame({ t: "body", id, data: bytes.toString("base64") }, send)
    }
    world.onFrame({ t: "end", id }, send)
  })
  await done
  const res = frames.find((f) => f.t === "res")
  const data = Buffer.concat(frames.filter((f) => f.t === "body").map((f) => Buffer.from(f.data, "base64")))
  return { status: res?.status ?? 0, headers: res?.headers ?? {}, body: data, error: frames.find((f) => f.t === "error") }
}

const json = (answer) => JSON.parse(String(answer.body))

test("open, runner calls with the workspace's token, list, pause, reopen and destroy", async () => {
  const folder = temp()
  // The person's own file in the served folder stays untouched throughout
  writeFileSync(join(folder, "mine.txt"), "keep me\n")
  const world = createWorld({ folder, deviceId: DEVICE })
  try {
    const workspaceId = randomUUID()
    const ref = `device-${DEVICE}-${workspaceId}-1`
    const runner = token()
    const open = await request(world, { path: "/world/open", body: { ref, generation: 1, token: runner, limits: {}, fresh: true } })
    assert.equal(open.status, 200)
    assert.ok(existsSync(join(folder, `${workspaceId}-1`)))
    // A fresh generation never reuses a folder
    assert.equal((await request(world, { path: "/world/open", body: { ref, generation: 1, token: runner, fresh: true } })).status, 409)

    const as = { authorization: `Bearer ${runner}`, "content-type": "application/json", "x-kriya-world-ref": ref }
    const health = await request(world, { method: "GET", path: "/v1/health", headers: as })
    assert.deepEqual(json(health), { ok: true, version: "kriya-runner/1", generation: 1 })
    assert.equal((await request(world, { path: "/v1/write", headers: as, body: { path: "a.txt", content: "from the cloud\n" } })).status, 200)
    const read = await request(world, { path: "/v1/read", headers: as, body: { path: "a.txt" } })
    assert.match(json(read).text, /from the cloud/)
    // The runner checks the token itself; a path out of the workspace is refused
    const wrong = { ...as, authorization: `Bearer ${token()}` }
    assert.equal((await request(world, { path: "/v1/read", headers: wrong, body: { path: "a.txt" } })).status, 401)
    assert.equal((await request(world, { path: "/v1/read", headers: as, body: { path: "../mine.txt" } })).status, 403)
    // A command streams NDJSON and ends with its exit code
    const exec = await request(world, { path: "/v1/exec", headers: as, body: { command: "echo hi; exit 3", timeoutSeconds: 10 } })
    const events = String(exec.body).trim().split("\n").map((line) => JSON.parse(line))
    assert.equal(events.at(-1).type, "end")
    assert.equal(events.at(-1).exitCode, 3)

    assert.deepEqual(json(await request(world, { path: "/world/list", body: {} })), { refs: [{ ref, running: true }] })
    assert.equal((await request(world, { path: "/world/pause", body: { ref } })).status, 200)
    assert.equal((await request(world, { method: "GET", path: "/v1/health", headers: as })).status, 503)
    assert.equal((await request(world, { path: "/world/open", body: { ref, generation: 1, token: runner, fresh: false } })).status, 200)
    assert.match(json(await request(world, { path: "/v1/read", headers: as, body: { path: "a.txt" } })).text, /from the cloud/)

    assert.equal((await request(world, { path: "/world/destroy", body: { ref } })).status, 200)
    assert.equal(existsSync(join(folder, `${workspaceId}-1`)), false)
    assert.equal(readFileSync(join(folder, "mine.txt"), "utf8"), "keep me\n")
    assert.equal((await request(world, { path: "/world/open", body: { ref, generation: 1, token: runner, fresh: false } })).status, 404)
  } finally {
    await world.close()
    rmSync(folder, { recursive: true, force: true })
  }
})

test("refuses refs of another device or of no workspace, and requests for nothing open", async () => {
  const folder = temp()
  const world = createWorld({ folder, deviceId: DEVICE })
  try {
    const other = `device-${randomUUID()}-${randomUUID()}-1`
    assert.equal((await request(world, { path: "/world/open", body: { ref: other, generation: 1, token: token(), fresh: true } })).status, 400)
    assert.equal((await request(world, { path: "/world/open", body: { ref: "../../etc", fresh: true } })).status, 400)
    assert.equal((await request(world, { path: "/world/open", body: "not json" })).status, 400)
    assert.equal((await request(world, { method: "GET", path: "/v1/health", headers: { "x-kriya-world-ref": other } })).status, 503)
  } finally {
    await world.close()
    rmSync(folder, { recursive: true, force: true })
  }
})

test("an abort from the relay stops a running command", async () => {
  const folder = temp()
  const world = createWorld({ folder, deviceId: DEVICE })
  try {
    const workspaceId = randomUUID()
    const ref = `device-${DEVICE}-${workspaceId}-1`
    const runner = token()
    await request(world, { path: "/world/open", body: { ref, generation: 1, token: runner, limits: {}, fresh: true } })
    const frames = []
    const finished = new Promise((resolve) => {
      const send = (frame) => {
        frames.push(frame)
        if (frame.t === "end" || frame.t === "error") resolve()
      }
      const headers = { authorization: `Bearer ${runner}`, "content-type": "application/json", "x-kriya-world-ref": ref }
      world.onFrame({ t: "req", id: 7, method: "POST", path: "/v1/exec", headers }, send)
      world.onFrame({ t: "body", id: 7, data: Buffer.from(JSON.stringify({ command: "sleep 30", timeoutSeconds: 60 })).toString("base64") }, send)
      world.onFrame({ t: "end", id: 7 }, send)
      setTimeout(() => world.onFrame({ t: "abort", id: 7 }, send), 300)
    })
    const started = Date.now()
    await finished
    assert.ok(Date.now() - started < 10_000)
    assert.ok(frames.some((f) => f.t === "error" || f.t === "end"))
  } finally {
    await world.close()
    rmSync(folder, { recursive: true, force: true })
  }
})

// A WebSocket the test drives: it records what the client sent and closes
// with the code the test picks
class FakeSocket extends EventTarget {
  static made = []
  constructor(url, init) {
    super()
    this.url = url
    this.init = init
    this.readyState = 0
    this.sent = []
    FakeSocket.made.push(this)
  }
  send(data) {
    this.sent.push(JSON.parse(data))
  }
  open() {
    this.readyState = 1
    this.dispatchEvent(new Event("open"))
  }
  message(frame) {
    this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(frame) }))
  }
  close(code = 1000) {
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatchEvent(Object.assign(new Event("close"), { code }))
  }
}

let fake
before(async () => {
  fake = await startFakeKriya()
})
after(() => fake.close())

const until = async (check, ms = 2000) => {
  for (let i = 0; i < ms / 10 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(check())
}

test("serve: asks /world, connects with the device token, answers frames, stops when signed out", async () => {
  fake.state.relayUrl = "https://relay.kriya.example"
  const device = { url: fake.url, token: fake.issueToken() }
  const folder = temp()
  FakeSocket.made = []
  const lines = []
  const serving = serve({ device, folder, say: (line) => lines.push(line), WebSocketImpl: FakeSocket, backoffMs: 5 })
  await until(() => FakeSocket.made.length === 1)
  const socket = FakeSocket.made[0]
  assert.equal(socket.url, `wss://relay.kriya.example/v1/device/${DEVICE}`)
  assert.equal(socket.init.headers.Authorization, `Bearer ${device.token}`)
  assert.match(socket.init.headers["X-Kriya-Harness"], /^\d+\.\d+\.\d+$/)
  const world = fake.state.requests.find((r) => r.path === "/world")
  assert.deepEqual(violations(route("GET", "/world").response, world.response), [])
  socket.open()
  assert.match(lines[0], /Serving/)
  socket.message({ t: "req", id: 1, method: "POST", path: "/world/list", headers: {} })
  socket.message({ t: "end", id: 1 })
  await until(() => socket.sent.some((f) => f.t === "end"))
  assert.equal(socket.sent[0].status, 200)
  // A dropped connection comes back
  socket.close(1006)
  await until(() => FakeSocket.made.length === 2)
  FakeSocket.made[1].open()
  FakeSocket.made[1].close(4001)
  await assert.rejects(serving, (error) => error instanceof ServeError && /signed out/.test(error.message))
  rmSync(folder, { recursive: true, force: true })
})

test("serve: a refused handshake re-checks the sign-in; switched off or signed out stops with a plain message", async () => {
  const folder = temp()
  fake.state.relayUrl = null
  const device = { url: fake.url, token: fake.issueToken() }
  await assert.rejects(serve({ device, folder, WebSocketImpl: FakeSocket }), /device world turned on/)
  fake.state.relayUrl = "https://relay.kriya.example"
  FakeSocket.made = []
  const serving = serve({ device, folder, WebSocketImpl: FakeSocket, backoffMs: 5 })
  await until(() => FakeSocket.made.length === 1)
  fake.state.revoked.add(device.token)
  // Closed before it opened: the relay refused the token
  FakeSocket.made[0].close(1006)
  await assert.rejects(serving, /signed out; run kriya login/)
  rmSync(folder, { recursive: true, force: true })
})

test("serve: an unreachable Kriya during a reconnect is retried, not fatal", async () => {
  fake.state.relayUrl = "https://relay.kriya.example"
  const device = { url: fake.url, token: fake.issueToken() }
  const folder = temp()
  FakeSocket.made = []
  let warnings = 0
  const onWarning = (warning) => warning.name === "MaxListenersExceededWarning" && warnings++
  process.on("warning", onWarning)
  const stop = new AbortController()
  const serving = serve({ device, folder, signal: stop.signal, WebSocketImpl: FakeSocket, backoffMs: 1 })
  await until(() => FakeSocket.made.length === 1)
  // Kriya can't be reached: refused handshakes keep being retried (12: past
  // Node's 10-listener leak warning if each wait left one behind)
  const reachable = device.url
  device.url = "http://127.0.0.1:9"
  for (let i = 0; i < 12; i++) {
    await until(() => FakeSocket.made.length === i + 1, 5000)
    FakeSocket.made[i].close(1006)
  }
  await until(() => FakeSocket.made.length === 13, 5000)
  // Back, and this device signed out: now it stops
  device.url = reachable
  fake.state.revoked.add(device.token)
  FakeSocket.made[12].close(1006)
  await assert.rejects(serving, /signed out; run kriya login/)
  process.off("warning", onWarning)
  assert.equal(warnings, 0)
  rmSync(folder, { recursive: true, force: true })
})

test("serve: stops cleanly on Ctrl-C, and the served folder must exist", async () => {
  fake.state.relayUrl = "https://relay.kriya.example"
  const device = { url: fake.url, token: fake.issueToken() }
  const folder = temp()
  const stop = new AbortController()
  FakeSocket.made = []
  const serving = serve({ device, folder, signal: stop.signal, WebSocketImpl: FakeSocket })
  await until(() => FakeSocket.made.length === 1)
  FakeSocket.made[0].open()
  stop.abort()
  await serving
  await assert.rejects(servedFolder(join(folder, "missing")), /doesn't exist/)
  writeFileSync(join(folder, "file"), "x")
  await assert.rejects(servedFolder(join(folder, "file")), /isn't a folder/)
  rmSync(folder, { recursive: true, force: true })
})
