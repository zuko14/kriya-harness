import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { ensureHost, hostCall, stopHost } from "../../../src/edit/host/client.js"

// EG-5 (SECURITY_AND_THREATS §6, ED17): 100 mixed jobs on fixtures, in batches across
// three projects, with the Host killed outright (SIGKILL) every few batches. No project
// is lost, every job that was cut off resumes on the next Host and ends done, and no
// source changes by a byte.

const FLICKS = 705_600_000
const JOBS = 100
const BATCH = 5
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test("EG-5: 100 mixed jobs with the Host killed mid-batch: no lost project, every crash resumed to done, sources unchanged", { timeout: 1_800_000 }, async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "krel-")))
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "600000" }
  let host = await ensureHost({ env, home })
  const call = (method, path, body) => hostCall(home, method, path, body)
  const projects = []
  try {
    for (const [i, name] of ["Amber", "Basil", "Cedar"].entries()) {
      const folder = join(home, "work", name)
      mkdirSync(folder, { recursive: true })
      const source = join(folder, "take.mov")
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=320x180:r=30:d=${8 + i * 2}`, "-f", "lavfi", "-i", `sine=f=${220 + i * 110}:r=48000:d=${8 + i * 2}`, "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source])
      const { id } = await call("POST", "/projects", { name, folder })
      const asset = await call("POST", `/projects/${id}/assets`, { path: source })
      await call("PATCH", `/projects/${id}`, { ops: [{ op: "set_format", width: 320, height: 180 }] })
      projects.push({ id, source, asset, hash: sha(source), seconds: 8 + i * 2 })
    }

    const submitted = []
    let kills = 0
    let resumedFromKill = 0
    for (let n = 0; n < JOBS; n += BATCH) {
      const batch = []
      for (let k = n; k < Math.min(JOBS, n + BATCH); k++) {
        const p = projects[k % projects.length]
        const kind = k % 4
        if (kind === 0) batch.push(await call("POST", `/projects/${p.id}/index`, { asset: p.asset.id }))
        else {
          // A new cut each time, so renders do real work rather than hit the cache only
          const from = ((k * 7) % (p.seconds - 3)) * FLICKS
          await call("PATCH", `/projects/${p.id}`, { ops: [{ op: "keep_range", asset: p.asset.id, from, to: from + 2 * FLICKS }] })
          batch.push(await call("POST", "/jobs", { project: p.id, quality: kind === 3 ? "master" : "draft" }))
          await call("PATCH", `/projects/${p.id}`, { undo: true })
        }
      }
      submitted.push(...batch)
      // Every third batch: kill the Host as soon as a job of this batch is running
      if ((n / BATCH) % 3 === 1) {
        for (let i = 0; i < 400; i++) {
          const rows = (await call("GET", "/jobs")).jobs
          if (rows.some((j) => batch.some((b) => b.id === j.id) && j.status === "running")) break
          await new Promise((done) => setTimeout(done, 10))
        }
        const cutOff = (await call("GET", "/jobs")).jobs.filter((j) => batch.some((b) => b.id === j.id) && ["running", "pending"].includes(j.status)).length
        process.kill(host.pid, "SIGKILL")
        while (alive(host.pid)) await new Promise((done) => setTimeout(done, 20))
        kills++
        resumedFromKill += cutOff
        host = await ensureHost({ env, home })
      }
      // The batch ends before the next starts
      for (;;) {
        const rows = (await call("GET", "/jobs")).jobs.filter((j) => batch.some((b) => b.id === j.id))
        if (rows.every((j) => ["done", "failed", "canceled"].includes(j.status))) break
        await new Promise((done) => setTimeout(done, 50))
      }
    }

    const rows = (await call("GET", "/jobs")).jobs
    const ours = submitted.map((s) => rows.find((r) => r.id === s.id))
    t.diagnostic(`jobs ${ours.length}, kills ${kills}, cut off by a kill and resumed ${resumedFromKill}`)
    assert.equal(ours.length, JOBS)
    assert.ok(ours.every(Boolean), "no job was lost")
    assert.deepEqual(ours.filter((j) => j.status !== "done").map((j) => `${j.id} ${j.kind} ${j.status}: ${j.error}`), [], "every job ended done")
    assert.ok(kills >= 6 && resumedFromKill >= kills, `${kills} kills cut off ${resumedFromKill} jobs`)
    // Every project opens, with its history whole
    assert.equal((await call("GET", "/projects")).projects.length, projects.length)
    for (const p of projects) {
      const view = await call("GET", `/projects/${p.id}`)
      assert.equal(view.project.assets[0].fingerprint, p.asset.fingerprint)
      assert.equal(view.notices, undefined, "nothing was damaged by a kill")
      assert.equal(sha(p.source), p.hash, "the source is byte-identical")
    }
  } finally {
    await stopHost(home)
  }
})
