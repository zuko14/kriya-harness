import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"

import { ensureHost, hostCall, stopHost } from "../../../src/edit/host/client.js"
import { ROOT } from "../../helpers.js"
import { barcodeVideo, readBarcodes } from "./barcode.js"

// The whole path on a real Host with the real FFmpeg, over its own socket.

const FLICKS = 705_600_000
const ms = (n) => n * 705_600
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")

async function world(frames = 900) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-")))
  const folder = join(home, "work", "film")
  mkdirSync(folder, { recursive: true })
  const source = join(folder, "take.mov")
  await barcodeVideo(source, { frames })
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "600000" }
  const host = await ensureHost({ env, home })
  const call = (method, path, body) => hostCall(home, method, path, body)
  const { id } = await call("POST", "/projects", { name: "Film", folder })
  const asset = await call("POST", `/projects/${id}/assets`, { path: source })
  return { home, folder, source, env, host, call, id, asset }
}

const until = async (check, limit = 180_000) => {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    assert.ok(Date.now() - start < limit, "timed out")
    await new Promise((done) => setTimeout(done, 50))
  }
}

test("ET-ENG-05: kill the Host mid-render; a restart finishes the job and redoes no completed step", async () => {
  const w = await world()
  try {
    // Ten separate cuts, so there are real segments to finish before the kill
    const cuts = Array.from({ length: 10 }, (_, i) => ({ op: "keep_range", asset: w.asset.id, from: ms(i * 3000), to: ms(i * 3000 + 2000) }))
    // The source's own shape, so the barcode isn't cropped to a portrait canvas
    await w.call("PATCH", `/projects/${w.id}`, { ops: [{ op: "set_format", width: 640, height: 360 }, ...cuts] })
    const job = await w.call("POST", "/jobs", { project: w.id, quality: "draft" })

    const journal = join(w.home, "edit", w.id, "journal.sqlite")
    const segments = () => {
      const db = new DatabaseSync(journal, { readOnly: true })
      const rows = db.prepare("select id, status, attempts from steps where kind = 'segment'").all()
      db.close()
      return rows
    }
    await until(() => segments().filter((s) => s.status === "done").length >= 3)
    process.kill(w.host.pid, "SIGKILL")
    await until(() => !alive(w.host.pid))
    const finished = segments().filter((s) => s.status === "done").map((s) => s.id)
    assert.ok(finished.length >= 3 && finished.length < 10, `${finished.length} done at the kill`)
    const fileOf = (id) => join(w.home, "edit", w.id, "cache", "segments", `${id.slice("segment:".length)}.mp4`)
    const stamped = Object.fromEntries(finished.map((id) => [id, statSync(fileOf(id)).mtimeMs]))

    const next = await ensureHost({ env: w.env, home: w.home })
    assert.notEqual(next.pid, w.host.pid)
    const end = await until(async () => {
      const row = (await w.call("GET", "/jobs")).jobs.find((j) => j.id === job.id)
      return ["done", "failed"].includes(row.status) ? row : null
    })
    assert.equal(end.status, "done", end.error)

    const after = segments()
    assert.equal(after.filter((s) => s.status === "done").length, 10)
    for (const id of finished) {
      assert.equal(after.find((s) => s.id === id).attempts, 1, `${id} ran once`)
      assert.equal(statSync(fileOf(id)).mtimeMs, stamped[id], "and its file wasn't rewritten")
    }
    const wanted = Array.from({ length: 10 }, (_, i) => Array.from({ length: 60 }, (_, f) => i * 90 + f)).flat()
    assert.deepEqual(readBarcodes(end.output), wanted, "the finished film has every frame, in order")
  } finally {
    await stopHost(w.home)
  }
})

test("the whole path: bring a file in, cut it, render it, stream the proxy with Range, source untouched", async () => {
  const w = await world(300)
  const before = sha(w.source)
  try {
    assert.equal(w.asset.kind, "video")
    assert.deepEqual(w.asset.facts.fps, { n: 30, d: 1 })
    await w.call("PATCH", `/projects/${w.id}`, { ops: [{ op: "keep_range", asset: w.asset.id, from: 0, to: FLICKS * 2 }] })
    const job = await w.call("POST", "/jobs", { project: w.id, quality: "master" })
    const end = await until(async () => {
      const row = (await w.call("GET", "/jobs")).jobs.find((j) => j.id === job.id)
      return ["done", "failed"].includes(row.status) ? row : null
    })
    assert.equal(end.status, "done", end.error)
    assert.ok(end.output.startsWith(join(w.folder, "exports")), "finished files go to exports/")
    assert.equal(readBarcodes(end.output).length, 60)
    assert.equal(sha(w.source), before)

    const { token } = await w.call("POST", "/internal/launch")
    const cookie = await new Promise((done, fail) => {
      const data = JSON.stringify({ token })
      const req = request({ host: "127.0.0.1", port: w.host.port, method: "POST", path: "/session", headers: { "content-type": "application/json", host: `127.0.0.1:${w.host.port}` } }, (res) => {
        res.resume()
        done(res.headers["set-cookie"][0].split(";")[0])
      })
      req.on("error", fail)
      req.end(data)
    })
    const url = `http://127.0.0.1:${w.host.port}/media/${w.asset.media}`
    const fence = { cookie, host: `127.0.0.1:${w.host.port}` }
    const part = await fetch(url, { headers: { ...fence, range: "bytes=0-1023" } })
    assert.equal(part.status, 206)
    assert.equal((await part.arrayBuffer()).byteLength, 1024)
    assert.match(part.headers.get("content-range"), /^bytes 0-1023\/\d+$/)
    assert.equal(part.headers.get("cross-origin-embedder-policy"), "require-corp")
    const peaks = await (await fetch(`http://127.0.0.1:${w.host.port}/tiles/${w.asset.media}?kind=peaks`, { headers: fence })).json()
    assert.equal(peaks.levels[0].perSecond, 100)
  } finally {
    await stopHost(w.home)
  }
})

test("`kriya edit` starts the Host and prints a one-time link with the token in the fragment", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-")))
  const out = execFileSync(process.execPath, [join(ROOT, "bin", "kriya.js"), "edit"], { env: { ...process.env, KRIYA_HOME: home, KRIYA_EDIT: "on", KRIYA_EDIT_ROOTS: home }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  try {
    assert.match(out.trim(), /^http:\/\/127\.0\.0\.1:\d+\/launch#[\w-]{43}$/)
    assert.ok(existsSync(join(home, "edit", "host.lock")))
  } finally {
    await stopHost(home)
  }
})
