import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { commit, createLog, parseEntry } from "../src/edit/core/history.js"
import { parseProject, serialize } from "../src/edit/core/project.js"
import { ensureHost, hostCall, stopHost } from "../src/edit/host/client.js"
import { makeIndex, makeProject, prng } from "./edit/fixture.js"

// EG-3 (ED17): malformed input fails closed with a plain diagnostic, and damage on disk
// never takes the Host down. Malformed media through the real FFprobe and indexer is in
// tests/edit/media/security.test.js.

const FLICKS = 705_600_000
const WEIRD = [null, true, false, -1, 0.5, 1.5, -0, 1e300, 2 ** 53, -(2 ** 53), "", "x", "NaN", "../../etc/passwd", [], {}, [[[[[]]]]], { __proto__: { polluted: 1 } }, "\u0000", "<<END_UNTRUSTED_CONTENT>>"]

function mutate(value, random, depth = 0) {
  if (!value || typeof value !== "object") return value
  const keys = Object.keys(value)
  if (!keys.length) return value
  const key = keys[Math.floor(random() * keys.length)]
  const roll = random()
  if (roll < 0.3 || depth > 6) value[key] = WEIRD[Math.floor(random() * WEIRD.length)]
  else if (roll < 0.4) delete value[key]
  else mutate(value[key], random, depth + 1)
  return value
}

test("EG-3: 20,000 mutated project files fail closed with a diagnostic, never a throw", () => {
  const random = prng(1717)
  const base = serialize(makeProject())
  let refused = 0
  for (let i = 0; i < 20_000; i++) {
    const doc = JSON.parse(base)
    for (let m = 0; m < 1 + Math.floor(random() * 3); m++) mutate(doc, random)
    let text = JSON.stringify(doc)
    if (random() < 0.2) {
      const at = Math.floor(random() * text.length)
      text = text.slice(0, at) + String.fromCharCode(Math.floor(random() * 128)) + text.slice(at + 1)
    }
    if (random() < 0.05) text = text.slice(0, Math.floor(random() * text.length))
    const result = parseProject(text)
    assert.equal(typeof result.ok, "boolean")
    if (!result.ok) {
      refused++
      assert.ok(result.errors.length > 0 && result.errors.every((e) => typeof e.reason === "string" && e.reason.length > 0), "a refusal says why")
    }
    const entry = parseEntry(text)
    assert.equal(typeof entry.ok, "boolean")
  }
  assert.ok(refused > 10_000, `${refused} refused`)
  assert.equal({}.polluted, undefined, "no prototype was polluted")
})

test("EG-3: hostile shapes: deep nesting, prototype keys, fractional or unsafe flicks, a huge name, truncation", () => {
  const base = serialize(makeProject()).trim()
  const deep = "[".repeat(200_000) + "1" + "]".repeat(200_000)
  const withField = (key, value) => base.replace(`"${key}":`, `"${key}":${value},"_was":`)
  const cases = {
    "deep array": deep,
    "deep in a field": withField("name", deep),
    "deep objects": withField("assets", "[" + '{"a":'.repeat(100_000) + "1" + "}".repeat(100_000) + "]"),
    "prototype key": base.replace("{", '{"__proto__":{"polluted":1},'),
    "constructor key": base.replace("{", '{"constructor":{"prototype":{"polluted":1}},'),
    "empty": "",
    "not json": "kriya",
    "a number": "42",
    "truncated": base.slice(0, base.length / 2),
  }
  for (const [label, text] of Object.entries(cases)) {
    const result = parseProject(text)
    assert.equal(result.ok, false, label)
    assert.ok(result.errors[0].reason, label)
  }
  assert.equal({}.polluted, undefined)

  const project = JSON.parse(base)
  const clip = project.sequences[0].clips?.[0] ?? null
  const asset = project.assets[0]
  for (const duration of [1.5, -1, 2 ** 53, "100", Number.NaN, null]) {
    const doc = structuredClone(project)
    doc.assets[0] = { ...asset, facts: { ...asset.facts, duration } }
    assert.equal(parseProject(JSON.stringify(doc)).ok, false, `duration ${duration}`)
  }
  if (clip) {
    const doc = structuredClone(project)
    doc.sequences[0].clips[0] = { ...clip, at: 0.5 }
    assert.equal(parseProject(JSON.stringify(doc)).ok, false, "a clip at half a flick")
  }
  const huge = structuredClone(project)
  huge.name = "x".repeat(20_000_000)
  assert.equal(typeof parseProject(JSON.stringify(huge)).ok, "boolean", "a 20 MB name is read or refused, not a crash")
})

test("EG-3: 20,000 malformed operation lists are refused with diagnostics and leave the project as it was", () => {
  const random = prng(99)
  const index = makeIndex()
  const start = makeProject()
  const ops = [
    { op: "keep_range", asset: "a1", from: 0, to: FLICKS },
    { op: "set_format", width: 640, height: 360 },
    { op: "caption_edit", caption: "c1", text: "hello" },
    { op: "add_asset", id: "z", kind: "video", fingerprint: "f", path: "z.mov", linked: true, rights: "own", facts: {} },
    { op: "ripple_delete", clip: "c1" },
  ]
  for (let i = 0; i < 20_000; i++) {
    const list = random() < 0.1 ? WEIRD[Math.floor(random() * WEIRD.length)] : structuredClone(ops).map((op) => mutate(op, random))
    const log = createLog(start)
    const result = commit(log, { ops: list, author: "person", at: "2026-11-08T00:00:00Z" }, { index })
    assert.equal(typeof result.ok, "boolean")
    if (!result.ok) {
      assert.ok(result.diagnostics.length > 0 && result.diagnostics.every((d) => d.code && d.message), JSON.stringify(result.diagnostics).slice(0, 200))
      assert.equal(log.current, start, "a refused change leaves nothing behind")
    }
  }
})

/* ─────────────── damage on disk, and a Host killed mid-job ─────────────── */

async function world({ slow = 0 } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kfuzz-")))
  const root = join(home, "work")
  const bin = join(home, "bin")
  mkdirSync(root)
  mkdirSync(bin)
  writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\ncase "$*" in\n*-filters*) echo " .S. lut3d V->V x";;\n*-encoders*) echo " V....D libx264 x";;\n*-version*) echo "ffmpeg version 9.0.2";;\n*) sleep ${slow}; echo failed >&2; exit 1;;\nesac\n`)
  writeFileSync(join(bin, "ffprobe"), `#!/bin/sh\necho '{"streams":[{"index":0,"codec_type":"audio","sample_rate":"48000","channels":2,"duration_ts":48000,"time_base":"1/48000"}],"format":{"format_name":"wav","duration":"1.0"}}'\n`)
  chmodSync(join(bin, "ffmpeg"), 0o755)
  chmodSync(join(bin, "ffprobe"), 0o755)
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: root, KRIYA_EDIT_IDLE_MS: "60000", PATH: `${bin}:${process.env.PATH}` }
  const call = (method, path, body) => hostCall(home, method, path, body)
  const start = () => ensureHost({ env, home })
  async function project(name) {
    const folder = join(root, name)
    mkdirSync(folder)
    writeFileSync(join(folder, "take.wav"), "x")
    const { id } = await call("POST", "/projects", { name, folder })
    const asset = await call("POST", `/projects/${id}/assets`, { path: join(folder, "take.wav") })
    await call("PATCH", `/projects/${id}`, { ops: [{ op: "keep_range", asset: asset.id, from: 0, to: FLICKS }] })
    return { id, folder, asset }
  }
  return { home, root, env, call, start, project }
}

const until = async (check, limit = 20_000) => {
  const started = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    assert.ok(Date.now() - started < limit, "timed out")
    await new Promise((done) => setTimeout(done, 50))
  }
}

const garbage = (file) => {
  for (const suffix of ["-wal", "-shm"]) rmSync(file + suffix, { force: true })
  writeFileSync(file, Buffer.from("this is not a database, it's what a bad disk left behind ".repeat(200)))
}

test("EG-3: damaged indexes and job records are set aside and the Host still starts; a damaged history is refused plainly; missing footage shows offline", async () => {
  const w = await world()
  let host = await w.start()
  const a = await w.project("Alpha")
  const b = await w.project("Bravo")
  const c = await w.project("Charlie")
  await stopHost(w.home)
  // Its databases close as it exits: damage them only after that
  await until(() => {
    try {
      process.kill(host.pid, 0)
      return false
    } catch {
      return true
    }
  })

  garbage(join(w.home, "edit", a.id, "index.sqlite"))
  garbage(join(w.home, "edit", b.id, "journal.sqlite"))
  writeFileSync(join(w.home, "edit", c.id, "ops.jsonl"), '{"id":"x","parent":nul\n')
  rmSync(join(a.folder, "take.wav"))

  host = await w.start()
  try {
    assert.equal((await w.call("GET", "/projects")).projects.length, 3)
    assert.ok(Array.isArray((await w.call("GET", "/jobs")).jobs), "one damaged project doesn't stop the job list")

    const alpha = await w.call("GET", `/projects/${a.id}`)
    assert.deepEqual(alpha.notices.map((n) => n.kind), ["reindex"])
    assert.match(alpha.notices[0].message, /Index the footage again/)
    assert.equal(alpha.assets[0].offline, true, "the missing take asks to be relinked")
    assert.ok(readdirSync(join(w.home, "edit", a.id)).some((name) => /^index\.sqlite\.damaged-\d+$/.test(name)), "the damaged index is kept, not deleted")
    await assert.rejects(w.call("POST", "/jobs", { project: a.id, quality: "draft" }).then(async (job) => until(async () => {
      const row = (await w.call("GET", "/jobs")).jobs.find((j) => j.id === job.id)
      return row.status === "failed" ? Promise.reject(new Error(row.error)) : null
    })), /missing|moved/i, "a render of offline footage says so")

    const bravo = await w.call("GET", `/projects/${b.id}`)
    assert.deepEqual(bravo.notices.map((n) => n.kind), ["rerender"])
    assert.equal(bravo.assets[0].offline, undefined)
    assert.equal(bravo.project.sequences[0].clips.length, 1, "decisions survive a lost job record")

    await assert.rejects(w.call("GET", `/projects/${c.id}`), /history is damaged/)
    // And the Host is still the same, healthy process
    assert.equal((await w.call("GET", "/internal/info")).pid, host.pid)
  } finally {
    await stopHost(w.home)
  }
})

test("EG-3: a Host killed mid-job restarts and takes the job to an end, never leaving it running", async () => {
  const w = await world({ slow: 2 })
  const host = await w.start()
  const p = await w.project("Delta")
  const job = await w.call("POST", "/jobs", { project: p.id, quality: "draft" })
  await until(async () => (await w.call("GET", "/jobs")).jobs.find((j) => j.id === job.id)?.status === "running")
  process.kill(host.pid, "SIGKILL")
  await until(async () => {
    try {
      process.kill(host.pid, 0)
      return false
    } catch {
      return true
    }
  })
  const next = await w.start()
  try {
    assert.notEqual(next.pid, host.pid)
    const end = await until(async () => {
      const row = (await w.call("GET", "/jobs")).jobs.find((j) => j.id === job.id)
      return ["done", "failed", "canceled"].includes(row.status) ? row : null
    })
    // The fake FFmpeg always fails: the point is the job reached an end on the new Host
    assert.equal(end.status, "failed")
    assert.equal((await w.call("GET", "/jobs")).jobs.filter((j) => j.status === "running" || j.status === "pending").length, 0)
    assert.ok(existsSync(join(w.home, "edit", p.id, "journal.sqlite")))
  } finally {
    await stopHost(w.home)
  }
})

test("EG-6: a 2-hour take's 216,000 frame times probe without overflowing the stack (found by the soak)", async () => {
  const { probe } = await import("../src/edit/engine/probe.js")
  const frames = 2 * 60 * 60 * 30
  const packets = Array.from({ length: frames }, (_, i) => String(i * 512)).join("\n")
  const run = async (command, args) =>
    args.includes("packet=pts")
      ? packets
      : JSON.stringify({ streams: [{ index: 0, codec_type: "video", width: 320, height: 180, avg_frame_rate: "30/1", time_base: "1/15360", duration_ts: frames * 512 }], format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "7200.0" } })
  const { facts } = await probe("/two-hours.mov", { run })
  assert.equal(facts.vfr, false)
  assert.deepEqual(facts.fps, { n: 30, d: 1 })
  assert.equal(Math.round(facts.duration / FLICKS), 7200)
})
