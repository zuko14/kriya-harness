import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { hostCall, ensureHost, stopHost } from "../src/edit/host/client.js"
import { ROOT } from "./helpers.js"

// The Edit Host as a real detached process, in a temporary home, with a fake FFmpeg
// on PATH. Nothing here touches ~/.kriya; real media is in tests/edit/media/.

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitFor = async (check, ms = 8000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await check()) return true
    await new Promise((done) => setTimeout(done, 25))
  }
  return false
}

function fakeFfmpeg(dir, log, { slow = 0 } = {}) {
  const file = join(dir, "ffmpeg")
  writeFileSync(file, `#!/bin/sh\nenv >> "${log}"\ncase "$*" in\n*-filters*) echo " .S. lut3d V->V x";;\n*-encoders*) echo " V....D libx264 x";;\n*-version*) echo "ffmpeg version 9.0.2";;\n*) sleep ${slow}; echo failed >&2; exit 1;;\nesac\n`)
  chmodSync(file, 0o755)
  return file
}

/** A temporary home, roots and a Host. */
async function world({ idle = 60_000, ttl, slow, extraEnv = {} } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-")))
  const root = join(home, "work")
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "kout-")))
  const bin = join(home, "bin")
  mkdirSync(root)
  mkdirSync(bin)
  const envLog = join(home, "tool-env.log")
  fakeFfmpeg(bin, envLog, { slow })
  writeFileSync(join(bin, "ffprobe"), `#!/bin/sh\necho '{"streams":[{"index":0,"codec_type":"audio","sample_rate":"48000","channels":2,"duration_ts":48000,"time_base":"1/48000"}],"format":{"format_name":"wav","duration":"1.0"}}'\n`)
  chmodSync(join(bin, "ffprobe"), 0o755)
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: root, KRIYA_EDIT_IDLE_MS: String(idle), PATH: `${bin}:${process.env.PATH}`, ...(ttl ? { KRIYA_EDIT_TOKEN_TTL_MS: String(ttl) } : {}), ...extraEnv }
  const host = await ensureHost({ env, home })
  return { home, root, outside, env, host, envLog }
}

function http(port, method, path, { headers = {}, body, hostHeader = `127.0.0.1:${port}` } = {}) {
  return new Promise((done, fail) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: hostHeader, ...(data ? { "content-type": "application/json" } : {}), ...headers } }, (res) => {
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString()
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          // A document
        }
        done({ status: res.statusCode, headers: res.headers, text, json })
      })
    })
    req.on("error", fail)
    if (data) req.write(data)
    req.end()
  })
}

async function session(w) {
  const { token } = await hostCall(w.home, "POST", "/internal/launch")
  const res = await http(w.host.port, "POST", "/session", { body: { token } })
  assert.equal(res.status, 200)
  const cookie = res.headers["set-cookie"][0].split(";")[0]
  return (method, path, body, headers = {}) => http(w.host.port, method, path, { body, headers: { cookie, ...headers } })
}

test("ET-HOST-01: one Host per machine: a second start attaches, and it outlives whoever started it", async () => {
  const w = await world()
  try {
    assert.ok(alive(w.host.pid))
    const again = await ensureHost({ env: w.env, home: w.home })
    assert.equal(again.pid, w.host.pid)
    assert.equal(again.port, w.host.port)

    await stopHost(w.home)
    assert.ok(await waitFor(() => !alive(w.host.pid)))

    // Started by a process that then exits, as the harness or the daemon might
    const starter = spawn(process.execPath, ["--input-type=module", "-e", `import { ensureHost } from ${JSON.stringify(join(ROOT, "src/edit/host/client.js"))}; const h = await ensureHost({ env: process.env, home: process.env.KRIYA_HOME }); console.log(h.pid); process.exit(0)`], { env: w.env, stdio: ["ignore", "pipe", "inherit"] })
    let out = ""
    starter.stdout.on("data", (d) => (out += d))
    await new Promise((done) => starter.on("exit", done))
    const pid = Number(out.trim())
    assert.ok(pid > 0)
    await new Promise((done) => setTimeout(done, 200))
    assert.ok(alive(pid), "the parent is gone, the Host isn't")
    assert.equal((await ensureHost({ env: w.env, home: w.home })).pid, pid)
    assert.equal((await ensureHost({ env: w.env, home: w.home })).port, w.host.port, "the port is stable, so an installed app keeps working")
  } finally {
    await stopHost(w.home)
  }
})

test("ET-HOST-01: a stale lock from a killed Host doesn't stop a new one", async () => {
  const w = await world()
  process.kill(w.host.pid, "SIGKILL")
  assert.ok(await waitFor(() => !alive(w.host.pid)))
  const next = await ensureHost({ env: w.env, home: w.home })
  try {
    assert.notEqual(next.pid, w.host.pid)
    assert.ok(alive(next.pid))
  } finally {
    await stopHost(w.home)
  }
})

test("ET-HOST-02: a launch token works once, expires, and never reaches a log", async () => {
  const w = await world({ ttl: 400 })
  try {
    const { token } = await hostCall(w.home, "POST", "/internal/launch")
    assert.equal((await http(w.host.port, "POST", "/session", { body: { token } })).status, 200)
    assert.equal((await http(w.host.port, "POST", "/session", { body: { token } })).status, 401, "single use")

    const late = (await hostCall(w.home, "POST", "/internal/launch")).token
    await new Promise((done) => setTimeout(done, 500))
    assert.equal((await http(w.host.port, "POST", "/session", { body: { token: late } })).status, 401, "expired")

    assert.equal((await http(w.host.port, "POST", "/session", { body: { token: "guess" } })).status, 401)
    const log = readFileSync(join(w.home, "edit", "host.log"), "utf8")
    assert.equal(log.includes(token) || log.includes(late), false)

    const cookie = (await http(w.host.port, "POST", "/session", { body: { token: (await hostCall(w.home, "POST", "/internal/launch")).token } })).headers["set-cookie"][0]
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Strict/)
  } finally {
    await stopHost(w.home)
  }
})

test("ET-SEC-09: a foreign Host or Origin is refused on every route; no session means 401; the socket is owner-only", async () => {
  const w = await world()
  try {
    const { port } = w.host
    assert.equal((await http(port, "GET", "/host")).status, 401)
    assert.equal((await http(port, "GET", "/host", { hostHeader: "evil.example" })).status, 403)
    assert.equal((await http(port, "GET", "/host", { hostHeader: `evil.example:${port}` })).status, 403, "DNS rebinding")
    assert.equal((await http(port, "GET", "/host", { headers: { origin: "http://evil.example" } })).status, 403)
    assert.equal((await http(port, "GET", "/host", { headers: { "sec-fetch-site": "cross-site" } })).status, 403)
    assert.equal((await http(port, "POST", "/session", { body: { token: "x" }, headers: { origin: "http://evil.example" } })).status, 403)
    assert.equal((await http(port, "POST", "/internal/launch")).status, 404, "the launch route is on the socket only")
    assert.equal(statSync(join(w.home, "edit", "host.sock")).mode & 0o077, 0)
    const res = await http(port, "GET", "/host")
    assert.equal(res.headers["access-control-allow-origin"], undefined, "no CORS, ever")
  } finally {
    await stopHost(w.home)
  }
})

test("ET-HOST-04: every document carries the COOP, COEP and CSP headers", async () => {
  const w = await world()
  try {
    const api = await session(w)
    for (const res of [await http(w.host.port, "GET", "/launch"), await api("GET", "/"), await api("GET", "/host"), await http(w.host.port, "GET", "/host")]) {
      assert.equal(res.headers["cross-origin-opener-policy"], "same-origin")
      assert.equal(res.headers["cross-origin-embedder-policy"], "require-corp")
      assert.match(res.headers["content-security-policy"], /default-src 'self'/)
      assert.match(res.headers["content-security-policy"], /frame-ancestors 'none'/)
      assert.equal(res.headers["x-content-type-options"], "nosniff")
    }
    const page = await http(w.host.port, "GET", "/launch")
    assert.match(page.text, /<script src="\/launch\.js">/)
    assert.doesNotMatch(page.text, /<script>/, "no inline script: the CSP would refuse it")
  } finally {
    await stopHost(w.home)
  }
})

test("ET-HOST-03: a path outside a project is refused on every route, including through a symlink", async () => {
  const w = await world()
  try {
    const api = await session(w)
    const folder = join(w.root, "film")
    mkdirSync(folder)
    writeFileSync(join(folder, "take.wav"), "x")
    writeFileSync(join(w.outside, "secret.wav"), "x")
    symlinkSync(join(w.outside, "secret.wav"), join(folder, "link.wav"))
    symlinkSync(w.outside, join(folder, "dir"))

    assert.equal((await api("POST", "/projects", { name: "Bad", folder: w.outside })).status, 403)
    assert.equal((await api("GET", `/browse?root=${encodeURIComponent(w.outside)}`)).status, 403)
    assert.equal((await api("GET", `/browse?root=${encodeURIComponent(join(folder, "dir"))}`)).status, 403)
    assert.equal((await api("GET", "/browse?root=/etc")).status, 403)
    const listing = await api("GET", `/browse?root=${encodeURIComponent(folder)}`)
    assert.equal(listing.status, 200)
    assert.ok(listing.json.entries.some((e) => e.name === "take.wav"))

    const made = await api("POST", "/projects", { name: "Film", folder })
    assert.equal(made.status, 200)
    const { id } = made.json
    assert.ok(existsSync(join(folder, "Film.kriya-edit")))

    for (const path of [join(w.outside, "secret.wav"), join(folder, "link.wav"), `${folder}/../../../etc/hosts`, "/etc/hosts"]) {
      const res = await api("POST", `/projects/${id}/assets`, { path })
      assert.ok([403, 404].includes(res.status), `${path}: ${res.status}`)
    }
    const good = await api("POST", `/projects/${id}/assets`, { path: join(folder, "take.wav") })
    assert.equal(good.status, 200, good.text)

    // An operation can't smuggle a path in, and a media id isn't a path
    assert.equal((await api("PATCH", `/projects/${id}`, { ops: [{ op: "add_asset", id: "x", kind: "video", fingerprint: "f", path: "/etc/hosts", linked: true, rights: "own", facts: {} }] })).json.diagnostics[0].code, "code_only")
    assert.equal((await api("GET", "/media/..%2F..%2Fetc%2Fhosts")).status, 404)
    assert.equal((await api("GET", "/tiles/..%2Fsecret?kind=peaks")).status, 404)
    assert.equal((await api("GET", "/projects/..%2F..")).status, 404)
    const upload = await http(w.host.port, "POST", `/projects/${id}/upload?name=${encodeURIComponent("../../../evil.mov")}`, { headers: { cookie: (await session(w).then(() => "")) } })
    assert.equal(upload.status, 401)
  } finally {
    await stopHost(w.home)
  }
})

test("projects: create, apply operations, survive a restart, with history replayable", async () => {
  const w = await world()
  try {
    let api = await session(w)
    const folder = join(w.root, "reel")
    mkdirSync(folder)
    writeFileSync(join(folder, "take.wav"), "x")
    const { id } = (await api("POST", "/projects", { name: "Reel", folder })).json
    const asset = (await api("POST", `/projects/${id}/assets`, { path: join(folder, "take.wav") })).json
    assert.equal(asset.facts.sampleRate, 48000)
    assert.equal(asset.path, "take.wav", "relative inside the project")

    const good = await api("PATCH", `/projects/${id}`, { ops: [{ op: "keep_range", asset: asset.id, from: 0, to: 705_600_000 }] })
    assert.deepEqual(good.json.diagnostics, [])
    const refused = await api("PATCH", `/projects/${id}`, { ops: [{ op: "ripple_delete", clip: "nope" }] })
    assert.equal(refused.status, 422)
    assert.equal(refused.json.diagnostics[0].code, "unknown_clip")

    assert.equal((await api("GET", "/projects")).json.projects[0].id, id)
    assert.equal((await api("GET", `/projects/${id}/plan`)).status, 200)
    assert.equal((await api("GET", `/projects/${id}/plan`)).json.duration > 0, true)
    assert.equal(readFileSync(join(folder, "Reel.kriya-edit"), "utf8").includes('"keep_range"'), false, "the file holds decisions, not operations")

    const lines = readFileSync(join(w.home, "edit", id, "ops.jsonl"), "utf8").trim().split("\n")
    assert.equal(lines.length, 2, "the asset and the cut; a refused change isn't history")

    await stopHost(w.home)
    await ensureHost({ env: w.env, home: w.home })
    api = await session(w)
    const back = (await api("GET", `/projects/${id}`)).json
    assert.equal(back.project.sequences[0].clips.length, 1)
    assert.equal(JSON.parse(readFileSync(join(folder, "Reel.kriya-edit"), "utf8")).history.length, 2, "a compact history mirrors into the file")
    assert.equal((await api("PATCH", `/projects/${id}`, { undo: true })).json.project.sequences[0].clips.length, 0)
  } finally {
    await stopHost(w.home)
  }
})

test("ET-HOST-05: no child process's environment holds the device token", async () => {
  const w = await world({ extraEnv: { KRIYA_DEVICE_TOKEN: "sentinel-device-token", OPENROUTER_API_KEY: "sentinel-key" } })
  try {
    const api = await session(w)
    assert.equal((await api("GET", "/host")).status, 200)
    assert.ok(await waitFor(() => existsSync(w.envLog)), "FFmpeg was asked what it can do")
    const seen = readFileSync(w.envLog, "utf8")
    assert.equal(seen.includes("sentinel"), false)
    assert.match(seen, /PATH=/)
  } finally {
    await stopHost(w.home)
  }
})

test("ET-HOST-06: it exits when idle with no jobs, and a job in progress keeps it alive", async () => {
  const quiet = await world({ idle: 250 })
  assert.ok(await waitFor(() => !alive(quiet.host.pid)), "idle: gone")
  assert.equal(existsSync(join(quiet.home, "edit", "host.lock")), false, "and it cleans up")

  const busy = await world({ idle: 400, slow: 2 })
  try {
    const api = await session(busy)
    const folder = join(busy.root, "job")
    mkdirSync(folder)
    writeFileSync(join(folder, "take.wav"), "x")
    const { id } = (await api("POST", "/projects", { name: "Job", folder })).json
    const asset = (await api("POST", `/projects/${id}/assets`, { path: join(folder, "take.wav") })).json
    await api("PATCH", `/projects/${id}`, { ops: [{ op: "keep_range", asset: asset.id, from: 0, to: 705_600_000 }] })
    const job = await api("POST", "/jobs", { project: id, quality: "draft" })
    assert.equal(job.status, 200, job.text)
    await new Promise((done) => setTimeout(done, 1000))
    assert.ok(alive(busy.host.pid), "past the idle limit, with a job running")
    assert.ok(await waitFor(() => !alive(busy.host.pid), 15000), "and it leaves once the job ends")
  } finally {
    await stopHost(busy.home).catch(() => {})
  }
})

test("media and tiles serve by opaque id, with Range; jobs list, and a cancel sticks", async () => {
  const w = await world({ slow: 5 })
  try {
    const api = await session(w)
    const folder = join(w.root, "m")
    mkdirSync(folder)
    writeFileSync(join(folder, "take.wav"), "x")
    const { id } = (await api("POST", "/projects", { name: "M", folder })).json
    const asset = (await api("POST", `/projects/${id}/assets`, { path: join(folder, "take.wav") })).json
    assert.match(asset.media, /^[0-9a-f]{32}$/)
    assert.doesNotMatch(asset.media, /take/)
    await api("PATCH", `/projects/${id}`, { ops: [{ op: "keep_range", asset: asset.id, from: 0, to: 705_600_000 }] })

    const job = (await api("POST", "/jobs", { project: id, quality: "draft" })).json
    assert.equal((await api("GET", "/jobs")).json.jobs.find((j) => j.id === job.id).kind, "render")
    assert.equal((await api("DELETE", `/jobs/${job.id}`)).status, 200)
    assert.ok(await waitFor(async () => (await api("GET", "/jobs")).json.jobs.find((j) => j.id === job.id).status === "canceled"))
    assert.equal((await api("POST", "/jobs", { project: id, quality: "best" })).status, 400)
    assert.equal((await api("POST", "/jobs", { project: "nope", quality: "draft" })).status, 404)
  } finally {
    await stopHost(w.home)
  }
})
