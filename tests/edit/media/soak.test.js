import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { ensureHost, hostCall, stopHost } from "../../../src/edit/host/client.js"

// EG-6's soak (ED17, deferred from ED12 by the owner on 2026-11-08): a 2-hour source,
// on the real Host and the real FFmpeg, through import, the Footage Index, the proxy,
// thumbnails and peaks, then a long session of edits, undos, seeks and re-renders, and
// a finished master. Memory, open files, child processes, temporary files and the
// cache must stay bounded. Synthetic picture and tone (no real person, EB-11).

const FLICKS = 705_600_000
const SOURCE_SECONDS = 2 * 60 * 60
const ROUNDS = 16
// Small, so the cap is reached and pruning is exercised many times in one run
const CACHE_CAP = 300 * 1024 * 1024
const MB = 1024 * 1024

const sha = async (file) => {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}
const rssOf = (pid) => Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) * 1024
const fdsOf = (pid) => execFileSync("lsof", ["-n", "-P", "-p", String(pid), "-F", "f"], { encoding: "utf8" }).split("\n").filter((line) => /^f\d+$/.test(line)).length
const childrenOf = (pid) => spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout.split("\n").filter(Boolean)

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else if (entry.isFile()) yield path
  }
}
const bytesIn = (dir, only = () => true) => [...files(dir)].filter(only).reduce((sum, file) => sum + (statSync(file, { throwIfNoEntry: false })?.size ?? 0), 0)

const until = async (check, limit) => {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    assert.ok(Date.now() - start < limit, "timed out")
    await new Promise((done) => setTimeout(done, 200))
  }
}

function seek(port, cookie, path, range) {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, cookie, range } }, (res) => {
      let bytes = 0
      res.on("data", (chunk) => (bytes += chunk.length))
      res.on("end", () => done({ status: res.statusCode, bytes }))
    })
    req.on("error", fail)
    req.end()
  })
}

test("EG-6: a 2-hour source to a finished cut, with memory, open files, children, temporary files and the cache bounded", { timeout: 3_600_000 }, async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ksoak-")))
  const folder = join(home, "work", "film")
  mkdirSync(folder, { recursive: true })
  const source = join(folder, "two-hours.mov")
  const made = Date.now()
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=320x180:r=30:d=${SOURCE_SECONDS}`, "-f", "lavfi", "-i", `sine=f=220:r=48000:d=${SOURCE_SECONDS}`, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "38", "-g", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "32k", "-shortest", source], { stdio: "ignore" })
  const before = await sha(source)
  t.diagnostic(`source: ${SOURCE_SECONDS} s, ${(statSync(source).size / MB).toFixed(0)} MB, made in ${((Date.now() - made) / 1000).toFixed(0)} s`)

  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "3600000", KRIYA_EDIT_CACHE_BYTES: String(CACHE_CAP) }
  const host = await ensureHost({ env, home })
  const call = (method, path, body) => hostCall(home, method, path, body)
  const finished = async (job, limit) =>
    until(async () => {
      const row = (await call("GET", "/jobs")).jobs.find((j) => j.id === job.id)
      return ["done", "failed", "canceled"].includes(row.status) ? row : null
    }, limit)
  const samples = []
  const sample = (label) => {
    const row = { label, rss: rssOf(host.pid), fds: fdsOf(host.pid), children: childrenOf(host.pid).length }
    samples.push(row)
    return row
  }
  try {
    const { id } = await call("POST", "/projects", { name: "Soak", folder })
    const cache = join(home, "edit", id, "cache")
    let started = Date.now()
    const asset = await call("POST", `/projects/${id}/assets`, { path: source })
    assert.equal(Math.round(asset.facts.duration / FLICKS), SOURCE_SECONDS)
    t.diagnostic(`import (probe and fingerprint): ${((Date.now() - started) / 1000).toFixed(1)} s`)
    await call("PATCH", `/projects/${id}`, { ops: [{ op: "set_format", width: 320, height: 180 }] })

    started = Date.now()
    const indexed = await finished(await call("POST", `/projects/${id}/index`, { asset: asset.id }), 1_800_000)
    assert.equal(indexed.status, "done", indexed.error)
    t.diagnostic(`Footage Index of 2 hours: ${((Date.now() - started) / 1000).toFixed(0)} s`)
    const shots = (await call("GET", `/projects/${id}/index`)).shots
    t.diagnostic(`shots found: ${shots.length}`)

    // The Studio's first look: a session, the proxy, thumbnails and peaks
    const { token } = await call("POST", "/internal/launch")
    const cookie = await new Promise((done, fail) => {
      const req = request({ host: "127.0.0.1", port: host.port, method: "POST", path: "/session", headers: { "content-type": "application/json", host: `127.0.0.1:${host.port}` } }, (res) => {
        res.resume()
        done(res.headers["set-cookie"][0].split(";")[0])
      })
      req.on("error", fail)
      req.end(JSON.stringify({ token }))
    })
    started = Date.now()
    const media = `/media/${asset.media}`
    const first = await seek(host.port, cookie, media, "bytes=0-65535")
    assert.equal(first.status, 206)
    for (const kind of ["thumbs", "peaks"]) assert.equal((await seek(host.port, cookie, `/tiles/${asset.media}?kind=${kind}`, "bytes=0-1023")).status, 206)
    t.diagnostic(`proxy, thumbnails and peaks of 2 hours: ${((Date.now() - started) / 1000).toFixed(0)} s`)
    const proxySize = statSync(join(cache, "proxy", readdirSync(join(cache, "proxy"))[0])).size
    const fixed = bytesIn(cache, (file) => /\/(proxy|peaks|thumbs)\//.test(file))
    sample("after the first look")

    // A long session: each round a new cut across the whole two hours (some repeat, to
    // hit the cache), a draft render, thirty seeks into the proxy, the plan, an undo
    let renders = 0
    let oneRender = null
    for (let round = 0; round < ROUNDS; round++) {
      const variant = round % 12
      const cuts = Array.from({ length: 24 }, (_, i) => {
        const from = Math.round(((i * SOURCE_SECONDS) / 24 + variant * 17) * FLICKS)
        return { op: "keep_range", asset: asset.id, from, to: from + 3 * FLICKS }
      })
      const changed = await call("PATCH", `/projects/${id}`, { ops: cuts })
      assert.deepEqual(changed.diagnostics, [])
      const job = await finished(await call("POST", "/jobs", { project: id, quality: "draft" }), 600_000)
      assert.equal(job.status, "done", job.error)
      renders++
      for (let s = 0; s < 30; s++) {
        const at = Math.floor(((s * 7919 + round * 104_729) % 1000) / 1000 * (proxySize - 65_536))
        const part = await seek(host.port, cookie, media, `bytes=${at}-${at + 65_535}`)
        assert.equal(part.status, 206)
        assert.equal(part.bytes, 65_536)
      }
      assert.ok((await call("GET", `/projects/${id}/plan`)).duration > 0)
      await call("PATCH", `/projects/${id}`, { undo: true })

      const total = bytesIn(cache)
      // What renders leave beyond the per-source files: one render's worth, not one per round
      const renderBytes = bytesIn(cache, (file) => /\/(out|master|segments|tiles|match|audio)\//.test(file))
      // One render's files is the floor (the cap can't go under it): no round may keep more than half as much again
      oneRender ??= renderBytes
      assert.ok(renderBytes <= oneRender * 1.5, `round ${round}: ${(renderBytes / MB).toFixed(0)} MB of renders kept, one render is ${(oneRender / MB).toFixed(0)} MB`)
      const row = sample(`round ${round}`)
      t.diagnostic(`round ${round}: rss ${(row.rss / MB).toFixed(0)} MB, fds ${row.fds}, cache ${(total / MB).toFixed(0)} MB (proxy, peaks, thumbnails ${(fixed / MB).toFixed(0)} MB; renders ${(renderBytes / MB).toFixed(0)} MB)`)
    }

    // The finished cut: a master of forty moments from the whole two hours
    const finale = Array.from({ length: 40 }, (_, i) => {
      const from = Math.round(((i * SOURCE_SECONDS) / 40 + 5) * FLICKS)
      return { op: "keep_range", asset: asset.id, from, to: from + 2 * FLICKS }
    })
    await call("PATCH", `/projects/${id}`, { ops: finale })
    started = Date.now()
    const master = await finished(await call("POST", "/jobs", { project: id, quality: "master" }), 900_000)
    assert.equal(master.status, "done", master.error)
    t.diagnostic(`master of 80 s from 2 hours: ${((Date.now() - started) / 1000).toFixed(0)} s`)
    const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", master.output], { encoding: "utf8" }))
    assert.ok(Math.abs(seconds - 80) < 0.1, `${seconds} s`)
    sample("after the master")

    // Memory: after warming up, no growth beyond a fixed margin, and no upward trend
    const warm = samples.slice(1, 4)
    const late = samples.slice(-3)
    const mean = (rows, key) => rows.reduce((sum, r) => sum + r[key], 0) / rows.length
    const peak = Math.max(...samples.slice(1).map((r) => r.rss))
    t.diagnostic(`rss: first look ${(samples[0].rss / MB).toFixed(0)} MB, warm ${(mean(warm, "rss") / MB).toFixed(0)} MB, late ${(mean(late, "rss") / MB).toFixed(0)} MB, peak ${(peak / MB).toFixed(0)} MB`)
    assert.ok(peak - mean(warm, "rss") <= 128 * MB, "no round takes more than 128 MB above the warm level")
    assert.ok(mean(late, "rss") - mean(warm, "rss") <= 64 * MB, "and the level doesn't climb")
    // Open files: the same at the end as when warm
    t.diagnostic(`fds: warm ${mean(warm, "fds").toFixed(1)}, late ${mean(late, "fds").toFixed(1)}`)
    assert.ok(mean(late, "fds") - mean(warm, "fds") <= 4, "no file descriptor leaks")
    // No FFmpeg left behind, no half-written or temporary file anywhere
    assert.deepEqual(samples.map((r) => r.children), samples.map(() => 0), "no child outlives its job")
    const leftovers = [...files(join(home, "edit")), ...files(folder)].filter((file) => /\.part(\.\w+)?$|\.tmp$|\/(ocr|m|heard)-[^/]+\//.test(file))
    assert.deepEqual(leftovers, [])
    assert.equal(renders, ROUNDS)
    assert.equal(await sha(source), before, "the source is byte-identical after it all (ES-02)")
  } finally {
    await stopHost(home)
  }
})
