import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { createAsk, parseReply } from "../src/edit/director/ask.js"
import { tidyConsole } from "../src/edit/director/revise.js"
import { ensureHost, hostCall, stopHost } from "../src/edit/host/client.js"
import { codeStamp } from "../src/edit/host/paths.js"
import { createGovernor } from "../src/edit/loop/governor.js"

// "The model's answer didn't fit, twice: isn't valid JSON" kept coming back after the fix
// was merged (2026-11-09): the running Host was the one started before the update, so it
// ran the old Director. These hold the fix in place: an outdated idle Host is replaced,
// and a reply is read however a provider shapes it, with the reason a refusal is recorded.

const FLICKS = 705_600_000

test("a reply is read from content parts and with trailing commas; a refusal says which kind", () => {
  assert.deepEqual(parseReply([{ type: "text", text: '{"ops": ' }, { type: "text", text: "[]}" }]).value, { ops: [] })
  assert.deepEqual(parseReply('{"ops": [{"op": "mark", "name": "x", "at": 0,},],}').value, { ops: [{ op: "mark", name: "x", at: 0 }] })
  assert.deepEqual(parseReply('Sure! {"ops": [],} Anything else?').value, { ops: [] })
  assert.equal(parseReply('{"ops": [', "length").kind, "cut_off")
  assert.equal(parseReply(null, "stop").kind, "cut_off", "no content at all")
  assert.equal(parseReply("I can't do that.", "stop").kind, "no_json")
})

test("a console answer's empty fields are tidied, never invented", () => {
  const tidy = tidyConsole({ ops: [{ op: "reorder", clip: "c2", after: null, asset: null, from: null, scale: null }], corrections: null, direct: false })
  assert.deepEqual(tidy, { ops: [{ op: "reorder", clip: "c2", after: null }], direct: null }, "after: null means 'to the start' and stays")
  assert.deepEqual(tidyConsole({ direct: true }), { ops: [], direct: true })
  assert.equal(tidyConsole("text"), "text")
})

test("the journal records why an answer was refused, never what it said", async () => {
  const replies = ['{"ops": [', "No JSON here", '{"other": 1}', '{"ops": []}']
  const rows = []
  let n = 0
  const send = async () => ({ choices: [{ message: { content: replies[n] }, finish_reason: n++ === 0 ? "length" : "stop" }], usage: { completion_tokens: 10 } })
  const ask = createAsk({ governor: createGovernor({ send, windowMs: 10 }), record: (row) => rows.push(row) })
  const schema = { type: "object", properties: { ops: { type: "array", items: { type: "object" } } }, required: ["ops"], additionalProperties: false }
  const slot = { task: "console", schema, view: "", request: "", maxOutput: 10, fallback: () => ({ ops: [] }) }
  await ask(slot)
  await ask(slot)
  assert.deepEqual(rows.map((r) => r.result), ["invalid:cut_off", "invalid:no_json", "invalid:schema", "repaired"])
  assert.ok(rows.every((r) => !JSON.stringify(r).includes("No JSON")), "no answer text in the journal")
})

/* ─────────────── an outdated Host is replaced, unless it's working ─────────────── */

async function world({ slow = 0 } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kstamp-")))
  const root = join(home, "work")
  const bin = join(home, "bin")
  mkdirSync(join(root, "film"), { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\ncase "$*" in\n*-filters*) echo " .S. lut3d V->V x";;\n*-encoders*) echo " V....D libx264 x";;\n*-version*) echo "ffmpeg version 9.0.2";;\n*) sleep ${slow}; echo failed >&2; exit 1;;\nesac\n`)
  writeFileSync(join(bin, "ffprobe"), `#!/bin/sh\necho '{"streams":[{"index":0,"codec_type":"audio","sample_rate":"48000","channels":2,"duration_ts":48000,"time_base":"1/48000"}],"format":{"format_name":"wav","duration":"1.0"}}'\n`)
  chmodSync(join(bin, "ffmpeg"), 0o755)
  chmodSync(join(bin, "ffprobe"), 0o755)
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: root, KRIYA_EDIT_IDLE_MS: "60000", PATH: `${bin}:${process.env.PATH}` }
  return { home, root, env }
}

test("a Host running older code is replaced when idle, and left to finish when it's working", async () => {
  const w = await world({ slow: 3 })
  try {
    const first = await ensureHost({ env: w.env, home: w.home })
    const info = await hostCall(w.home, "GET", "/internal/info")
    assert.equal(info.stamp, codeStamp(), "the Host reports the code it runs")
    assert.equal(info.busy, 0)
    assert.equal((await ensureHost({ env: w.env, home: w.home })).pid, first.pid, "the same code: the same Host")

    // Working: a job is running, so an update waits for it
    writeFileSync(join(w.root, "film", "take.wav"), "x")
    const { id } = await hostCall(w.home, "POST", "/projects", { name: "Film", folder: join(w.root, "film") })
    const asset = await hostCall(w.home, "POST", `/projects/${id}/assets`, { path: join(w.root, "film", "take.wav") })
    await hostCall(w.home, "PATCH", `/projects/${id}`, { ops: [{ op: "keep_range", asset: asset.id, from: 0, to: FLICKS / 2 }] })
    await hostCall(w.home, "POST", "/jobs", { project: id, quality: "draft" })
    assert.equal((await ensureHost({ env: w.env, home: w.home, stamp: "newer-code" })).pid, first.pid, "a working Host isn't stopped")

    // Idle again: the next start replaces it
    for (let i = 0; i < 200 && (await hostCall(w.home, "GET", "/internal/info")).busy; i++) await new Promise((done) => setTimeout(done, 50))
    const next = await ensureHost({ env: w.env, home: w.home, stamp: "newer-code" })
    assert.notEqual(next.pid, first.pid, "an idle Host on older code is replaced")
    assert.throws(() => process.kill(first.pid, 0), "and the old one has exited")
    assert.equal((await hostCall(w.home, "GET", "/projects")).projects.length, 1, "projects are on disk, so nothing is lost")
  } finally {
    await stopHost(w.home)
  }
})
