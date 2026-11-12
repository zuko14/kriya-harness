import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { ensureHost, hostCall, stopHost } from "../src/edit/host/client.js"
import { openIndexDb } from "../src/edit/index/db.js"
import { hostHeaders } from "../src/edit/host/paths.js"

// The Studio's editing ease (2026-11-09, from use): fixing misheard words, picking files
// instead of typing paths, style references, and setup and indexing that show progress.

const FLICKS = 705_600_000

function wordsDb(texts) {
  const db = openIndexDb(":memory:")
  db.setAsset("a1", "m1", "video")
  db.saveLayer("m1", "L2", { version: "t", status: "ok", write: (raw) => texts.forEach((text, n) => raw.prepare('insert into words (media, n, start, "end", text, conf, flags) values (?, ?, ?, ?, ?, ?, ?)').run("m1", n, n * FLICKS, n * FLICKS + FLICKS / 2, text, 0.4, "low_confidence")) })
  return db
}

test("a fixed word reads fixed everywhere, keeps what was heard, and can be put back", () => {
  const db = wordsDb(["Hi", "KLEA", "Harness"])
  assert.equal(db.correct("a1", "a1:w1", "Kriya"), true)
  const word = db.read().words[1]
  assert.deepEqual([word.text, word.heard, word.conf], ["Kriya", "KLEA", 1])
  assert.equal(db.read().words[0].heard, undefined, "other words untouched")
  db.correct("a1", "a1:w1", "Kriya Editing")
  assert.equal(db.read().words[1].text, "Kriya Editing", "a second fix replaces the first")
  db.correct("a1", "a1:w1", "KLEA")
  assert.deepEqual([db.read().words[1].text, db.read().words[1].heard], ["KLEA", undefined], "back to what was heard removes the fix")
  assert.equal(db.correct("a1", "a1:w9", "x"), false, "no such word")
  assert.equal(db.correct("a2", "a1:w1", "x"), false, "a word of another asset")
})

test("a re-index that moves the words never lands a fix on a different word", () => {
  const db = wordsDb(["Hi", "KLEA", "Harness"])
  db.correct("a1", "a1:w1", "Kriya")
  // The recogniser now hears an extra word first: a1:w1 is a different word
  db.saveLayer("m1", "L2", { version: "t2", status: "ok", write: (raw) => ["Hello", "Hi", "KLEA"].forEach((text, n) => raw.prepare('insert into words (media, n, start, "end", text, conf, flags) values (?, ?, ?, ?, ?, ?, ?)').run("m1", n, n * FLICKS, n * FLICKS + 1, text, 0.9, "")) })
  assert.deepEqual(db.read().words.map((w) => w.text), ["Hello", "Hi", "KLEA"])
})

/* ─────────────── the Host's routes, on a real Host with a fake FFmpeg ─────────────── */

async function world() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kux-")))
  const root = join(home, "work")
  const bin = join(home, "bin")
  mkdirSync(join(root, "film"), { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\ncase "$*" in\n*-filters*) echo " .S. lut3d V->V x";;\n*-encoders*) echo " V....D libx264 x";;\n*-version*) echo "ffmpeg version 9.0.2";;\n*) echo failed >&2; exit 1;;\nesac\n`)
  // A video, so a reference can be one
  writeFileSync(join(bin, "ffprobe"), `#!/bin/sh\ncase "$*" in\n*packet=pts*) printf '0\\n512\\n1024\\n';;\n*) echo '{"streams":[{"index":0,"codec_type":"video","width":640,"height":360,"avg_frame_rate":"30/1","time_base":"1/15360","duration_ts":15360},{"index":1,"codec_type":"audio","sample_rate":"48000","channels":2,"duration_ts":48000,"time_base":"1/48000"}],"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"1.0"}}';;\nesac\n`)
  chmodSync(join(bin, "ffmpeg"), 0o755)
  chmodSync(join(bin, "ffprobe"), 0o755)
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: root, KRIYA_EDIT_IDLE_MS: "60000", PATH: `${bin}:${process.env.PATH}` }
  const host = await ensureHost({ env, home })
  const call = (method, path, body) => hostCall(home, method, path, body)
  return { home, root, host, call }
}

/** A raw upload over the socket, as the Studio's file picker sends one. */
function upload(home, path, bytes) {
  return new Promise((done, fail) => {
    const req = request({ socketPath: join(home, "edit", "host.sock"), method: "POST", path, headers: hostHeaders(home) }, (res) => {
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => done({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString() || "{}") }))
    })
    req.on("error", fail)
    req.end(bytes)
  })
}

test("the Host takes a picked file and a style reference, says where speech-to-text stands, and names an index job's asset", async () => {
  const w = await world()
  try {
    const { id } = await w.call("POST", "/projects", { name: "Film", folder: join(w.root, "film") })
    const take = await upload(w.home, `/projects/${id}/upload?name=take.mov`, Buffer.from("video"))
    assert.equal(take.status, 200)
    assert.equal(take.json.kind, "video")
    assert.equal(take.json.path, "media/take.mov", "copied into the project's media folder")
    const ref = await upload(w.home, `/projects/${id}/upload?name=style.mp4&as=reference`, Buffer.from("video"))
    assert.equal(ref.status, 200)
    assert.equal(ref.json.kind, "reference")
    assert.match(ref.json.rightsNote, /confirmed/)
    // A reference can never be placed on a track (ET-SEC-08)
    await assert.rejects(w.call("PATCH", `/projects/${id}`, { ops: [{ op: "keep_range", asset: ref.json.id, from: 0, to: FLICKS / 2 }] }), /422/)

    const runtime = await w.call("GET", "/runtime")
    assert.equal(runtime.version, null)
    assert.match(runtime.speech, /Media Runtime/)
    assert.equal(runtime.setup, null)

    const job = await w.call("POST", `/projects/${id}/index`, { asset: take.json.id })
    assert.equal(job.asset, take.json.id, "the bin shows progress on the right file")

    // A word that doesn't exist, or text that isn't a word, is refused plainly
    await assert.rejects(w.call("POST", `/projects/${id}/words/a1:w0`, { text: "Kriya" }), /no such word/)
    await assert.rejects(w.call("POST", `/projects/${id}/words/a1:w0`, { text: "two\nlines" }), /60 characters/)
  } finally {
    await stopHost(w.home)
  }
})
