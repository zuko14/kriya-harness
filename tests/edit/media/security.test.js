import assert from "node:assert/strict"
import { execFile, execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { probe } from "../../../src/edit/engine/probe.js"
import { EngineFailure, runTool } from "../../../src/edit/engine/tool.js"
import { ensureHost, hostCall, stopHost } from "../../../src/edit/host/client.js"
import { prng } from "../fixture.js"

// ED17 on the real FFmpeg (EG-3, ET-SEC-01, ET-SEC-10, ES-02): crafted and broken files
// end as typed failures or real facts, never a crash outside the child; playlists and
// concat lists read nothing else and reach nothing; FFmpeg has no network; sources are
// untouched.

const FLICKS = 705_600_000
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")
const childrenOf = (pid) => spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout.split("\n").filter(Boolean)

/** A local server that counts every connection: nothing in these tests may reach it. */
async function listener() {
  let hits = 0
  const server = createServer((req, res) => {
    hits++
    res.end("#EXTM3U\n")
  })
  server.on("connection", () => hits++)
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  return { url: `http://127.0.0.1:${server.address().port}`, hits: () => hits, close: () => new Promise((done) => server.close(done)) }
}

function corpus(dir) {
  const good = join(dir, "good.mov")
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=3", "-f", "lavfi", "-i", "sine=f=330:r=48000:d=3", "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", good])
  const bytes = readFileSync(good)
  const files = {}
  const put = (name, data) => {
    const file = join(dir, name)
    writeFileSync(file, data)
    files[name] = file
  }
  for (const share of [0.1, 0.5, 0.9]) put(`truncated-${share}.mov`, bytes.subarray(0, Math.floor(bytes.length * share)))
  const zeroed = Buffer.from(bytes)
  zeroed.fill(0, 0, 64)
  put("zeroed-header.mov", zeroed)
  for (const seed of [1, 2, 3, 4, 5]) {
    const random = prng(seed)
    const flipped = Buffer.from(bytes)
    for (let i = 0; i < flipped.length / 100; i++) flipped[Math.floor(random() * flipped.length)] = Math.floor(random() * 256)
    put(`flipped-${seed}.mov`, flipped)
  }
  const random = prng(9)
  put("noise.mov", Buffer.from(Array.from({ length: 1 << 20 }, () => Math.floor(random() * 256))))
  put("empty.mov", Buffer.alloc(0))
  put("text.mov", "this is not a video\n")
  return { good, files }
}

function tricks(dir, url) {
  const files = {}
  const put = (name, text) => {
    const file = join(dir, name)
    writeFileSync(file, text)
    files[name] = file
  }
  put("remote.m3u8", `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n${url}/seg.ts\n#EXT-X-ENDLIST\n`)
  put("local.m3u8", `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n/etc/hosts\n#EXT-X-ENDLIST\n`)
  put("playlist.mov", `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n${url}/seg.ts\n#EXT-X-ENDLIST\n`)
  put("list.ffconcat", "ffconcat version 1.0\nfile '/etc/hosts'\nfile 'good.mov'\n")
  put("list.mov", `ffconcat version 1.0\nfile '${url}/seg.ts'\n`)
  return files
}

test("ET-SEC-01: broken and crafted files end as facts or a typed failure; playlists and concat lists are refused and reach nothing", { timeout: 280_000 }, async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ksec-")))
  const net = await listener()
  try {
    const { good, files } = corpus(dir)
    const outcome = {}
    for (const [name, file] of Object.entries(files)) {
      try {
        const { facts } = await probe(file)
        outcome[name] = `read (${facts.width ?? "-"}×${facts.height ?? "-"})`
      } catch (error) {
        assert.ok(error instanceof EngineFailure, `${name}: ${error?.name} ${error?.message}`)
        outcome[name] = error.reason
      }
    }
    t.diagnostic(JSON.stringify(outcome))
    for (const name of ["noise.mov", "empty.mov", "text.mov", "zeroed-header.mov", "truncated-0.1.mov"]) assert.notEqual(outcome[name].startsWith("read"), true, name)
    // Refused by the format list, or by FFmpeg's own concat safety first: either way a typed failure
    for (const [name, file] of Object.entries(tricks(dir, net.url))) await assert.rejects(probe(file), EngineFailure, name)
    assert.equal((await probe(good)).facts.width, 320, "a good file still reads")
    assert.equal(net.hits(), 0, "nothing reached the network")
  } finally {
    await net.close()
  }
})

test("EG-3, ES-02: the Host takes the corpus through import and the Footage Index without dying, leaves no child behind and doesn't touch a source", { timeout: 280_000 }, async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ksech-")))
  const folder = join(home, "work", "film")
  mkdirSync(folder, { recursive: true })
  const net = await listener()
  const { good, files } = corpus(folder)
  Object.assign(files, tricks(folder, net.url))
  const take = join(folder, "take.mov")
  copyFileSync(good, take)
  const before = Object.fromEntries([take, ...Object.values(files)].map((file) => [file, sha(file)]))
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "600000" }
  const host = await ensureHost({ env, home })
  const call = (method, path, body) => hostCall(home, method, path, body)
  const finished = async (job) => {
    for (let i = 0; i < 2400; i++) {
      const row = (await call("GET", "/jobs")).jobs.find((j) => j.id === job.id)
      if (["done", "failed", "canceled"].includes(row.status)) return row
      await new Promise((done) => setTimeout(done, 50))
    }
    assert.fail("a job didn't end")
  }
  try {
    const { id } = await call("POST", "/projects", { name: "Hostile", folder })
    const seen = {}
    for (const [name, file] of Object.entries(files)) {
      try {
        const asset = await call("POST", `/projects/${id}/assets`, { path: file })
        const job = await finished(await call("POST", `/projects/${id}/index`, { asset: asset.id }))
        seen[name] = `imported, index ${job.status}`
      } catch (error) {
        seen[name] = `refused: ${error.message}`
      }
    }
    t.diagnostic(JSON.stringify(seen))
    for (const name of ["remote.m3u8", "local.m3u8", "playlist.mov", "list.ffconcat", "list.mov"]) assert.match(seen[name], /^refused/, name)
    const asset = await call("POST", `/projects/${id}/assets`, { path: take })
    assert.equal((await finished(await call("POST", `/projects/${id}/index`, { asset: asset.id }))).status, "done")
    await call("PATCH", `/projects/${id}`, { ops: [{ op: "set_format", width: 320, height: 180 }, { op: "keep_range", asset: asset.id, from: 0, to: 2 * FLICKS }] })
    const render = await finished(await call("POST", "/jobs", { project: id, quality: "master" }))
    assert.equal(render.status, "done", render.error)

    assert.equal((await call("GET", "/internal/info")).pid, host.pid, "the same Host, alive throughout")
    assert.deepEqual(childrenOf(host.pid), [], "no FFmpeg or FFprobe left running")
    for (const [file, hash] of Object.entries(before)) assert.equal(sha(file), hash, `${file} unchanged`)
    assert.equal(net.hits(), 0, "nothing reached the network")
  } finally {
    await stopHost(home)
    await net.close()
  }
})

test("ET-SEC-10: FFmpeg run by Kriya can't open a network connection, even when asked to directly", { skip: process.platform !== "darwin" && "the no-network profile is macOS only (EQ-11)", timeout: 60_000 }, async () => {
  const net = await listener()
  try {
    for (const [command, args] of [
      ["ffprobe", ["-v", "error", `${net.url}/a.mp4`]],
      ["ffmpeg", ["-hide_banner", "-nostdin", "-i", `${net.url}/a.mp4`, "-f", "null", "-"]],
      ["ffmpeg", ["-hide_banner", "-nostdin", "-f", "lavfi", "-i", "sine=d=0.2", "-f", "mp3", `${net.url}/upload.mp3`]],
    ]) await assert.rejects(runTool(command, args, { timeoutMs: 20_000 }), EngineFailure, `${command} ${args.join(" ")}`)
    assert.equal(net.hits(), 0)
    // Control: the same request unconfined does reach the server, so the zero above is the sandbox
    await new Promise((done) => execFile("ffprobe", ["-v", "error", `${net.url}/a.mp4`], { timeout: 20_000 }, () => done()))
    assert.ok(net.hits() > 0, "control: an unconfined FFprobe connects")
  } finally {
    await net.close()
  }
})
