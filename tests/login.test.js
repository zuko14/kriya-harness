import assert from "node:assert/strict"
import { statSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import { connectUrl, deviceName, login } from "../src/login.js"
import { readDevice, kriyaUrl } from "../src/store.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome } from "./helpers.js"

// P-AUTH: `kriya login` against the fake Kriya. No real waiting: sleep is
// replaced and the clock is the test's.

const quick = (lines, clock = { t: 0 }) => ({
  say: (line) => lines.push(line),
  sleep: async (ms) => {
    clock.t += ms
  },
  now: () => clock.t,
  browser: false,
})

test("waits while pending, keeps the token in a private file, says who signed in", async () => {
  const home = freshHome()
  const fake = await startFakeKriya({ approveAfter: 2 })
  try {
    const lines = []
    const result = await login(fake.url, quick(lines))
    assert.match(lines[0], /^Open http:\/\/127\.0\.0\.1:\d+\/connect\/device and enter ABCD-2345 \(expires in 10 minutes\)\.$/)
    assert.equal(lines.at(-1), "Signed in as Asha · working as Arjun.")
    const polls = fake.state.requests.filter((r) => r.path === "/device/token")
    assert.equal(polls.length, 3)
    const stored = readDevice()
    assert.equal(stored.url, fake.url)
    assert.equal(stored.token, result.token)
    if (process.platform !== "win32") {
      assert.equal(statSync(join(home, "device.json")).mode & 0o777, 0o600)
      assert.equal(statSync(home).mode & 0o777, 0o700)
    }
  } finally {
    await fake.close()
  }
})

test("a denied sign-in stops with a plain message and stores nothing", async () => {
  freshHome()
  const fake = await startFakeKriya({ deny: true })
  try {
    await assert.rejects(login(fake.url, quick([])), /denied/)
    assert.equal(readDevice(), null)
  } finally {
    await fake.close()
  }
})

test("an old client gets Kriya's upgrade message", async () => {
  freshHome()
  const fake = await startFakeKriya({ minVersion: "9.0.0" })
  try {
    await assert.rejects(login(fake.url, quick([])), (error) => {
      assert.equal(error.status, 426)
      assert.match(error.message, /Update Kriya Harness to 9\.0\.0/)
      return true
    })
  } finally {
    await fake.close()
  }
})

test("the code expires after expiresIn even if nobody answers", async () => {
  freshHome()
  const fake = await startFakeKriya({ approveAfter: 10_000 })
  try {
    await assert.rejects(login(fake.url, quick([])), /expired/)
    assert.equal(readDevice(), null)
  } finally {
    await fake.close()
  }
})

test("helpers: connect link, device name, Kriya address", () => {
  assert.equal(connectUrl("https://k.example/connect/device", "ABCD-2345"), "https://k.example/connect/device?code=ABCD-2345")
  assert.ok(deviceName().length >= 1 && deviceName().length <= 60)
  assert.equal(kriyaUrl("https://k.example/some/path"), "https://k.example")
  assert.equal(kriyaUrl("http://127.0.0.1:6796"), "http://127.0.0.1:6796")
  assert.throws(() => kriyaUrl("http://k.example"), /https/)
  assert.throws(() => kriyaUrl("not a url"), /Not a web address/)
})
