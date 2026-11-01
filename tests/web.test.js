import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { writeDevice } from "../src/store.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// `kriya` (the Web UI profile) boots the real DSH web app on 127.0.0.1,
// which refuses requests without its own session token, and stopping kriya
// stops DSH too (the port is free again). --no-open: no browser window.

const freePort = () =>
  new Promise((done) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })

const answers = async (port) => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/`)).status
  } catch {
    return null
  }
}

test("the Web UI runs on loopback, needs its token, and stops with kriya", { timeout: 180_000 }, async () => {
  freshHome()
  const fake = await startFakeKriya()
  const port = await freePort()
  writeDevice({ url: fake.url, token: fake.issueToken(), deviceId: "11111111-2222-4333-8444-555555555555" })
  const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "--no-open", "--port", String(port)], {
    cwd: mkdtempSync(join(tmpdir(), "kriya-ws-")),
    env: process.env,
  })
  let output = ""
  child.stdout.on("data", (d) => (output += d))
  child.stderr.on("data", (d) => (output += d))
  try {
    let status = null
    for (let i = 0; i < 90 && status === null; i++) {
      await new Promise((done) => setTimeout(done, 1000))
      if (output.includes(`127.0.0.1:${port}`)) status = await answers(port)
    }
    assert.equal(status, 401, output.replace(/[A-Za-z0-9_-]{43}/g, "<token>").slice(0, 2000))
    assert.doesNotMatch(output, /startup failed|did not activate/)
  } finally {
    child.kill("SIGTERM")
    await new Promise((done) => child.on("exit", done))
    let free = false
    for (let i = 0; i < 20 && !free; i++) {
      await new Promise((done) => setTimeout(done, 500))
      free = (await answers(port)) === null
    }
    await fake.close()
    assert.ok(free, "DSH still listening after kriya was stopped")
  }
})
