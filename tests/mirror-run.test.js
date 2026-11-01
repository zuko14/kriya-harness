import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// H6 end to end on the real, pinned DSH (headless `kriya run`): the fake
// gateway asks for one harmless bash call, then answers; the mirror plugin
// must deliver that turn from DSH's own committed session events to the
// fake Kriya before `kriya run` exits. Nothing leaves this machine.

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

async function runWith(mirror) {
  freshHome()
  const fake = await startFakeKriya({
    approveAfter: 0,
    mirror,
    chat: (_body, turn) =>
      turn === 1
        ? { toolCall: { name: "bash", args: { description: "Print a marker", command: "echo mirror-run" } } }
        : { content: "Finished the mirror check." },
  })
  const login = await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)
  assert.equal(login.code, 0, login.stderr)
  const run = await kriya(["run", "Check the mirror"], mkdtempSync(join(tmpdir(), "kriya-ws-")))
  await fake.close()
  return { fake, run }
}

test("summary mirror: the turn reaches Kriya from DSH's own events before kriya run exits", { timeout: 300_000 }, async () => {
  const { fake, run } = await runWith("summary")
  assert.equal(run.code, 0, run.stderr)
  const [session] = fake.state.sessions.values()
  assert.ok(session, `no mirror session\n${run.stderr.slice(-800)}`)
  assert.equal(session.body.title, "Check the mirror")
  const turns = [...session.turns.values()]
  assert.equal(turns.length, 1)
  assert.match(turns[0].text, /Finished the mirror check\./)
  assert.deepEqual(
    turns[0].tools.map((t) => [t.name, t.status]),
    [["bash", "ok"]]
  )
  assert.equal(turns[0].full, undefined)
  assert.doesNotMatch(JSON.stringify(turns), /echo mirror-run/)
})

test("full mirror: the bash call's arguments and output go too", { timeout: 300_000 }, async () => {
  const { fake, run } = await runWith("full")
  assert.equal(run.code, 0, run.stderr)
  const [turn] = [...[...fake.state.sessions.values()][0].turns.values()]
  assert.equal(turn.full.tools[0].input.command, "echo mirror-run")
  assert.match(turn.full.tools[0].output, /mirror-run/)
})

test("mirror off: nothing but the one session request", { timeout: 300_000 }, async () => {
  const { fake, run } = await runWith("off")
  assert.equal(run.code, 0, run.stderr)
  assert.equal(fake.state.sessions.size, 0)
  assert.equal(fake.state.requests.filter((r) => r.path.startsWith("/sessions")).length, 1)
})
