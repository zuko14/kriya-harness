import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { writeMusicBed } from "../../../src/edit/engine/music-bed.js"
import { ensureHost, hostCall, stopHost } from "../../../src/edit/host/client.js"
import { ROOT } from "../../helpers.js"
import { startFakeKriya } from "../../fake-kriya.js"
import { fakeRuntime, rawTake } from "../take.js"
import { chromeSkip, linkMotion } from "./motion-runtime.js"

// DP2 and DP5 through a real Host: a podcast's cameras and a song's beats, real FFmpeg and every gate.

const FLICKS = 705_600_000

async function host(prefix, chat, prepare) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  const folder = join(home, "work", "p")
  mkdirSync(folder, { recursive: true })
  prepare(folder) // before the Host starts: an idle Host with no session stops itself
  fakeRuntime(home)
  linkMotion(home, { hyperframes: false })
  const fake = await startFakeKriya({ models: ["budget", "balanced"], features: { visuals: true, playbooks: true, mediaSearch: false }, chat })
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "600000" }
  const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { env, stdio: "ignore" })
  assert.equal(await new Promise((done) => login.on("exit", done)), 0)
  await ensureHost({ env, home })
  const call = (method, path, body) => hostCall(home, method, path, body)
  const until = async (id) => {
    for (;;) {
      const row = (await call("GET", "/jobs")).jobs.find((j) => j.id === id)
      if (["done", "failed"].includes(row.status)) return row
      await new Promise((done) => setTimeout(done, 300))
    }
  }
  return { home, folder, fake, call, until }
}
const chatFor = (genre) => (body) => {
  const task = body.response_format?.json_schema?.name
  if (task === "plan") return { content: JSON.stringify({ say: "A cut.", steps: ["Because"], genre, settings: { captions: "none", music: "none", cutSound: "none" } }) }
  if (task === "scenes") return { content: JSON.stringify({ contentType: "other", theme: "lab", scenes: [] }) }
  if (task === "story") return { content: JSON.stringify({ hook: null, drop: [] }) }
  if (task === "emphasis") return { content: JSON.stringify({ emphasis: [] }) }
  return { content: "{}" }
}
const passed = (result, ids) => {
  for (const id of ids) assert.equal(result.gates.find((g) => g.id === id)?.status, "passed", `${id}: ${JSON.stringify(result.gates.find((g) => g.id === id))}`)
}

test("ET-DR-M1: two cameras of one talk, from a plan to a checked programme", { skip: chromeSkip(), timeout: 500_000 }, async () => {
  const h = await host("kh-dr-pod-", chatFor("podcast"), (folder) => {
    rawTake(join(folder, "a.mov"))
    rawTake(join(folder, "b.mov"))
  })
  try {
    const a = join(h.folder, "a.mov")
    const b = join(h.folder, "b.mov")
    const { id } = await h.call("POST", "/projects", { name: "Talk", folder: h.folder })
    const first = await h.call("POST", `/projects/${id}/assets`, { path: a })
    await h.call("POST", `/projects/${id}/assets`, { path: b })
    await h.until((await h.call("POST", `/projects/${id}/index`, { asset: first.id })).id)
    const plan = await h.call("POST", `/projects/${id}/plan`, { text: "Edit this podcast", history: [], choices: {} })
    assert.equal(plan.brief.multicam?.angles.length, 2, JSON.stringify(plan.brief))
    const done = await h.until((await h.call("POST", `/projects/${id}/make`, { asset: first.id, brief: plan.brief })).id)
    assert.equal(done.status, "done", done.error)
    const result = JSON.parse(done.output)
    console.log(`ET-DR-M1: ${result.verdict}\n${result.notes.join("\n")}`)
    assert.ok(result.notes.some((n) => /^Synced 2 cameras/.test(n)), result.notes.join("; "))
    passed(result, ["QG-01", "QG-02", "QG-03", "QG-06", "QG-07", "QG-12"])
    const video = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", result.file])).streams.find((s) => s.codec_type === "video")
    assert.deepEqual([video.width, video.height], [1920, 1080])
  } finally {
    await stopHost(h.home)
    await h.fake.close?.()
  }
})

test("ET-DR-M2: a montage from the person's song, cut on its beats", { skip: chromeSkip(), timeout: 500_000 }, async () => {
  const h = await host("kh-dr-mon-", chatFor("montage"), (folder) => {
    rawTake(join(folder, "clip.mov"))
    writeMusicBed(join(folder, "song.wav"), { mood: "upbeat", seconds: 30 })
  })
  try {
    const clip = join(h.folder, "clip.mov")
    const song = join(h.folder, "song.wav")
    const { id } = await h.call("POST", "/projects", { name: "Montage", folder: h.folder })
    const video = await h.call("POST", `/projects/${id}/assets`, { path: clip })
    await h.call("POST", `/projects/${id}/assets`, { path: song })
    await h.until((await h.call("POST", `/projects/${id}/index`, { asset: video.id })).id)
    const plan = await h.call("POST", `/projects/${id}/plan`, { text: "Make a montage to my song, 12 seconds", history: [], choices: {} })
    assert.equal(plan.brief.montage, true, JSON.stringify(plan.brief))
    const done = await h.until((await h.call("POST", `/projects/${id}/make`, { asset: video.id, brief: { ...plan.brief, seconds: 12 } })).id)
    assert.equal(done.status, "done", done.error)
    const result = JSON.parse(done.output)
    console.log(`ET-DR-M2: ${result.verdict}\n${result.notes.join("\n")}`)
    assert.ok(result.notes.some((n) => /to the song's beats/.test(n)), result.notes.join("; "))
    passed(result, ["QG-01", "QG-02", "QG-03", "QG-07"])
    const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", result.file]).toString())
    assert.ok(Math.abs(seconds - 12) < 1, `${seconds} s`)
    const { timeline } = await h.call("GET", `/projects/${id}/plan`)
    assert.ok(timeline.picture.length >= 4, `${timeline.picture.length} shots`)
    assert.ok(timeline.duration <= 13 * FLICKS)
  } finally {
    await stopHost(h.home)
    await h.fake.close?.()
  }
})
