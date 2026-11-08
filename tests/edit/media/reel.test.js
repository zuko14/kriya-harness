import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { apply } from "../../../src/edit/core/ops.js"
import { compile } from "../../../src/edit/core/plan.js"
import { ensureHost, hostCall, stopHost } from "../../../src/edit/host/client.js"
import { readReceipt, verifyFile } from "../../../src/edit/engine/receipt.js"
import { runGates } from "../../../src/edit/gates/index.js"
import { ROOT } from "../../helpers.js"
import { startFakeKriya } from "../../fake-kriya.js"
import { indexOf, wordId } from "../script.js"
import { fakeRuntime, rawTake } from "../take.js"
import { linkMotion, motionSkip } from "./motion-runtime.js"
import { drums, writeWav } from "../sound.js"

// ET-RCP-02, the phase's key check: a raw synthetic take with a restart, fillers, a
// stutter and a retake becomes a cut, reframed, mastered and checked reel, through a
// real Edit Host, the real FFmpeg and a scripted model on a fake Kriya. "Speech" is
// tone bursts at the script's word times; a script stands in for the recogniser (EB-11).

const FLICKS = 705_600_000

const until = async (check, limit = 240_000, what = "a condition") => {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    assert.ok(Date.now() - start < limit, `timed out waiting for ${what}`)
    await new Promise((done) => setTimeout(done, 100))
  }
}

// With no verified recogniser (EB-11) the output isn't listened to: QG-04 and QG-14 say
// `not_checked`, which is a note, so the honest verdict is "Checked, with notes" (ED10)
const ALLOWED_NOTES = new Set(["QG-04", "QG-14"])
function onlyExpectedNotes(result, extra = []) {
  const allowed = new Set([...ALLOWED_NOTES, ...extra])
  for (const g of result.gates) {
    if (g.status === "passed" || g.status === "not_applicable") continue
    assert.ok(allowed.has(g.id) && (g.status === "not_checked" || g.severity === "note"), `${g.id} ${g.status}: ${g.message}`)
  }
  assert.equal(result.verdict, "delivered_with_notes")
}

const probe = (file) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]))

test("ET-RCP-02: a raw take becomes a cut, reframed, checked reel with a scripted model, passing QG-01, -02, -05, -06 and -12", { timeout: 280_000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-reel-")))
  const folder = join(home, "work", "reel")
  mkdirSync(folder, { recursive: true })
  const source = join(folder, "take.mov")
  rawTake(source)
  fakeRuntime(home)

  // The scripted model: the story slot answers a wrong id once (repaired), then picks the hook
  const index = indexOf()
  const hook = index.sentences.find((s) => index.words.find((w) => w.id === s.firstWord).text === "It").id
  const tasks = []
  const fake = await startFakeKriya({
    models: ["budget"],
    chat(body) {
      const task = body.response_format?.json_schema?.name
      tasks.push({ task, maxTokens: body.max_tokens })
      if (task === "story") return { content: JSON.stringify(tasks.filter((t) => t.task === "story").length === 1 ? { hook: "a1:s99", drop: [] } : { hook, drop: [] }) }
      if (task === "emphasis") return { content: JSON.stringify({ emphasis: [wordId(index, "fifty"), wordId(index, "week.")] }) }
      return { content: "{}" }
    },
  })
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "600000" }
  const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { env, stdio: "ignore" })
  assert.equal(await new Promise((done) => login.on("exit", done)), 0)
  await ensureHost({ env, home })
  const call = (method, path, body) => hostCall(home, method, path, body)
  try {
    const { id } = await call("POST", "/projects", { name: "Launch reel", folder })
    const asset = await call("POST", `/projects/${id}/assets`, { path: source })
    const job = await call("POST", `/projects/${id}/make`, { asset: asset.id, brief: { seconds: 45 } })
    assert.equal(job.kind, "make")
    const done = await until(async () => {
      const row = (await call("GET", "/jobs")).jobs.find((j) => j.id === job.id)
      return ["done", "failed"].includes(row.status) ? row : null
    }, 260_000, "the reel")
    assert.equal(done.status, "done", done.error)
    const result = JSON.parse(done.output)
    const table = result.gates.map((g) => `${g.id} ${g.status}${g.message ? `: ${g.message}` : ""}`).join("\n")
    console.log(`ET-RCP-02 verdict ${result.verdict}, ${result.calls} model calls, stop ${result.stop}, slots ${JSON.stringify(result.slots)}\n${table}`)
    for (const id of ["QG-01", "QG-02", "QG-05", "QG-06", "QG-12"]) assert.equal(result.gates.find((g) => g.id === id)?.status, "passed", `${id}: ${JSON.stringify(result.gates.find((g) => g.id === id))}`)
    onlyExpectedNotes(result)
    assert.ok(result.calls <= 8, `${result.calls} model calls for a first cut`)
    assert.deepEqual(result.slots, { story: "repaired", emphasis: "model" })
    assert.ok(tasks.every((t) => Number.isInteger(t.maxTokens)), "every call carried max_tokens")

    // The file itself: 9:16, about 45 s, at −14 LUFS
    assert.ok(existsSync(result.file))
    const facts = probe(result.file)
    const video = facts.streams.find((s) => s.codec_type === "video")
    assert.deepEqual([video.width, video.height], [1080, 1920])
    const seconds = Number(facts.format.duration)
    assert.ok(seconds >= 30 && seconds <= 60, `${seconds} s`)
    const loud = result.gates.find((g) => g.id === "QG-06").numbers
    assert.ok(Math.abs(loud.integrated + 14) <= 0.5 && loud.truePeak <= -1, JSON.stringify(loud))

    // What was cut, from the project that landed: no filler, restart or abandoned take plays
    const view = await call("GET", `/projects/${id}`)
    const plan = await call("GET", `/projects/${id}/plan`)
    const plays = (w) => plan.timeline.picture.some((p) => w.start >= p.in && w.end <= p.out)
    for (const text of ["um", "Uh,", "Sorry,", "again."]) assert.equal(plays(index.words.find((w) => w.text === text)), false, `"${text}" is cut`)
    assert.equal(plan.timeline.picture.sort((a, b) => a.at - b.at)[0].in < index.words.find((w) => w.text === "It").end, true, "the hook opens the reel")
    assert.ok(view.head, "it landed as an entry in the history")
    assert.ok(result.changes.some((c) => c.startsWith("Punched in")), "What I did lists the punch-ins")

    // ED10: the receipt and report beside the export; verify matches it, and fails a changed copy (ET-QG-21)
    assert.ok(existsSync(result.receipt) && existsSync(result.report), JSON.stringify([result.receipt, result.report]))
    const receipt = readReceipt(result.receipt)
    assert.equal(receipt.verdict, result.verdict)
    assert.equal(receipt.gates.length, 14)
    assert.equal(receipt.model.calls, tasks.length)
    assert.equal(receipt.model.money, "not reported by the gateway")
    assert.ok(Object.values(receipt.inputs).every((i) => /^[0-9a-f]{64}$/.test(i.sha256)))
    assert.deepEqual(await verifyFile(result.file, receipt), { ok: true, identical: true, differences: [] })
    const changed = join(home, "changed.mp4")
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", result.file, "-c:v", "copy", "-af", "volume=-3dB", "-c:a", "aac", "-y", changed])
    const verdictOfChange = await verifyFile(changed, receipt)
    assert.equal(verdictOfChange.ok, false)
    assert.ok(verdictOfChange.differences.some((d) => d.startsWith("loudness")), JSON.stringify(verdictOfChange))
    const report = readFileSync(result.report, "utf8")
    assert.match(report, /Checked, with notes/)
    assert.match(report, /data:image\/jpeg;base64,/, "before and after contact sheets")
    // Replay: the same job from its recording, with no model call, the same verdict and plan
    const callsBefore = tasks.length
    const replayed = await call("POST", `/jobs/${job.id}/replay`)
    const again = await until(async () => {
      const row = (await call("GET", "/jobs")).jobs.find((j) => j.id === replayed.id)
      return ["done", "failed"].includes(row.status) ? row : null
    }, 200_000, "the replay")
    assert.equal(again.status, "done", again.error)
    const replay = JSON.parse(again.output)
    assert.equal(tasks.length, callsBefore, "the replay made no model call")
    assert.deepEqual([replay.same, replay.differences], [true, []], JSON.stringify(replay.differences))

    // One undo returns the person's HEAD from before the job: the reel is a single step
    await call("PATCH", `/projects/${id}`, { undo: true })
    assert.equal((await call("GET", `/projects/${id}`)).project.sequences[0].clips.length, 0, "undone in one step")

    // The gates fire: one seeded defect each, on the same delivered file
    const project = view.project
    const deliverable = project.deliverables[0].id
    const real = compile(project, (await call("GET", `/projects/${id}/index`)), { engineVersion: "t", runtimeVersion: "t", quality: "master", deliverable })
    const raw = await call("GET", `/projects/${id}/index`)
    const rawIndex = { ...raw, subjects: {}, timestamps: {}, faces: [] }
    const gate = async (id, overrides = {}) => (await runGates({ file: overrides.file ?? result.file, plan: overrides.plan ?? real, project: overrides.project ?? project, index: rawIndex, sourcePath: () => source, thresholds: { lengthTolerance: 1 / 3 }, only: [id] })).gates[0]
    assert.equal((await gate("QG-01", { plan: { ...real, output: { ...real.output, width: 720 } } })).status, "failed", "QG-01: wrong size")
    assert.equal((await gate("QG-02", { plan: { ...real, duration: real.duration + 10 * 23_520_000 } })).status, "failed", "QG-02: ten frames short")
    const louder = join(home, "louder.mp4")
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", result.file, "-c:v", "copy", "-af", "volume=6dB", "-c:a", "aac", "-y", louder])
    assert.equal((await gate("QG-06", { file: louder })).status, "failed", "QG-06: 6 LU too loud")
    const word = index.words.find((w) => w.text === "thousand")
    const midWord = apply(project, [{ op: "split", clip: project.sequences[0].clips.find((c) => c.source).id, at: { word: word.id, edge: "start" } }, { op: "trim", clip: project.sequences[0].clips.find((c) => c.source).id, out: Math.round((word.start + word.end) / 2) }], { index: rawIndex, author: "person" })
    if (midWord.applied) {
      const qg05 = await gate("QG-05", { project: midWord.project })
      assert.equal(qg05.status, "failed", `QG-05: a cut through "thousand": ${JSON.stringify(qg05)}`)
    } else console.log(`QG-05 seeded defect refused by Edit Core itself: ${midWord.diagnostics[0].message}`)
    const lostLine = index.sentences.find((s) => index.words.find((w) => w.id === s.firstWord).text === "Sorry,").id
    assert.equal((await gate("QG-12", { project: { ...project, brief: { ...project.brief, mustKeep: [lostLine] } } })).status, "failed", "QG-12: a must-keep line that was cut")
  } finally {
    await stopHost(home)
    await fake.close?.()
  }
})

test("ED8 end to end: a talking-head reel with word-highlight captions renders through the Host, every gate passed, no error", { skip: motionSkip(), timeout: 480_000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-reel-cap-")))
  const folder = join(home, "work", "reel")
  mkdirSync(folder, { recursive: true })
  const source = join(folder, "take.mov")
  rawTake(source)
  fakeRuntime(home)
  linkMotion(home)
  const index = indexOf()
  const hook = index.sentences.find((s) => index.words.find((w) => w.id === s.firstWord).text === "It").id
  const fake = await startFakeKriya({
    models: ["budget"],
    chat(body) {
      const task = body.response_format?.json_schema?.name
      if (task === "story") return { content: JSON.stringify({ hook, drop: [] }) }
      if (task === "emphasis") return { content: JSON.stringify({ emphasis: [wordId(index, "fifty")] }) }
      return { content: "{}" }
    },
  })
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "600000" }
  const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { env, stdio: "ignore" })
  assert.equal(await new Promise((done) => login.on("exit", done)), 0)
  await ensureHost({ env, home })
  const call = (method, path, body) => hostCall(home, method, path, body)
  try {
    const { id } = await call("POST", "/projects", { name: "Captioned reel", folder })
    const asset = await call("POST", `/projects/${id}/assets`, { path: source })
    const started = Date.now()
    const job = await call("POST", `/projects/${id}/make`, { asset: asset.id, brief: { seconds: 45, captions: "karaoke" } })
    const done = await until(async () => {
      const row = (await call("GET", "/jobs")).jobs.find((j) => j.id === job.id)
      return ["done", "failed"].includes(row.status) ? row : null
    }, 460_000, "the captioned reel")
    assert.equal(done.status, "done", done.error)
    const result = JSON.parse(done.output)
    const table = result.gates.map((g) => `${g.id} ${g.status}${g.message ? `: ${g.message}` : ""}`).join("\n")
    const plan = await call("GET", `/projects/${id}/plan`)
    console.log(`ED8 reel: verdict ${result.verdict} in ${Math.round((Date.now() - started) / 1000)} s, ${plan.timeline.captions.length} caption pages, stop ${result.stop}\n${table}`)
    for (const gateId of ["QG-01", "QG-02", "QG-05", "QG-06", "QG-08", "QG-09", "QG-12"]) assert.equal(result.gates.find((g) => g.id === gateId)?.status, "passed", `${gateId}: ${JSON.stringify(result.gates.find((g) => g.id === gateId))}`)
    onlyExpectedNotes(result)
    assert.equal(result.attempts.filter((a) => a.error).length, 0, "no attempt errored")
    assert.ok(plan.timeline.captions.length >= 10, "the kept speech is captioned page by page")
    assert.equal(result.gates.find((g) => g.id === "QG-10")?.status, "passed", "OCR read every caption page as meant")
    assert.equal(result.gates.find((g) => g.id === "QG-11")?.status, "passed", "every tile moves and lasts its window")
    assert.ok(plan.timeline.captions.every((c) => c.words.length >= 1 && c.words.length <= 5 && c.look === "karaoke"))
    assert.ok(result.changes.some((c) => c.startsWith("Captioned")), "What I did lists the captions")
    const video = probe(result.file).streams.find((s) => s.codec_type === "video")
    assert.deepEqual([video.width, video.height], [1080, 1920])
  } finally {
    await stopHost(home)
    await fake.close?.()
  }
})

test("ED9 end to end: a reel with music through the Host: the song's beats indexed, fitted on its downbeats, ducked, mastered, QG-06 complete", { timeout: 280_000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-reel-music-")))
  const folder = join(home, "work", "reel")
  mkdirSync(folder, { recursive: true })
  const source = join(folder, "take.mov")
  rawTake(source)
  fakeRuntime(home)
  const song = join(folder, "song.wav")
  writeWav(song, drums(120, 80, { offset: 0, rate: 48_000, ending: 2 }), 48_000)
  const index = indexOf()
  const hook = index.sentences.find((s) => index.words.find((w) => w.id === s.firstWord).text === "It").id
  const fake = await startFakeKriya({
    models: ["budget"],
    chat(body) {
      const task = body.response_format?.json_schema?.name
      if (task === "story") return { content: JSON.stringify({ hook, drop: [] }) }
      if (task === "emphasis") return { content: JSON.stringify({ emphasis: [wordId(index, "fifty")] }) }
      return { content: "{}" }
    },
  })
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "600000" }
  const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { env, stdio: "ignore" })
  assert.equal(await new Promise((done) => login.on("exit", done)), 0)
  await ensureHost({ env, home })
  const call = (method, path, body) => hostCall(home, method, path, body)
  try {
    const { id } = await call("POST", "/projects", { name: "Reel with music", folder })
    const take = await call("POST", `/projects/${id}/assets`, { path: source })
    const music = await call("POST", `/projects/${id}/assets`, { path: song })
    assert.equal(music.kind, "audio")
    const started = Date.now()
    const job = await call("POST", `/projects/${id}/make`, { asset: take.id, brief: { seconds: 45, music: music.id } })
    const done = await until(async () => {
      const row = (await call("GET", "/jobs")).jobs.find((j) => j.id === job.id)
      return ["done", "failed"].includes(row.status) ? row : null
    }, 270_000, "the reel with music")
    assert.equal(done.status, "done", done.error)
    const result = JSON.parse(done.output)
    const table = result.gates.map((g) => `${g.id} ${g.status}${g.message ? `: ${g.message}` : ""}`).join("\n")
    const qg06 = result.gates.find((g) => g.id === "QG-06")
    const plan = await call("GET", `/projects/${id}/plan`)
    const bed = plan.audio.items.find((i) => i.role === "music")
    console.log(`ED9 reel: verdict ${result.verdict} in ${Math.round((Date.now() - started) / 1000)} s, stop ${result.stop}; music ${bed?.fit ? bed.fit.segments.map((s) => `${(s.in / FLICKS).toFixed(2)}–${(s.out / FLICKS).toFixed(2)}`).join(", ") : "not fitted"}; QG-06 ${JSON.stringify(qg06.numbers)}\n${table}`)
    for (const gateId of ["QG-01", "QG-02", "QG-05", "QG-06", "QG-12"]) assert.equal(result.gates.find((g) => g.id === gateId)?.status, "passed", `${gateId}: ${JSON.stringify(result.gates.find((g) => g.id === gateId))}`)
    onlyExpectedNotes(result, ["QG-13"]) // the song was added with rights "unknown": a note, shown clearly
    assert.equal(result.attempts.filter((a) => a.error).length, 0, "no attempt errored")
    assert.ok(bed?.fit, `the music was fitted: ${JSON.stringify(plan.issues)}`)
    assert.ok(Math.abs(bed.fit.segments.at(-1).out / FLICKS - 80) < 0.001, "the song ends on its own ending")
    assert.ok(plan.audio.duck?.speech.length > 0, "the music ducks under the speech")
    assert.ok(qg06.numbers.speechOverMusic >= 8, `speech over music ${qg06.numbers.speechOverMusic} LU`)
    assert.ok(result.changes.some((c) => c.startsWith("Fitted the music")) && result.changes.some((c) => c.startsWith("Ducked")), JSON.stringify(result.changes))
  } finally {
    await stopHost(home)
    await fake.close?.()
  }
})
