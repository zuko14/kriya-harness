import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { readDevice } from "../src/store.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// The `kriya` command end to end against the fake Kriya, with the real,
// pinned DSH booting the kriya-run profile (H4 exit: `kriya doctor` and
// `kriya run` against the fake gateway). Nothing leaves this machine.

function kriya(args, { cwd = ROOT, env = {} } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], {
      cwd,
      env: { ...process.env, ...env },
    })
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

test("login, doctor, run, logout", { timeout: 300_000 }, async () => {
  const home = freshHome()
  const fake = await startFakeKriya({ approveAfter: 0, answer: "Done: the fake gateway answered." })
  try {
    const login = await kriya(["login", "--url", fake.url, "--no-browser"])
    assert.equal(login.code, 0, login.stderr)
    assert.match(login.stdout, /enter ABCD-2345/)
    assert.match(login.stdout, /Signed in as Asha · working as Arjun\./)
    // The first-run safety notice, once
    assert.match(login.stderr, /Kriya Harness is a beta built on DeepSeek Harness/)
    const { token } = readDevice()

    const doctor = await kriya(["doctor"])
    assert.equal(doctor.code, 0, doctor.stdout)
    assert.match(doctor.stdout, /ok {4}gateway models: budget, balanced, escalation/)
    assert.doesNotMatch(doctor.stderr, /Kriya Harness is a beta/)

    const workspace = mkdtempSync(join(tmpdir(), "kriya-ws-"))
    const run = await kriya(["run", "Say hello"], { cwd: workspace })
    assert.equal(run.code, 0, run.stderr)
    assert.match(run.stdout, /Done: the fake gateway answered\./)
    const calls = fake.state.requests.filter((r) => r.path === "/chat/completions")
    assert.ok(calls.length >= 1)
    for (const call of calls) {
      assert.equal(call.headers.authorization, `Bearer ${token}`)
      assert.equal(call.headers["x-kriya-harness"], "0.1.0")
      assert.equal(call.body.model, "balanced")
    }
    // The token never lands in the Kriya home in plain text outside device.json
    assert.ok(existsSync(join(home, "device.json")))

    const logout = await kriya(["logout"])
    assert.equal(logout.code, 0)
    assert.match(logout.stdout, /Signed out\./)
    assert.equal(readDevice(), null)
    assert.ok(fake.state.revoked.has(token))

    const after = await kriya(["run", "Say hello"], { cwd: workspace })
    assert.equal(after.code, 1)
    assert.match(after.stdout, /Run `kriya login`/)
  } finally {
    await fake.close()
  }
})

test("a gateway refusal ends the run with exit 1 and a plain sentence", { timeout: 300_000 }, async () => {
  freshHome()
  const message = "Refused by the fake."
  const fake = await startFakeKriya({ approveAfter: 0, chatError: { status: 402, error: "cap_reached", message } })
  try {
    assert.equal((await kriya(["login", "--url", fake.url, "--no-browser"])).code, 0)
    const workspace = mkdtempSync(join(tmpdir(), "kriya-ws-"))
    const run = await kriya(["run", "Say hello"], { cwd: workspace })
    assert.equal(run.code, 1)
    // DSH's own line stays; kriya adds the words pi-ai dropped
    assert.match(run.stderr, /PI_AI_ERROR: 402 "cap_reached"/)
    assert.match(run.stderr, /kriya: This month's Kriya Harness limit is reached\./)
  } finally {
    await fake.close()
  }
})

test("a host error page during a deploy ends the run with one plain sentence, not HTML", { timeout: 300_000 }, async () => {
  freshHome()
  const fake = await startFakeKriya({ approveAfter: 0, chatHtml: 502 })
  try {
    assert.equal((await kriya(["login", "--url", fake.url, "--no-browser"])).code, 0)
    const workspace = mkdtempSync(join(tmpdir(), "kriya-ws-"))
    const run = await kriya(["run", "Say hello"], { cwd: workspace })
    assert.equal(run.code, 1)
    assert.doesNotMatch(run.stderr, /<html|<!DOCTYPE|<svg/i)
    assert.match(run.stderr, /kriya: Kriya didn't answer \(HTTP 502\); it may be restarting\./)
  } finally {
    await fake.close()
  }
})

test("unknown commands and --version", async () => {
  freshHome()
  const version = await kriya(["--version"])
  assert.equal(version.code, 0)
  assert.match(version.stdout, /^kriya 0\.1\.0 \(Kriya Harness beta, built on DeepSeek Harness \d+\.\d+\.\d+[\w.-]*\)\n$/)
  const unknown = await kriya(["fly"])
  assert.equal(unknown.code, 1)
  assert.match(unknown.stdout, /Unknown command fly/)
})

// HD-02: the attribution lives in --version, the README and the beta notice;
// help and the doctor's report speak only of Kriya
test("help and doctor name Kriya only", async () => {
  freshHome()
  const help = await kriya(["--help"])
  assert.match(help.stdout, /^Kriya Harness \(beta\)\n/)
  assert.doesNotMatch(help.stdout, /deepseek|\bdsh\b/i)
  const doctor = await kriya(["doctor"])
  assert.match(doctor.stdout, /ok {4}Kriya Harness 0\.1\.0\n/)
  assert.doesNotMatch(doctor.stdout, /deepseek|\bdsh\b/i)
})
